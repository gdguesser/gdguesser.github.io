---
title: "Tuple visibility in PostgreSQL: debugging with xmin, xmax, and pg_locks"
description: "Every row in PostgreSQL carries hidden versioning metadata. This is how to read it, what it means, and how to use it when queries return unexpected results."
publishedAt: 2026-08-25
draft: false
tags:
  - PostgreSQL
  - MVCC
  - Databases
---

Most PostgreSQL tuning advice starts at indexes and query plans. When a query
returns rows you did not expect—or misses rows you know exist—the problem is
usually not the plan. It is tuple visibility.

PostgreSQL stores multiple versions of every row in the same table. A query's
isolation level and the current transaction's snapshot determine which versions
are visible. When those rules produce a result that looks wrong, the fastest
diagnostic path is to inspect the versioning metadata directly.

## How a tuple is structured

Every row in a PostgreSQL table has six hidden system columns. The ones that
matter for visibility are:

- `ctid`: the physical location of the row version on disk, as `(page, offset)`.
- `xmin`: the transaction ID that created this row version.
- `xmax`: the transaction ID that deleted or locked this row. Zero if the row
  has not been deleted or locked by any transaction.

When you `INSERT` a row, PostgreSQL writes a tuple with its `xmin` set to the
inserting transaction and `xmax` set to zero. When you `DELETE` that row, the
same tuple gets its `xmax` set to the deleting transaction. A `UPDATE` is a
`DELETE` of the old tuple plus an `INSERT` of a new one.

Conceptually:

```text
INSERT  →  new tuple:  xmin=current_tx, xmax=0
UPDATE  →  old tuple:  xmax=current_tx
          new tuple:  xmin=current_tx, xmax=0
DELETE  →  old tuple:  xmax=current_tx
```

The old tuple does not disappear when it is deleted. It stays in the table with
its `xmax` set, waiting until no active transaction can see it. That is what
makes MVCC work: writers do not block readers, and readers do not block writers,
because they may be looking at different versions of the same logical row.

## Visibility rules

A transaction can see a tuple if:

1. `xmin` is committed, and the tuple's `xmin` is visible to this transaction's
   snapshot.
2. `xmax` is zero (the row has not been deleted) or `xmax` is not yet committed,
   or `xmax` is not visible to this transaction's snapshot.

The visibility of `xmin` and `xmax` depends on the isolation level:

- **Read committed**: a new snapshot is taken at each statement. A tuple is
  visible if its `xmin` was committed before the statement started.
- **Repeatable read** and **serializable**: the snapshot is taken at the first
  statement in the transaction. A tuple is visible if its `xmin` was committed
  before that snapshot, regardless of when individual statements execute.

This is why the same query can return different results in the same transaction
under read committed. Each statement sees the latest committed state at the time
it begins, not the state when the transaction began.

## Inspecting tuple versions

To see the versioning metadata for a table, query the system columns directly:

```text
SELECT ctid, xmin, xmax, id, name
FROM users
WHERE id = 42;
```

The `ctid` tells you where the tuple physically lives. If you see two rows for
the same logical record with different `ctid` values, you are looking at two
versions: a live version and a dead one that has not yet been vacuumed.

To check whether a transaction ID is committed, use the `txid_status()` function
(available in PostgreSQL 9.6+):

```text
SELECT txid_status(xmin), txid_status(xmax)
FROM users
WHERE id = 42;
```

This returns `in progress`, `committed`, or `aborted`. An `aborted` xmin means
the inserting transaction rolled back—the tuple should not be visible to any
transaction. An `aborted` xmax means the deleting transaction rolled back—the
tuple is still live.

## Scenario: phantom rows that should not exist

You run a `SELECT` inside a repeatable-read transaction and see a row. You run
it again moments later and the row is gone, or vice versa. This looks like a
phantom read—but repeatable read prevents phantom reads. What happened?

The cause is usually that the first statement took its snapshot before a
concurrent transaction committed. The second statement, if running under read
committed, takes a new snapshot and sees the committed change.

To confirm, open two sessions. In session one:

```text
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT * FROM users WHERE active = true;
```

In session two, while session one is still open:

```text
BEGIN;
UPDATE users SET active = false WHERE id = 10;
COMMIT;
```

Back in session one:

```text
SELECT * FROM users WHERE active = true;
```

Under repeatable read, the second `SELECT` still sees the row as active because
the snapshot was locked at the first statement. But if session one is running
under read committed, the second `SELECT` sees the row as inactive because each
statement takes its own snapshot. The `UPDATE` committed between the two
statements, and the second snapshot sees it.

The row was always there. The question is which snapshot you are looking at.

## Scenario: read-your-own-writes fails

You `UPDATE` a row and then `SELECT` it in the same transaction. The `SELECT`
returns the old value.

```text
BEGIN;
UPDATE users SET name = 'Alice' WHERE id = 1;
SELECT name FROM users WHERE id = 1;
-- returns 'Alice' or the old name?
```

Under read committed, this usually works because the `UPDATE` creates a new
tuple visible to the subsequent `SELECT` (the new tuple's `xmin` is your
transaction, which is committed to itself).

But the behavior changes when the `UPDATE` is part of a more complex plan. If
the query planner uses a nested loop that reads the index before the update is
applied, or if a CTE or subquery captures a snapshot before the update executes,
the read can return stale data.

Under repeatable read, the first statement's snapshot is reused, so a `SELECT`
that appears after an `UPDATE` can still see the pre-update version. The `UPDATE`
modified the row, but the snapshot from the first statement does not see it.

The reliable way to read your own writes is to use `RETURNING` on the `UPDATE`:

```text
UPDATE users SET name = 'Alice' WHERE id = 1
RETURNING name;
```

This avoids the visibility question entirely because the `UPDATE` returns the
modified row directly, without a separate read.

## Scenario: xmin is stuck in "in progress"

You query `txid_status(xmin)` on a row and it returns `in progress`. The row's
creating transaction appears to still be running, but the application reports no
active query.

This happens when a client disconnects without committing or rolling back the
transaction. PostgreSQL does not automatically clean up abandoned transactions.
The server process may have exited, but the transaction metadata remains until
the server detects the broken connection.

To confirm, check `pg_stat_activity`:

```text
SELECT pid, state, xact_start, query
FROM pg_stat_activity
WHERE datname = current_database();
```

Look for transactions with `state` as `idle in transaction` and a start time
that is significantly in the past. Those are candidates. The `xmin` on the
stuck row will match the transaction ID of one of these abandoned sessions.

The fix is to terminate the idle transaction:

```text
SELECT pg_terminate_backend(<pid>);
```

After termination, the transaction's `xmin` transitions to `aborted` status,
and the tuple becomes invisible to all transactions. Autovacuum will eventually
clean it up.

## Scenario: xmax is locked, not deleted

You see a row with a non-zero `xmax`. You check `txid_status(xmax)` and it
returns `in progress`. But no one is deleting the row.

A non-zero `xmax` does not always mean a delete. It also means the row is
currently locked by a `SELECT FOR UPDATE`, `SELECT FOR SHARE`, or an `UPDATE` in
another transaction. The `xmax` records the transaction that holds the lock.

To distinguish between a lock and a delete, check `pg_locks`:

```text
SELECT l.pid, l.mode, l.granted, a.query
FROM pg_locks l
JOIN pg_stat_activity a ON l.pid = a.pid
WHERE l.relation = 'users'::regclass
  AND l.pid != pg_backend_pid();
```

If the lock mode is `RowExclusive`, someone is updating the row. If it is
`ShareRowExclusive`, someone has taken a `FOR UPDATE` lock. Once the holding
transaction commits or rolls back, the `xmax` resets to zero (for locks) or
persists as committed (for deletes).

## Diagnostic: what is blocking what

When transactions are waiting on each other, `pg_locks` shows the blocking
chain. This query joins blocked transactions to their blockers:

```text
SELECT
  blocked.pid       AS blocked_pid,
  blocked.query     AS blocked_query,
  blocking.pid      AS blocking_pid,
  blocking.query    AS blocking_query,
  lock.mode         AS lock_mode
FROM pg_locks AS lock
JOIN pg_stat_activity AS blocked
  ON lock.pid = blocked.pid
  AND NOT lock.granted
JOIN pg_stat_activity AS blocking
  ON lock.relation = blocking.relation
  AND blocking.pid != blocked.pid
WHERE lock.relation IS NOT NULL;
```

This shows you which transaction is holding a lock that another transaction is
waiting for. The `blocked_query` is the statement that cannot proceed. The
`blocking_query` is the statement holding the conflicting lock.

Follow the chain: transaction A blocks B, B blocks C. The root blocker is
usually the oldest transaction in the chain, and terminating it resolves the
cascade.

## Dead tuples and table bloat

When a row is updated or deleted, the old tuple remains in the table. It is no
longer visible to any new transaction, but it physically occupies disk space.
These are dead tuples.

Autovacuum removes dead tuples periodically. When autovacuum is slow or
overwhelmed, dead tuples accumulate and the table grows. This is table bloat:
the table's on-disk size is larger than the live data it contains.

To check dead tuple count:

```text
SELECT
  relname,
  n_live_tup,
  n_dead_tup,
  last_autovacuum,
  last_vacuum
FROM pg_stat_user_tables
WHERE relname = 'users';
```

A high `n_dead_tup` relative to `n_live_tup` means autovacuum is not keeping
up. The `last_autovacuum` timestamp shows when it last ran. If it has never run
(`NULL`), the table has never been vacuumed since it was created.

Dead tuples affect more than disk space. A sequential scan must visit every tuple,
including dead ones, making scans progressively slower as bloat grows. Index
scans are also affected: each index entry points to a heap tuple, and the scan
must check whether the tuple is still visible, visiting dead tuples before
skipping them.

## The xmin horizon and vacuum

Autovacuum cannot remove dead tuples if any transaction might still need to see
them. A tuple's `xmin` is visible to any transaction whose snapshot predates the
`xmin`'s commit. Autovacuum must wait until all transactions with older snapshots
have finished before it can safely remove the tuple.

The oldest snapshot still in use is the xmin horizon. Long-running transactions
push the horizon back, preventing vacuum from cleaning up tuples that are
logically dead but still needed by the horizon.

To check the horizon:

```text
SELECT
  pid,
  xact_start,
  age(backend_xid) AS xact_age,
  query
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL
ORDER BY xact_start ASC;
```

The oldest `xact_start` is roughly where the horizon sits. A transaction that
has been running for hours is holding back vacuum across every table in the
database. This is one of the most common causes of table bloat in production
PostgreSQL.

In managed environments like Aurora or Cloud SQL, replication lag is also
affected by the xmin horizon. Logical replication subscribers need to see tuples
that the publisher has not yet vacuumed. A long-running transaction on the
publisher increases the replication slot's xmin, which increases disk usage as
dead tuples accumulate.

## Diagnostic checklist

When a query returns unexpected rows or misses expected ones:

1. **Check the isolation level.** Is it read committed, repeatable read, or
   serializable? Each has different snapshot semantics.

2. **Check for long-running transactions.** A stale transaction can hold back
   vacuum and extend visibility of dead tuples. Query
   `pg_stat_activity` for `xact_start`.

3. **Check `pg_locks` for blocking.** A locked row has a non-zero `xmax`. Join
   `pg_locks` with `pg_stat_activity` to find the blocker.

4. **Inspect tuple versions directly.** `SELECT ctid, xmin, xmax` from the
   table. Look for multiple versions of the same logical row.

5. **Check dead tuple counts.** `pg_stat_user_tables` shows `n_dead_tup`. High
   dead tuples relative to live tuples means autovacuum is behind.

6. **Verify `txid_status()`.** The `xmin` or `xmax` on a tuple might be
   `aborted` (rolled back), which changes visibility.

7. **Consider the query plan.** `EXPLAIN (ANALYZE, BUFFERS)` shows whether the
   planner chose a path that reads index entries before or after a concurrent
   update is applied.

## Prevention

The best debugging is avoiding the problem in the first place.

**Choose the right isolation level.** Read committed is the default and works for
most workloads. Repeatable read and serializable add snapshot pinning, which
increases the xmin horizon and can slow vacuum. Only use stricter isolation when
the workload has real consistency requirements.

**Tune autovacuum aggressively.** The default thresholds are conservative. For
high-update tables, increase `autovacuum_vacuum_scale_factor` and
`autovacuum_analyze_scale_factor`, and decrease
`autovacuum_vacuum_cost_delay`. Managed PostgreSQL services sometimes override
these defaults.

**Set `idle_in_transaction_session_timeout`.** This terminates sessions that sit
idle inside a transaction, preventing xmin horizon drift from abandoned clients:

```text
ALTER SYSTEM SET idle_in_transaction_session_timeout = '30s';
SELECT pg_reload_conf();
```

**Use `RETURNING` instead of separate reads.** When you update a row and need the
result, use `RETURNING` to avoid the visibility question entirely.

**Set connection pool defaults carefully.** A pooled connection that previously
ran a long transaction may have session-level settings or advisory locks that
affect subsequent users. Reset session state at checkout time:

```text
SET SESSION characteristics AS TRANSACTION ISOLATION LEVEL READ COMMITTED;
SET statement_timeout = 0;
SET lock_timeout = 5000;
```

**Monitor dead tuples.** Alert on `n_dead_tup` relative to `n_live_tup` and on
`last_autovacuum` age. A dead-tuple count that grows monotonically means
autovacuum is permanently behind.

Tuple visibility is the mechanism that makes PostgreSQL concurrent by default.
When it produces a surprising result, the system is almost always behaving
correctly. The work is in understanding which snapshot you are looking at.
