# Broadcast epochs

## Goal

A path, with its `@epoch`, is the only content identity, and no first-party
publisher reuses one for different content. With #4741, any route covering a
path resumes its subscriptions from the first frame the subscriber lacks,
whoever serves it. So epochs are a correctness requirement: a publisher that
restarts its group numbering at 0 under an un-epoched name, while its old
route lingers, is resumed into the old broadcast and stalls viewers until its
sequence catches up.

Each first-party publish of `demo/BBB.hang` goes out as
`demo/BBB.hang/@<uuidv7>`, so a restart is a new broadcast. A smart viewer
switches to the newest epoch as soon as it is announced, and a bare-name viewer
binds to the newest when it subscribes. Moving to
a new epoch is a clean boundary (a fresh catalog and tracks, never resumed
across), and each run stays addressable by its full path.

The epoch rides in the path, so it survives any moq-transport relay, and no
wire message changes. At an epoch-aware relay, a request for a bare name
resolves to its newest live epoch on every protocol version.

Non-goals: pooling, which needs nothing here, since every publisher of one
path is already one source; a redundant pair shares an explicit epoch through
[`--hop` removal](/quest/m0/broadcast-epoch/hop-removal.md). Also out of
scope: trusting the publisher's clock (a far-future epoch wins until its
route goes away).

## Plan

Decided:

- This line gates the next release (decided 2026-10-03: #4741 can merge to
  main, but without epochs every restarting first-party publisher stalls its
  viewers).
- The marker is a child segment `@<uuidv7>`, parsed into
  `Option<Epoch>` by [the shared primitive](/doc/concept/moq-lite.md#publisher-epochs). Not a lite-07 flag:
  the path is the only carrier.
- Publishing does not mint an epoch by default; the path is published as
  given (decided 2026-10-04 by the maintainer, replacing "mint unless the path
  already carries one"). Minting is one call: `Path::mint_epoch` in Rust and
  `Path.mintEpoch` in TypeScript append a fresh `@<uuidv7>`. Each first-party
  publisher calls it once per run; a redundant pair passes a shared epoch.
- Smart subscribers use epochs natively (decided 2026-10-05 in #4817): they
  watch the announcements below a name, request each epoch by its full path,
  and treat a new epoch as a discontinuity (a fresh decoder). Dumb subscribers
  use bare names and are sticky.
- A bare request binds once, when made, to the newest epoch with a live route,
  ahead of any route covering the name (a fully qualified epoch wins). With no
  epoch it goes through the covering route, such as an on-demand transcode
  claim, which never announces its output. The binding never moves: a newer
  epoch is a different broadcast, and the request ends with the epoch it bound
  to. In TypeScript the long-lived request's `active` swaps to the newer epoch
  as a new broadcast.
- Only an epoch names one origin, so only an epoch path resumes across routes.
  A path without an epoch stays on the route that first served it and ends
  when that route goes; it is never stitched (decided 2026-10-05). Two
  unrelated epochs are never stitched either.
- A grant that admits a name admits its epochs (a `name/@*` sibling); a grant
  on one epoch reaches only that epoch. The sibling admits any single `@`
  segment, not only UUIDv7 text, since a pattern cannot spell one (decided
  2026-10-05: accepted and documented).
- An epoch only ever ends a path (decided 2026-10-05). Publishing
  `name/@e/more` fails with `MisplacedEpoch`, and `with_epoch`
  (`Path.withEpoch` in TypeScript) replaces a final epoch rather than stacking
  one, with `None` removing it.
- A catalog `broadcast` reference is bare by default (decided 2026-10-05 in
  #4817): it resolves against the catalog's name past its final epoch, so a
  bare and a pinned fetch agree, and binds to the target's newest epoch when
  requested unless it spells one. A transcoder pins its source by writing `./source/@<epoch>`.
- An unmodified third-party relay routes `foo/@<epoch>` but never resolves a
  bare `foo`, since a route covers its descendants, not its parent. A
  bare-name viewer behind one needs a publisher that publishes the bare name.
  Document this rather than promise it works.
- Publishers such as moq-boy and moq-room mint their epoch at publish.
  moq-stats mints its own through
  [Stats epochs](/quest/m0/broadcast-epoch/stats-epoch.md), which also gates the release
  (decided 2026-10-04): a restarted stats node under a reused name stalls its
  viewers the same way.
- [Retracted demand release](/quest/m0/broadcast-epoch/unannounce-demand-release.md) also
  gates the release (decided 2026-10-05): a regression from #4741 on main that
  `release` lacks.
- Decided in the 2026-10-05 audit: the m1 quests gating this line (stats
  epochs, the bounded stats aggregate it requires, and retracted demand
  release) moved under it, and the OBS half of GStreamer and OBS moved to m1
  as [OBS publishes under epochs](/quest/m1/obs-epoch.md), so the release
  gate no longer waits on m1 work.
- Derived output served on demand through a claim stays bare and sticky per
  relay (decided 2026-10-05): a worker dying costs its subscribers one reset
  and a cold start on the next claimant, never a splice. Whether that removes
  the [wildcard](/quest/m0/wildcard/README.md) line's mirrored-epoch and
  group-start requirements is the wildcard line's call.

This README owns:

- An end-to-end relay test: republish a name while the old publisher's session
  stays open. A new-API viewer following announcements reaches the new epoch
  within one RTT-scale bound rather than the idle timeout, and a lite-06 or
  IETF bare-path viewer that resubscribes binds to it.
- A `doc/concept` page on broadcast naming: what an epoch is, publish and
  consume behavior, smart and sticky subscribers, bare-path binding, and the
  bare-name opt-out.

## Required

- [Retracted demand release](/quest/m0/broadcast-epoch/unannounce-demand-release.md) - a retracted broadcast's track demand is released when its last subscriber leaves, as before #4741
- [Apps](/quest/m0/broadcast-epoch/apps.md) - moq-cli, the browser publish and watch components, and demo/web publish under epochs and play bare names
- [Gateways](/quest/m0/broadcast-epoch/gateways.md) - RTMP, SRT, and WHIP ingest mint an epoch per incoming connection, so an encoder reconnect is a clean takeover
- [TS restart](/quest/m0/broadcast-epoch/ts-restart.md) - a signalled backward TS discontinuity finishes the broadcast and continues the same input under a fresh epoch
- [Bindings](/quest/m0/broadcast-epoch/bindings.md) - moq-ffi and every wrapper expose the epoch and a one-call mint
- [GStreamer](/quest/m0/broadcast-epoch/gst.md) - moqsink publishes each run under a fresh epoch
- [Remove `--hop`](/quest/m0/broadcast-epoch/hop-removal.md) - `moq` takes an optional `--epoch` instead of `--hop`, a plain publisher declares a random Hop ID, and the per-session hop stamp is gone
- [Bounded stats aggregate](/quest/m0/broadcast-epoch/stats-aggregate-bound.md) - the stats aggregator folds departed nodes into a retired total, so epoch churn stops growing its memory
- [Stats epochs](/quest/m0/broadcast-epoch/stats-epoch.md) - moq-stats publishes each node under its own epoch, so a restarted node never stalls its viewers
