# [M] net: coalesce dynamic tracks and preserve sequences across replacements

## Goal

A broadcast has one logical dynamic track per name in both languages: at most
one pending or live producer, one on-demand request that every subscriber fans
out from, and a group and datagram sequence namespace that survives the
producer being replaced. Behavior only, so it ships on main.

## Plan

Dynamic tracks should have one logical identity per broadcast and track name,
but the Rust and JavaScript models violate different parts of that invariant.

### Rust resets sequences when a dynamic producer is replaced

Rust already coalesces: `broadcast::Consumer::track` joins a queued request or
a live cached track, so one name has one pending or live producer. What it
loses is the sequence namespace. A closed track is dropped from the
broadcast's weak cache, the next lookup builds a fresh `track::Request`
(`rs/moq-net/src/model/track.rs`) with a fresh `TrackState`, and with
`max_sequence` empty both `append_group` and `append_datagram` restart at 0.

Copy-based resume (#4741) still stalls on that. When the serving copy dies
after delivering, the front (`rs/moq-net/src/model/front.rs`) re-queries the
same source and splices a new copy. Each reader (`resume.rs`) subscribes to it
with its newest handed-out group as the start floor and skips sequences it
already delivered, so a replacement's groups below that floor never arrive:
the reader stalls until the replacement's counter passes the old edge. Verified
by a `route_change.rs` case that aborts a dynamic producer behind a relay and
appends from the replacement: every version hangs. Explicit group or datagram
writes that raised the old producer's edge lengthen the stall.

[Broadcast epochs](/quest/m0/broadcast-epoch/README.md) cover a restarted
publisher; this quest covers one dynamic track replaced inside a live
broadcast.

### JavaScript permits concurrent same-name dynamic producers

`BroadcastProducer.subscribe()` calls the internal `subscribe` with
`register = false` (`js/net/src/broadcast.ts`). Multiple publishing-side
subscriptions for the same name therefore enqueue independent requests and
create independent `track.Producer` instances.

#2953 made those concurrent producers share a sequence allocator. That
prevents duplicate sequence allocation, but concurrent producers are the wrong
model. Publishing-side subscriptions should coalesce like
`BroadcastConsumer.subscribe()` and Rust's `broadcast::Consumer::track`: one
pending or live producer per broadcast and name, one on-demand request, and
multiple subscribers fanning out from it.

### Desired behavior

- A broadcast has at most one pending or live dynamic track producer per track
  name.
- Concurrent JavaScript publishing-side subscriptions for the same name emit
  one request and share its accepted producer.
- Subscription options from all subscribers remain aggregated on that request.
  `track::Request` already does this in Rust: it carries `prev_subscription`
  and re-combines the aggregate whenever a subscriber changes.
- After that producer closes, a later request creates a new producer but
  continues the group and datagram sequence namespace for that broadcast and
  name.
- Explicit group and datagram writes advance the shared allocator.
- A new broadcast generation starts each track at sequence 0.
- Rust and JavaScript expose the same lifecycle and sequencing behavior.

The sequence allocator is shared across producer incarnations without sharing
the closed producer's cache or terminal state.

### Regression coverage

- JavaScript: two `BroadcastProducer.subscribe()` calls for one name produce
  one request and both subscribers receive from the accepted producer.
- JavaScript: remove or replace #2953's concurrent-producer test, since
  concurrent same-name producers should not be representable.
- Rust and JavaScript: close a dynamic producer after group and datagram
  sequences have advanced, re-request the same name, and verify the
  replacement appends at the next sequence.
- Rust relay model: extend the route-change tests above so a replacement
  produced with `append_group()` is delivered immediately rather than skipped
  until catch-up.
- Both implementations: verify a separate broadcast generation starts at 0.

## Closes

- [#2991](https://github.com/moq-dev/moq/issues/2991) - close this issue when the quest finishes
