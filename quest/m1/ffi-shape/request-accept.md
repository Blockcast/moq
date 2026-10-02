# [XS] A request's origins are accept() arguments

## Goal

`MoqRequest` loses its `set_publish`/`set_consume` setters. The origins a
server serves an incoming session with are arguments to `accept()`, in
moq-ffi and every wrapper, so the root namespace has no setters left.

## Plan

[Net](/quest/m1/ffi-shape/net.md) (#4697) replaced every other root setter
with config records but left these two. moq-net's server request takes its
origins through consuming `with_publisher`/`with_subscriber` builders before
`ok()`; a shared FFI handle can't consume itself, so the origins move onto
`accept()` instead. Use one optional argument per origin, or a small
record if the wrapper idioms read better with one.

`MoqServerConfig.publish`/`consume` stay as the server defaults that seed each
request, and an omitted argument inherits them. Today `set_publish(None)` can
also clear an inherited origin; keep or drop that case on purpose, and test
inherited, overridden, and (if kept) cleared origins. Update the `doc/lib`
samples and the server examples in every binding.

Public API: breaking in every binding, on `dev` with the line. Wire: none.
