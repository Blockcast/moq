# [M] T-STD compliant TS export

## Goal

`moq export ts` output passes a full ISO 13818-1 T-STD buffer-model check
(transport, multiplex, and elementary buffers, with every access unit decoded
at its DTS without overflow or underflow), on a clean path and under
sustained loss. That is the bar for the media-aware lane to carry primary
distribution. Without it, only the passthrough lane can.

## Plan

Decided (2026-09-30), from a discussion with t0ms and Gwendal's email: a
TS export has to be a proper remux, not an interleave of demuxed tracks.
Padding, pacing, and muxing all assume a fixed delay, so the export gets one
first. t0ms is testing whether T-STD compliance is feasible at all; record
the result here. If it isn't, re-plan this line.

Measured (2026-09-30, #4645): with the fixed-delay jitter buffer and the
constant-rate schedule, a clean-path round trip of the generated clip passes
the strict T-STD check at 10 Mb/s and at 2 Mb/s, where every keyframe outgrows
a PCR interval. A burst that does not fit the delay fails the export rather
than overrun the rate.

This README owns the end-to-end proof: the #4613 netem rig (10% loss, a real
~10 Mb/s broadcast TS) passes the strict T-STD check, and the recipe runs
nightly.
