# [S] Media late join within one GOP

## Goal

A viewer joining a broadcast through a relay starts at the newest GOP,
never an older one the relay cached, and the `just test media` late-join
check passes under load without a wider budget.

## Plan

It failed once after [#4181](https://github.com/moq-dev/moq/pull/4181):
"joined at frame 111, 16 frames behind 127", against a budget of one GOP
(15). The interop browser check "late join starts live" failed the same way
on `main` (09-24, 09-25, 09-28, and
[#4577](https://github.com/moq-dev/moq/pull/4577)).
[#4719](https://github.com/moq-dev/moq/pull/4719), landing with the
test-flakes-2 line, compares the latecomer against the published keyframe
instead of the painted counter. `just test media` is that same browser lane;
there is no separate Rust media test.

Reproduced 2026-10-06 on a loaded machine (load 40 to 65 on 24 cores) by
looping `bun media.ts --cases late-join` against a local `moq-relay`. In 3 of
16 runs the latecomer presented pre-gap media, and 2 of them failed both the
old check (16 and 18 frames behind) and #4719's keyframe check. It is a real
regression, not fixture sampling, and its cause is in the Rust relay
(`moq-net`):

- The old viewer leaves, so the relay cancels its upstream subscription and
  keeps its copy idle. The cancel resets the group in flight.
- The latecomer subscribes with max age 0. The relay re-subscribes from its
  newest cached group, and the browser publisher resumes.
- The route's first group header makes the copy live
  (`lite/subscriber.rs` `GroupRecv`, `set_live` before `create_group`), but
  its first frame is still in flight. Under max age 0 an unstamped successor
  never expires the group before it (`TrackState::reach`, and the
  Expiration section of the moq-lite draft), and an aborted one is skipped.
- So the latecomer's cursor hands over the cached GOP before the newest one
  (relay debug log: groups 7, 8, 9 served within 0.2ms), and
  the player presents it.

Open decision (maintainer): how a relay's copy stops exposing an older group
as the newest while the route's next group has no frame yet.

1. Recommended: a received group stays out of arrival-order delivery until
   its first frame lands or its stream ends, and an idle copy goes live at
   that point. This matches origin publishers, which append and write in one
   step. It also matches the `idle_newest` doc ("its first frame says whether
   the cache is current"). Model semantics and the draft stay as they are.
   Cost: a reveal step in `track.rs`, used by the relay receive paths.
2. At max age 0, any newer servable group expires older ones, stamped or
   not. It's about five lines in Rust and JS, and matches the SUBSCRIBE text
   ("immediately stale once a newer group arrives"). It contradicts the
   Expiration section, changes zero-budget delivery on unstamped tracks, and
   breaks 11 `moq-net` model tests that encode the current rule. Tried
   alone, it still let 3 of 30 runs join pre-gap, through the
   `set_live`/`create_group` window.

Either way, add a deterministic `rs/moq-net/tests/rejoin.rs` case: a copy
going idle mid-group, then a zero-budget rejoin whose route answers with a
group whose header lands before its frame. That needs the mock transport to
split a stream's header from its first frame.

Public API: none. Wire: none for option 1; option 2 edits the moq-lite
Expiration rule.
