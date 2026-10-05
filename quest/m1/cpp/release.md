# [XS] First C++ package release

## Goal

The first `cpp-v<version>` tag is pushed and `release-cpp.yml` publishes one
`moq-cpp-<version>-<target>` tarball per target to its GitHub release, plus the
matching `obs-moq-v<version>` plugin release. A maintainer cuts it by hand
after this line reaches `release`; check with
`gh release list --repo moq-dev/moq | grep cpp-v`.

## Plan

The version is `cpp/moq/VERSION`; the plugin's is `cpp/obs/VERSION`. Delete
this quest once the release exists.
