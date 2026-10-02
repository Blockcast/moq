# [M] qmux returns every byte's credit and sends its close frame

## Goal

A qmux session returns connection-level credit for every byte it receives,
whether the app reads it, drops the stream unread, or it arrives after
STOP_SENDING, so a long-lived session never stalls on MAX_DATA. `close()`
delivers its APPLICATION_CLOSE frame before the transport drops, so a TCP or
WebSocket peer sees the close code whenever the transport stays writable
within the close bound. Both hold on the 0.5 line that
`main` pins and the 0.6 line `dev` uses.

## Plan

The source fixes are prepared as upstream drafts:

- [0.6 line](https://github.com/moq-dev/web-transport/pull/412), targeting `main`.
- [0.5 line](https://github.com/moq-dev/web-transport/pull/413), targeting
  `qmux-v0.5.x` and retaining web-transport-trait 0.4.

Both return unread connection credit on stop/drop, retain stopped stream
accounting through FIN/RESET, and register the first receive frame before
publishing its frontend. Shared stream-count ownership bounds retained state.
The writer drains the first requested close before publishing teardown, with a
one-second bound including any in-flight write. Paused-time regressions cover
these paths, plus byte-stream peers across drafts 00, 01, and 02.

The two end-to-end regressions fail on unmodified qmux 0.5.2. Focused suites pass
on both fixes: 189 tests on 0.6 and 181 on 0.5, including doctests. Upstream CI
still needs to finish; these are draft PRs, not released fixes.

Remaining work:

- Merge the upstream fixes after review and CI.
- Publish patched 0.5.x newer than 0.5.2 and patched 0.6.x newer than 0.6.1.
  The upstream release workflow only runs on `main`; the 0.5 release needs the
  maintainer's release process.
- Bump `main`'s current 0.5.2 pin to the released 0.5 fix and validate the
  WebSocket fallback. Update `dev` to the released 0.6 fix. Keep `main` on 0.5,
  since web-transport-trait 0.5 is a breaking change reserved for `dev`.
- Delete this quest only after both release and pin steps are complete.

Public API: none. Wire: none.

## Related

- [qmux on noq-proto](/quest/m2/quic-qmux.md) - replaces these stream maps later
