# [XS] A request's origins are accept() arguments

## Goal

`MoqRequest` loses its `set_publish`/`set_consume` setters. The origins a
server serves an incoming session with are arguments to `accept()`, in
moq-ffi and every wrapper, so the root namespace has no setters left.

## Plan

#4697 replaced every other root setter
with config records but left these two. moq-net's server request takes its
origins through consuming `with_publisher`/`with_subscriber` builders before
`ok()`; a shared FFI handle can't consume itself, so the origins move onto
`accept()` instead.

Decided with the maintainer on 2026-10-02:

- `accept(publish=None, consume=None)` takes one optional origin per side.
  An omitted or null origin inherits the server's configured origin. A supplied
  origin replaces it. The wrapper defaults follow each language's idiom.
- `MoqServerConfig.publish`/`consume` remain the server defaults. Do not add
  a clear sentinel, a tri-state enum, or a second config record for two fields.
  A caller that needs isolation passes a fresh origin explicitly. Passing the
  same fresh origin for both sides preserves the shared local-origin case.
- Delete the request setters. Clearing an inherited origin through
  `set_publish(None)` or `set_consume(None)` disappears on purpose; null now
  means inherit. No compatibility shim remains on this breaking line.
- Test inherited defaults, independently overridden sides, both sides
  replaced by a shared fresh origin, and origins captured when accept starts.
  Existing cancellation and AlreadyResponded behavior still applies.
- Update the `doc/lib` samples and server examples in every binding inline.
  The questline's layers and upgrade guides already own the broader migration
  documentation; no separate guide quest is needed.

Public API: breaking in every binding, on `dev` with the line. Wire: none.
