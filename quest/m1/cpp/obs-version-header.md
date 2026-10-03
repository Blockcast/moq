# [XS] OBS builds on case-insensitive filesystems

## Goal

The `OBS (macOS)` and `OBS (Windows)` jobs in `platform.yml` build the plugin
against the in-tree `cpp/moq` again. The line's CI is green before it lands.

## Plan

Both jobs fail compiling `cpp/moq/src/moq.cpp` with errors pointing at
`cpp/moq/version` line 1. `cpp/obs/cmake/common/bootstrap.cmake` sets
`CMAKE_INCLUDE_CURRENT_DIR` globally, so the `add_subdirectory` of `cpp/moq`
puts its source directory on the include path. On a case-insensitive
filesystem `cpp/moq/VERSION` then answers the standard library's
`#include <version>`.

Fix it at the source rather than renaming the file: keep the source
directory off `moq-cpp`'s include path (unset `CMAKE_INCLUDE_CURRENT_DIR` for
the subdirectory, or scope it to the plugin target). `cpp/obs/VERSION` has
the same shape if the plugin's own directory is ever on a C++ include path.

## Related

- [C++ through moq-ffi](/quest/m1/cpp/README.md) - the line this blocks
