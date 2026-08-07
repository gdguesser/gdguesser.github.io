---
title: "Reliable webhook delivery: designing for the failures between systems"
description: "Notes from building Webhook Relay: transactional outboxes, at-least-once delivery, idempotency, retries, dead letters, replay, and request signing."
publishedAt: 2026-08-06
draft: false
tags:
  - Reliability
  - Event-driven systems
  - Kotlin
referenceProject:
  name: "Webhook Relay"
  url: "https://github.com/gdguesser/webhook-relay"
  descriptor: "an open-source Kotlin and Spring Boot reference implementation"
---

I built [Webhook Relay](https://github.com/gdguesser/webhook-relay) because
“send an HTTP request” hides most of the interesting work in webhook delivery.
The project had to answer three questions:

1. Did the system durably accept the event?
2. Will every intended destination eventually be attempted?
3. Can an operator understand and safely recover what did not succeed?

The repository is small enough to follow from the API to the worker. This is how
I handled those boundaries and where the implementation still stops short of a
production service.

## Start with a precise acceptance boundary

Suppose an API receives an event and needs to do two things:

- insert the event and its delivery state in PostgreSQL;
- publish a message to Kafka so a worker can send the webhook.

Doing those operations one after the other creates a dual-write problem. If the
database commit succeeds and the publish fails, the event is stored but never
dispatched. If the publish succeeds and the transaction rolls back, a worker
can observe work whose source record does not exist. Reversing the order merely
reverses the failure.

A distributed transaction across PostgreSQL and Kafka could coordinate the
resources, but it adds operational and coupling costs that are usually
unnecessary for this shape of system. The transaction outbox pattern gives the
API one local, durable boundary instead.

Within a single PostgreSQL transaction, the API writes:

- the accepted event;
- the delivery record for its endpoint;
- an outbox row describing the dispatch to publish.

Only after all three writes commit does the API report acceptance. A separate
publisher reads unpublished outbox rows and sends them to the broker. The
database commit—not an in-memory queue and not a hopeful future publish—is the
acceptance boundary.

Conceptually:

```text
BEGIN
  INSERT event
  INSERT delivery
  INSERT outbox_message
COMMIT
```

If the process dies before `COMMIT`, none of the work exists. If it dies after
`COMMIT`, the outbox row remains available for another publisher pass. This
closes the lost-work gap, but it does not make publishing exactly once.

## Why the contract is at least once

An outbox publisher normally performs two independent actions:

1. publish the outbox message;
2. mark its row as published.

If it publishes successfully and crashes before the mark is committed, the row
still looks unpublished. On recovery, the publisher sends it again. The same
ambiguity appears at the HTTP boundary: a receiver may process a webhook and
return `200`, while the worker times out or crashes before recording success.
Retrying is safer than silently losing the delivery, but it can produce a
duplicate.

That is why the useful contract is **at least once**. The relay works to avoid
loss, accepts that duplication is possible, and gives participants stable
identities with which to handle it.

“Exactly once” is often an imprecise label for “deduplicated within a particular
boundary.” A database can enforce a unique key exactly once in one transaction.
It cannot prove that arbitrary side effects behind an HTTP endpoint happened
exactly once when the acknowledgment is lost. Naming the actual boundary is
more valuable than applying the stronger label to the whole path.

## Idempotency at ingestion and delivery

There are two different duplicate problems here.

### Duplicate ingestion

A producer may retry the event-creation request because it did not receive the
API response. The reference project requires an endpoint-scoped
`Idempotency-Key`. Repeating a request with the same key returns the original
event and delivery instead of creating more work.

The database, rather than an application-level “check then insert,” must enforce
the uniqueness. Concurrent requests can both pass a check before either writes.
A unique constraint turns the race into a deterministic outcome.

An ingestion key also needs a defined scope and policy. Is it unique per
endpoint, account, or entire service? How long is it retained? What happens if a
caller reuses the key with a different payload? The reference implementation
uses endpoint scope, but a production API should document all of these choices.

### Duplicate delivery

The receiver can still see the same accepted delivery more than once. Each HTTP
attempt therefore carries a stable `X-Webhook-Id`. A receiver should store that
identifier with the business effect in one local transaction:

```text
BEGIN
  INSERT processed_webhook(webhook_id)  -- unique
  APPLY business change
COMMIT
```

If inserting the identifier conflicts, the receiver knows it has already
committed that effect and can return success. The exact storage mechanism may
be a relational constraint, an idempotent state transition, or a domain key.
What matters is that checking and applying the effect cannot race.

An in-memory cache is not a durable deduplication boundary. A separate
“processed” write made before or after the business transaction recreates a
dual-write problem at the receiver.

## Worker claims and leases

Multiple workers should be able to process deliveries without routinely
colliding. The project uses a database lease and a processing token when a
worker claims a delivery.

A lease prevents another worker from immediately taking the same work. It must
expire, because a permanent lock owned by a dead worker would strand the
delivery. After expiry, another worker can recover it. The processing token
then prevents the original, slow worker from overwriting the result recorded by
the newer owner.

This arrangement has an important consequence: a lease is coordination, not an
exactly-once guarantee. If a request takes longer than the lease or the worker
loses connectivity after sending, another attempt may still occur. Receivers
must remain idempotent.

Lease duration should be longer than the expected request deadline with room
for scheduling delay, while still short enough to recover abandoned work. The
system should expose lease-expiry and stale-result metrics; otherwise a tuning
problem looks like random duplication.

## Deciding what to retry

Retries are useful when another attempt has a reasonable chance of changing the
outcome. Retrying every non-`2xx` response wastes capacity and delays operator
attention.

The reference worker treats these outcomes as retryable:

- HTTP `408`, `425`, `429`, and `5xx`;
- connection and request timeouts;
- I/O failures.

Other non-`2xx` responses, including redirects, become terminal immediately.
That policy is intentionally conservative. Redirects can also undermine the
original destination validation unless every hop is validated.

The classification is a product contract, not a universal truth. Some receivers
use `409` for a transient ordering conflict; others use it for a permanent
duplicate. A mature service may allow carefully bounded policy overrides, but a
small and documented default is safer than hidden heuristics.

### Exponential delay with full jitter

Immediate retries synchronize failing workers and add load to the dependency
that is already struggling. Exponential backoff increases the delay as
failures continue:

```text
limit = min(max_delay, base_delay * 2^attempt)
delay = random(0, limit)
```

The random choice is full jitter. It spreads attempts across the available
window instead of producing a new coordinated wave at each exponential
boundary. Both the exponential growth and the maximum delay must be capped.

Retries also need a finite attempt budget. The project defaults to eight
attempts and then dead-letters the delivery. An infinite retry loop is not
reliability; it is an unbounded queue of work that may never succeed.

The worker currently ignores `Retry-After`. I would handle a valid
server-provided delay in a production version, clamp it to an acceptable range,
and still enforce the overall retention and attempt limits.

## What goes into a dead letter

After the retry budget is exhausted—or after an immediately terminal
response—the system needs to retain more than a log line. A dead-letter record
should answer:

- which event and endpoint failed;
- when and how many times it was attempted;
- the last outcome and a safe diagnostic summary;
- whether it has already been replayed or resolved;
- which correlation identifiers connect it to logs and traces.

Dead letters make failure inspectable and recoverable, but the table itself is
not an operating model. Someone still needs ownership, alerts, retention, and a
way to distinguish a receiver outage from invalid payloads or configuration.

Storing full response bodies can leak secrets or personal data. Prefer bounded,
redacted diagnostics and explicit retention. Payloads, outbox rows, and dead
letters all need cleanup or archival policies; the reference project calls out
that these policies are not automated.

## Replaying a failed delivery

Once an endpoint is repaired, an operator may want to replay a failed delivery.
A safe replay should be explicit, auditable, and idempotent as an operation.

In the reference implementation, replay:

- keeps the original delivery ID and payload;
- resets the attempt budget;
- records replay metadata;
- creates a fresh outbox dispatch.

Keeping the delivery ID preserves the receiver’s deduplication key. That is
usually the safest default: if the receiver committed the effect but the relay
recorded a failure, replay should not apply the effect again.

Replay does not guarantee a different result. A permanently invalid payload
will fail again. Bulk replay can overload a recovered receiver, so production
systems need rate controls, authorization, progress reporting, and the ability
to stop a replay campaign. The public project exposes replay APIs but does not
include API authentication, authorization, tenant isolation, quotas, or rate
limiting. Those are prerequisites before placing such operations in a shared
environment.

## Signing the request body

Transport encryption protects a request in transit, but a receiver may also
need to verify that the request came from a holder of the endpoint secret and
was not modified.

The project sends:

- `X-Webhook-Timestamp`: Unix seconds;
- `X-Webhook-Signature`: `v1=<hex HMAC-SHA256>`;
- the stable webhook and event IDs;
- an attempt number and correlation ID.

The signed message is:

```text
<timestamp>.<exact HTTP request body>
```

“Exact” matters. Signing a parsed object and then serializing it again at the
receiver can change whitespace, key order, or number representation. Verify the
raw received bytes using a constant-time comparison.

The timestamp lets a receiver reject old requests outside an allowed clock-skew
window, reducing replay risk. It does not replace webhook-ID deduplication: an
attacker may replay a valid request inside that window, and a legitimate relay
retry will have a new timestamp.

Secret handling is a lifecycle, not only an HMAC function. A production design
needs secure initial delivery, rotation with an overlap period, revocation,
audit events, and an external key-management strategy. The reference project
encrypts endpoint secrets with AES-GCM, but does not implement master-key
rotation or external KMS integration.

## Metrics and logs

Request counts and process CPU are useful, but they do not answer whether the
delivery pipeline is healthy. Observe the state machine.

Useful metrics include:

- accepted events and duplicate-ingestion outcomes;
- unpublished outbox age, publish success, and publish failures;
- delivery outcomes and HTTP duration by bounded status class;
- retry scheduling, attempts exhausted, and dead letters created;
- lease expiry and stale processing-token results;
- replay requests and replay outcomes.

Avoid labels such as endpoint URLs, event IDs, or correlation IDs in metrics;
their cardinality grows without bound. Put those identifiers in structured logs
and traces instead. The reference applications emit structured logs and include
correlation and delivery IDs where available, while Prometheus metrics carry
bounded dimensions.

The most revealing queue signal is often **age**, not count. Ten new messages
may be healthy; one message that has been unpublished for an hour is not.
Alerting should connect user impact to a time window—for example, delivery
latency or terminal-failure rate—rather than page on every individual retry.

Health endpoints also need careful semantics. A liveness check should answer
whether the process needs restarting. A readiness check can answer whether it
can currently serve work. Marking a process dead because a dependency is
temporarily unavailable can create restart loops precisely when the dependency
needs less load.

## Tests around failure boundaries

The happy path is easy to demonstrate. Reliability comes from tests around
transaction and crash boundaries.

High-value cases include:

- duplicate ingestion returns the original records;
- rolling back event creation also removes its outbox work;
- a publish repeated after an uncertain mark does not corrupt delivery state;
- a stale worker token cannot overwrite a newer result;
- retry delay stays within the exponential full-jitter bound;
- signatures are deterministic and verified over exact bytes;
- transient receiver failures eventually succeed;
- exhausted retries persist a dead letter;
- replay records its metadata and creates another dispatch;
- URL policy rejects private or reserved destinations.

The project uses PostgreSQL Testcontainers for persistence behavior and
WireMock for receiver, signature, and transient-failure scenarios. These tests
cover more than mocked units, but I have not run load or fault-injection tests.

## What this project does not cover

The repository does not include:

- no API authentication, authorization, tenant isolation, quotas, or rate limits;
- no automated payload, outbox, or dead-letter cleanup;
- no secret-key rotation or external KMS integration;
- no DNS-rebinding-resistant connection pinning;
- no `Retry-After` support;
- local Kafka and PostgreSQL transport omit TLS and authentication;
- a single PostgreSQL region and single local Redpanda node are not a
  high-availability topology;
- no load testing and no throughput or latency claims.

There are other choices a production team would still need to make: ordering,
endpoint versioning, payload evolution, regional failover, privacy deletion,
backpressure, per-tenant fairness, and incident ownership.

## The resulting contract

The contract I settled on is:

1. Acceptance means the event and dispatch intent were committed together.
2. Delivery is at least once, so receivers get a stable deduplication key.
3. Retries are classified, jittered, capped, and finite.
4. Terminal failures become durable, inspectable dead letters.
5. Replay preserves identity and leaves an audit trail.
6. Requests are signed over exact bytes and checked within a time window.
7. Metrics describe backlog age and state transitions; logs carry identifiers.
8. Limitations and missing controls are documented plainly.

This does not remove failure or duplicates. It gives the sender, receiver, and
operator clear behavior when they happen.
