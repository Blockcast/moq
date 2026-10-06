# [XS] Generated bindings end with a newline

## Goal

`OBS (macOS)` in `obs.yml` builds the plugin against the in-tree `cpp/moq`
again. Today it fails with `no newline at end of file
[-Werror,-Wnewline-eof]` on the rendered `moq.hpp`, `moq.cpp`, and
`moq_scaffolding.hpp`. This waits on the maintainer: check with
`gh release view --repo kixelated/uniffi-bindgen-cpp v0.11.0-kixelated.3+v0.32.2`
or `git ls-remote --tags https://github.com/kixelated/uniffi-bindgen-cpp`.

## Plan

The generator fix is ready in
[kixelated/uniffi-bindgen-cpp#2](https://github.com/kixelated/uniffi-bindgen-cpp/pull/2):
the rendered files end with a newline, `cpp-tests` builds with
`-Werror=newline-eof` on Clang, and `uniffi::Future` is `[[nodiscard]]`, so a
discarded future (the OBS `shutdown()` bug fixed in #4079) warns. An
unattended agent may not merge or tag it.

Once the maintainer merges it and pushes `v0.11.0-kixelated.3+v0.32.2`, bump
every site that names `v0.11.0-kixelated.2+v0.32.2` (`flake.nix` and its two
hashes, `rs/moq-ffi/build.sh`, `cpp/moq/README.md`, `cpp.yml`, `obs.yml`,
`release-cpp.yml`).
