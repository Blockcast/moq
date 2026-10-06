# Broadcast epochs

## Goal

A broadcast path and its publisher epoch identify immutable content. Each new
local broadcast mints an epoch automatically, while replicas may explicitly
share one. Routes may resume a subscription only when they attest the same
requested epoch. Publisher restarts create a fresh catalog and decoder boundary.

## Plan

The core uses structured metadata, not a path suffix. Lite peers negotiate the
Epoch SETUP parameter and carry it in announcements, TRACK, SUBSCRIBE and FETCH.
Requests without an epoch stay pinned to the first serving route, never bind to
an epoch implicitly, and never merge with explicit-epoch subscriptions. They end
when their route disappears; clients resubscribe. A known epoch never follows a
new one. Route costs keep their meaning; epoch timestamps do not pick a winner.

Legacy Lite and moq-transport peers see plain paths and no epoch metadata.
Unknown incoming identity cannot be resumed across routes. This preserves
legacy discovery and delivery, but external caches still require immutable
wire names and object positions. Audit that boundary before claiming restart
safety through arbitrary third-party relays.

The remaining client work follows announcements, learns the selected epoch,
and opens a fresh broadcast with fresh decoders on a change. JS request.active
already delivers distinct broadcast handles. Native clients need an explicit
announcement-following helper; the core plain-path request does not follow.

This line still gates the release. Validate publisher restarts through the
first-party applications and bindings. Derived output identity and the
[Wildcard](/quest/m0/wildcard/README.md) line's group-start requirements need a
separate decision: an unidentified sticky route is not proof of shared content.

This README owns the final end-to-end republish test and the documentation
review after its children land. The core metadata and failover rules are in
[Publisher epochs](/doc/concept/moq-lite.md#publisher-epochs).

## Required

- [Apps](/quest/m0/broadcast-epoch/apps.md) - moq-cli, the browser publish and watch components, and demo/web expose epoch metadata and reset playback on a new instance
- [Gateways](/quest/m0/broadcast-epoch/gateways.md) - RTMP, SRT, and WHIP ingest mint an epoch per incoming connection, so an encoder reconnect is a clean takeover
- [TS restart](/quest/m0/broadcast-epoch/ts-restart.md) - a signalled backward TS discontinuity finishes the broadcast and continues the same input under a fresh epoch
- [Bindings](/quest/m0/broadcast-epoch/bindings.md) - moq-ffi and every wrapper expose the epoch and inherit the default
- [GStreamer](/quest/m0/broadcast-epoch/gst.md) - moqsink publishes each run under a fresh epoch
- [Remove `--hop`](/quest/m0/broadcast-epoch/hop-removal.md) - `moq` takes an optional `--epoch` instead of `--hop`, a plain publisher declares a random Hop ID, and the per-session hop stamp is gone
- [Stats epochs](/quest/m0/broadcast-epoch/stats-epoch.md) - moq-stats publishes each group announcement under its own epoch, so neither a restarted node nor a returning idle group stalls its viewers
- [Stats totals and prefix tracks](/quest/m0/broadcast-epoch/stats-split.md) - the same release retires the per-path stats maps for totals and on-demand prefix tracks (decided 2026-10-05)
