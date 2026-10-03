# [XS] MSVC pkg-config probe

## Goal

The `C++ (MSVC)` job in `platform.yml` passes `just cpp check`. The line's
CI is green before it lands.

## Plan

The CMake probes build and run, then the pkg-config probe fails. On the
Windows runner, `command -v pkg-config` in Git Bash finds Strawberry Perl's
`pkg-config` script, which dies under the MSYS perl with
`Can't locate Pod/Usage.pm`. The empty flags leave `c++` without the include
path, so `probe.cpp` can't find `<moq/moq.hpp>`.

The probe also compiles with `c++`, not MSVC, so it never covered MSVC
anyway. Decide between skipping the pkg-config probe on Windows (the CMake
package is the supported MSVC route) and installing a working `pkgconf` in
the job. Prefer the skip unless a Windows pkg-config consumer is expected.
Either way, a pkg-config that fails must fail the check loudly instead of
producing a misleading missing-header error.

## Related

- [C++ through moq-ffi](/quest/m1/cpp/README.md) - the line this blocks
