---
title: "SQS is not a broadcast bus: fixing GraphQL subscription fan-out"
description: "How competing SQS consumers can drop the notification a GraphQL client is waiting for, and the direct-SQS design I used instead."
publishedAt: 2026-08-07
draft: false
tags:
  - GraphQL
  - AWS
  - Reliability
referenceProject:
  name: "@gdguesser/graphql-sqs-pubsub"
  url: "https://github.com/gdguesser/graphql-sqs-pubsub"
  descriptor: "an open-source npm package that ships the design described above"
---

I investigated an intermittent notification problem in a GraphQL application.
The subscription worked locally, but some clients never received the event they
were waiting for under production concurrency.

The backend used Amazon SQS as the source for GraphQL subscriptions. Every call
to `asyncIterator()` started another SQS receive loop. That looked like
fan-out—one iterator per client—but SQS gives those pollers competing-consumer
semantics instead.

## The mismatch

Suppose two users are waiting for results from the same queue:

```text
SQS queue
  ├─ poller for user A
  └─ poller for user B
```

When one message arrives, SQS returns it to one poller. It does not return a
copy to both.

GraphQL filtering happens later. If user B's poller receives user A's result,
`withFilter` rejects it for user B. If the library has already deleted the SQS
message, user A can no longer receive it.

This is easy to miss in development. One browser, one backend process, and low
message concurrency rarely create the losing interleaving. More users and
longer-lived WebSocket connections create more pollers and more chances for the
wrong one to receive an event.

The implementation had a second lifecycle problem: all iterators shared one
stop flag. Disconnecting one GraphQL client could stop polling for every other
client.

## Reproducing the loss

A deterministic reproduction made the failure clear: two subscription
iterators started two receive loops, but only one loop obtained and deleted the
message. The regression suite now covers:

- two simultaneous subscribers on one trigger;
- subscribers for different triggers;
- one subscriber disconnecting while another remains active;
- malformed messages and missing trigger attributes;
- duplicate SQS delivery;
- shutdown while a long poll is in progress.

The reproduction establishes that the design can lose a live notification. It
does not prove that every historical notification miss had this cause;
WebSocket disconnects and client state can produce similar symptoms.

## One poller, local fan-out

For a backend process connected directly to one SQS queue, the corrected shape
is:

```text
SQS queue
    │
    ▼
one process-level poller
    │
    ▼
trigger and subscriber registry
    ├─ iterator A
    ├─ iterator B
    └─ iterator C
```

The poller receives and parses each SQS message once. It reads the trigger from
the `SQSPubSubTriggerName` message attribute, finds every local listener for
that trigger, and enqueues the payload for each one.

Each subscription has its own ID. Unsubscribing removes only that ID. The poll
worker keeps running until the owning pub/sub instance is closed, and `close()`
aborts an active long poll so shutdown does not have to wait for its timeout.

A valid event with no current listeners is deleted. GraphQL subscriptions are a
live notification channel, not replay storage. Keeping that event until a
future listener appears would deliver stale results with surprising timing.

Malformed JSON or a message without its trigger attribute is different: the
poller cannot safely dispatch it, so it leaves the message undeleted. The
queue's redrive policy can then retry it and eventually move it to a dead-letter
queue.

## What deletion means

Deleting after local fan-out does not mean every browser received the event.
It means the backend accepted the message into each matching in-process
iterator.

A WebSocket can disconnect immediately afterward. A tab can close. The browser
can fail while handling the response. SQS has no acknowledgment from the
GraphQL client, so the package cannot promise end-to-end exactly-once delivery.

The useful contract is narrower:

1. SQS ingress is at least once and can duplicate or reorder events.
2. One backend process fans a valid event out to all matching local iterators.
3. WebSocket delivery remains best effort.
4. The database remains the source of truth.
5. A reconnecting client queries canonical state instead of expecting SQS
   replay.

The frontend therefore keeps a polling fallback for operations it started.
Subscription delivery provides a fast result; polling reconciles state when the
live path is interrupted.

## The watchdog was also terminal too early

The client had a 60-second watchdog around its loading notification. When that
timer expired, it closed the loading snackbar and marked the operation as
handled. Polling could later find a successful result, but the handled set
suppressed the terminal snackbar.

The timeout now means only “this is taking longer than expected.” It closes the
loading UI but does not stop polling and does not mark the operation complete.
A later subscription or polling result can still show one success or failure
notification. The handled set changes only after that terminal result.

This matters because transport and UI failures can compound. Fixing SQS fan-out
alone would still leave long-running jobs vulnerable to silent completion.

## The single-process boundary

Local fan-out solves concurrency inside one Node.js process. It does not turn
one SQS queue into a broadcast channel across multiple backend replicas.

With two replicas, SQS still sends each message to one of them. Only clients
connected to that replica can receive its local fan-out. Direct-SQS mode
therefore requires one consuming backend process, including during rolling
deployments.

A multi-replica design needs another broadcast boundary, such as one SQS queue
per replica fed by SNS, or a pub/sub system whose contract already includes
broadcast. That is a separate architecture change, not a flag that a direct-SQS
library can hide.

## Making the boundary observable

The package exposes structured observer events for receive, dispatch, delete,
publish, lifecycle, validation, and listener failures. They contain bounded
operational fields such as trigger, SQS message ID, listener count, phase, and
error category. They do not include payloads, usernames, or filenames.

On the client, completion telemetry records the operation type and source:
`subscription`, `polling`, or `watchdog`. This distinguishes a healthy live
path from successful recovery without putting user data in metrics.

The producer records the SQS message ID returned by `SendMessage`. Together,
the producer and backend signals show whether an event was published, received,
dispatched, and deleted. Client telemetry separately shows how often operations
complete through the live or fallback path without attaching user or operation
identifiers.

## The package

I published
[`@gdguesser/graphql-sqs-pubsub`](https://www.npmjs.com/package/@gdguesser/graphql-sqs-pubsub);
the [source is on GitHub](https://github.com/gdguesser/graphql-sqs-pubsub). It
uses AWS SDK v3, supports injected SQS clients, has abortable lifecycle
management, and tests fan-out and failure behavior with mocked clients and
LocalStack.

The direct-SQS limitation is part of the public API documentation. Hiding it
would make the package look easier to adopt while preserving the same class of
production bug.
