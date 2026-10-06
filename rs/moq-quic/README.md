# moq-quic

MoQ's sans-IO QUIC state machine, a hard fork of [quinn-proto](https://github.com/quinn-rs/quinn).

All credit for the code goes to the quinn developers; it stays under quinn's MIT or Apache-2.0 license.

## Upstream

Forked from quinn-proto in quinn-rs/quinn `main` at [`7616e6b2`](https://github.com/quinn-rs/quinn/commit/7616e6b2782722f3ce4a1b181ef08817d7f545e4) (2026-10-05).
That covers every quinn security advisory published through 2026-09-30.

The fork never merges upstream.
Upstream fixes are cherry-picked by hand, and the crate keeps quinn's formatting (rustfmt defaults) so the patches apply cleanly.
Rewrite quinn's crate path and name in the patch before applying it, so its context matches the renamed lines:

```sh
git -C ../quinn format-patch -1 --stdout <sha> -- quinn-proto \
  | sed -E 's#([ab])/quinn-proto/#\1/rs/moq-quic/#g; s/quinn_proto/moq_quic/g' \
  | git am -3
```

`Cargo.toml` hunks still need applying by hand, since the manifest renames the package and inlines quinn's workspace dependency specs.

### Carried changes

Besides the crate rename:

- **BBR3**, from [quinn#2481](https://github.com/quinn-rs/quinn/pull/2481) at [`55f74c0d`](https://github.com/quinn-rs/quinn/pull/2481/commits/55f74c0dd0738b5ad7d7676c0b2869a547783f83) (open upstream), rebased onto the fork point with authorship kept. It replaces quinn's BBR and is the default controller. It carries the BBR correctness fixes moq-dev/noq shipped in `moq-noq` 1.3.1, and with them the `Controller` changes BBR needs: packets named by number and `SpaceId`, `on_packet_sent`, `on_packet_lost`, `on_cwnd_limited`, `on_app_limited`, `on_ack_frequency_update`, and a `pacing_rate` and `send_quantum` the pacer obeys. `ControllerMetrics` rates are bytes per second.
- **Classic ECN for BBR3**, ported from [moq-dev/noq#12](https://github.com/moq-dev/noq/pull/12): CE exits Startup, stops a bandwidth probe, or lowers the short-term model, once per recovery episode, instead of counting as a loss.
- **Pacer rounding**: a wait shorter than a nanosecond rounds up instead of re-arming the pacing timer at the current instant.
- **qlog pacing rate** in bits per second, as qlog defines it.
- moq-dev/noq's congestion-callback regressions, reworked onto quinn's test harness.

Recheck these when cherry-picking quinn#2481 updates, or if it merges.

### Advisory triage

`cargo audit` cannot match the renamed crate, so security fixes are tracked by hand.
Watch quinn-rs/quinn's [security advisories](https://github.com/quinn-rs/quinn/security/advisories) and releases (including the `0.11.x` branch, which sometimes gets a fix `main` does not need).
For each quinn-proto advisory, check whether the vulnerable code exists in this fork, and if it does, port the fix together with its regression test.
