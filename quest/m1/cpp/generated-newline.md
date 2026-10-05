# [S] Generated bindings end with a newline

## Goal

`OBS (macOS)` in `obs.yml` builds the plugin against the in-tree
`cpp/moq`. Today it fails with `no newline at end of file
[-Werror,-Wnewline-eof]` on the rendered `moq.hpp`, `moq.cpp`, and
`moq_scaffolding.hpp`.

## Plan

Askama drops each template's final newline, so uniffi-bindgen-cpp writes
files that end mid-line. The OBS template builds with `-Wnewline-eof` and
warnings as errors, and any consumer compiling the published `moq.cpp` with
the same flags hits it too, so fix the generator, not the OBS flags.

In the fork (`kixelated/uniffi-bindgen-cpp`, branch `kixelated/uniffi-0.32`),
append `"\n"` to the three `fs::write` calls in
`bindgen/src/bindings/cpp/mod.rs`, and build `cpp-tests` with
`-Werror=newline-eof` on clang as the regression check. Tag
`v0.11.0-kixelated.3+v0.32.2` and bump every pin site (grep the old tag;
`flake.nix` also needs its hashes), as #4292 did.

The fork release needs the maintainer: an unattended agent was refused
permission to cut it.

## Related

- [C++ through moq-ffi](/quest/m1/cpp/README.md) - the line this blocks
