# [S] Media late join within one GOP

## Goal

A viewer joining a broadcast through a relay after a demand gap presents the
newest GOP, never an older one, and the `just test media` late-join check
("late join starts live") passes under load without a wider budget.

## Plan

It failed once after [#4181](https://github.com/moq-dev/moq/pull/4181) ("16
frames behind" a 15-frame GOP), and the interop browser check failed the
same way on `main`. `just test media` is that browser lane through a Rust
`moq-relay`; there is no separate Rust media test.
[#4719](https://github.com/moq-dev/moq/pull/4719) now compares the
latecomer against the published keyframe instead of the painted counter.

It is real, not fixture sampling: the latecomer is handed a GOP from before
the demand gap. Reproduced by looping `bun media.ts --cases late-join`
against a local relay with debug logs. In the fixture, the old viewer
leaves, the publisher pauses (closing its open GOP and writing an empty
marker group), and the latecomer joins about a second later.

[#4914](https://github.com/moq-dev/moq/pull/4914) fixed two relay windows,
each with a deterministic test:

- A received group stays hidden from readers until its first frame lands or
  its stream ends, and an idle copy goes live only once the cache shows the
  route's answer (`rejoin_waits_for_the_answers_first_frame`).
- A rejoin's answer is judged against the groups that survived the leave,
  not the idle snapshot, since the cancel resets the group in flight
  (`an_answer_past_a_reset_group_skips_the_cache`).

What remains (1 of 30 runs after both fixes): the latecomer's max age rises
to its playout delay (about 145ms) right after it subscribes. When the
pre-gap GOP was short, the GOP before it still reaches within that budget of
the marker, so the relay hands it over by design. The player then presents
from that GOP's keyframe, not from its playout position. Relay log: groups
7, 8, 9 served in 1ms with a 145ms budget, and the player shows frames 360ms
behind the published keyframe.

Open decision (maintainer): what keeps a joiner off pre-gap media that its
budget legitimately reaches.

1. Recommended: in live (unbuffered) mode, the watch player presents nothing
   older than its playout position (newest timestamp minus delay) and decodes
   the rest silently. This holds however the groups interleave: the relay
   served the cached GOP and the marker within 1ms of each other, so whatever
   decides has to run at presentation, after both have landed. Buffered
   playback still starts at the head of what its budget can play.
2. The hang consumer (`js/hang` `Container.Consumer`, and its Rust mirror)
   drops every group before a discontinuity marker that lands before its
   first frame is handed out. The marker already exists for this ("a later
   subscriber resumes ... without the pre-gap group reading as live"). It's
   narrower, but it loses the race whenever the cached GOP's keyframe is
   handed out before the marker lands.

Public API: none. Wire: none.
