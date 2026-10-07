## Problem

`Frame` carries `payload` + `timestamp` and nothing else, so an object's wire identity — subgroup ID, Object ID, properties, status — has nowhere to land. The IETF receive path consistently narrows to that model, as #4926 describes: subgroups above 0 throw, an Object ID gap throws, and every object property but `Timestamp` is discarded.

Two consequences beyond the ones in #4926:

- **The two halves already disagree.** `ietf/publisher.ts:664` writes `firstObject: slice.skip === 0`, so serving a trimmed head emits `FIRST_OBJECT` clear — which `ietf/subscriber.ts` then dropped outright (`a group must start at object 0`). This repo's own publisher can emit a stream this repo's own subscriber discards.
- **The model is not the only place identity is lost.** Even with `Frame` widened, five sites between the decoder and a consumer rebuild the frame as a literal of named fields. Widening a type is invisible at those sites.

This is the JS half of #4926, offered as a concrete shape to react to rather than a finished proposal. The Rust half is not in this PR.

## Approach

Add an **optional** `object?: ObjectInfo` to `Frame`. Optional is what keeps the blast radius at three source files instead of every `Frame` construction in the workspace: the moq-lite path neither sets nor reads it, and nothing is required to produce one.

Receive-side only. No encoder changed; the publisher emits byte-identical bytes.

The properties block is carried both verbatim and parsed. The parse keeps **both parities** and special-cases **no codepoint**, so a registry addition needs no change here.

Group completion becomes something the publisher states rather than something inferred from stream count: a header with `hasEnd` means that stream's FIN ends the group, and a subgroup stream without it ends the group with an explicit `END_OF_GROUP` (status `0x03`). Ending on every subgroup EOF would truncate a group at whichever stream finished first.

## Impact

Public API, all additive:

- `Frame` gains optional `object?: ObjectInfo` (`js/net/src/group.ts`).
- New exported `ObjectInfo` (`subgroup`, `id`, `status`, `properties`, `propertyList`) and `ObjectProperty` (`type`, `value` | `bytes`).
- `Group.Consumer.readFrameSequence` / `tryReadFrameSequence` and `Track`'s `Ordered.readFrame` now carry `object` through. These rebuild the frame as a literal, so each needed the field named explicitly.

Receive behaviour, previously an error or a drop:

- A subgroup above 0 is delivered instead of throwing `subgroups are not supported`. A group's subgroup streams share one producer.
- A group ends on its terminal object (`hasEnd` FIN or `END_OF_GROUP`), not on the first subgroup stream's EOF.
- A header with `FIRST_OBJECT` clear is delivered from its true first Object ID instead of being dropped. A header that *claims* `FIRST_OBJECT` and then starts at a non-zero object is still a contradiction and is still refused — `a group that claims its first object must start at zero` passes unchanged.
- An Object ID gap is delivered with the ids intact instead of throwing. The frame's position in the group is no longer its Object ID once there is a gap, which is why the id has to travel with the frame.
- An unrecognised object property reaches the consumer instead of being discarded. A track that declares no timescale now keeps its properties rather than having the block skipped.

Wire format: unchanged.

## Alternatives

Against the four shapes in #4926, this is 1 and 2 together: the properties blob **and** object identity, in the model. 1 alone leaves the subgroup and Object ID drops in place, which is where the AL-FEC mapping actually breaks. 3 (relay-only passthrough) does not help a JS consumer that wants to read the objects. 4 is a reasonable answer and we would plan around it.

Within this shape, the judgement most worth pushing back on is making `object` optional on the shared `Frame` rather than giving the IETF path its own frame type. Optional keeps one type and one read path for both wires at the cost of a field a moq-lite consumer never sees populated. A separate type avoids that but duplicates every read.

Group completion keyed on `hasEnd` rather than on a subgroup-stream refcount is the other one. Refcounting cannot tell a finished group from a group whose other subgroups have not opened yet.

## Follow-ups

- The publisher has no way to emit any of this: every emit site writes `subGroupId: 0`, and the re-emit paths (`ietf/publisher.ts:695`, `:848`) rebuild a `Frame` from `payload` + `timestamp`, so a relay would still flatten what it now receives. Egress is deliberately out of this PR — it is only worth building against whichever shape you would accept.
- The Rust half (`rs/moq-net`, `moq-relay` forwarding) mirrors this, including the group-completion rule.
- #4926's observation 2 — the non-contiguous-ID drop returning `Ok(())` on the Rust side — stands on its own whatever happens to this PR.

## Testing

`just check` passes locally. `js/net`: 1243 pass, 0 fail.

Each receive-behaviour change above is asserted on received objects — ids, subgroups, payload bytes, property blocks — never on the absence of an error. The two tests added for the rebuild sites were each confirmed red without their one-line fix, since a test taken at `Group.readFrame` passes on a patch that only widens the type: that read returns the stored object, so an extra field survives it structurally while every sequence read drops it.
