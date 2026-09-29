# [S] AUTH protocol violations close the session everywhere

## Goal

Every AUTH stream message that the lite or IETF drafts call a
PROTOCOL_VIOLATION closes the session in Rust and `@moq/net` alike, instead
of ending only its token. Examples: an AUTH_ERROR code past `u32`, an
out-of-range AUTH_OK expiry, or an AUTH_OK or AUTH_ERROR that fails to decode,
such as a bad pattern.

## Plan

[AUTH endings](/quest/m1/auth/error-codes.md) (#4550) closes the session only
on an explicit `ProtocolViolation` in Rust lite, and left three gaps:

- JS reports the exact oversized code but doesn't close the session. Let the
  JS connection close on an `AuthSession` protocol violation.
- An out-of-range IETF AUTH_OK expiry still ends only its token.
- An AUTH_OK or AUTH_ERROR that fails to decode ends only the token, like
  every other lite stream, although the draft calls a bad pattern a
  PROTOCOL_VIOLATION.

Close the session on each, in both languages and on both protocols, with one
regression test per case, and check the lite and IETF draft text agrees. Run
`just test interop --all`.

Public API: none. Wire: none beyond draft wording.

## Related

- [AUTH endings](/quest/m1/auth/error-codes.md) - the Rust lite case this generalizes
