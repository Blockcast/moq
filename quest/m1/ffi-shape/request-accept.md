# [XS] A request's origins are accept() arguments

## Goal

`MoqRequest` loses its `set_publish`/`set_consume` setters. The origins a
server serves an incoming session with are arguments to `accept()`, in
moq-ffi and every wrapper, so the root namespace has no setters left.

## Plan

[Net](/quest/m1/ffi-shape/net.md) (#4697) replaced every other root setter
with config records but left these two. Mirror the shape of moq-net's
server-side request accept. Use one optional argument per origin, or a small
record if the wrapper idioms read better with one. Update the `doc/lib`
samples and the server examples in every binding.

Public API: breaking in every binding, on `dev` with the line. Wire: none.
