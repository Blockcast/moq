# [XS] First C++ package release

## Goal

The first `cpp-v<version>` tag is pushed and `release-cpp.yml` publishes one
`moq-cpp-<version>-<target>` archive per target to its GitHub release, plus the
matching `obs-moq-v<version>` plugin release. A maintainer cuts it by hand
once `main` reaches `release`; check with
`gh release list --repo moq-dev/moq | grep cpp-v`.

## Plan

The version is `cpp/moq/VERSION`; the plugin's is `cpp/obs/VERSION`. Delete
this quest once the release exists.

The OBS plugin now ships only with a C++ release, so `obs-moq` stays at its
last moq-c build until this tag. Decided when the C++ line landed on `main`
(#4079): the first plugin built on the C++ package must not drop the
Advanced settings or the dock's protocol and reconnect reason that the moq-c
build had, so those parity quests gate this release.

The `obs-build` job runs only after a tagged C++ release, so this tag is the
first run of `just obs package --moq-release`. Watch it, and fix forward with
a plugin version bump if the fetch or the archive layout is wrong.

## Required

- [Client settings parity](/quest/m1/obs-client-config.md) - the OBS Advanced settings the migration dropped come back
- [Session report parity](/quest/m1/obs-session-report.md) - the dock shows the negotiated protocol and the reconnect failure again
