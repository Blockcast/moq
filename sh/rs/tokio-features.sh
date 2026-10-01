#!/usr/bin/env bash
# Compile moq-tokio by itself at the feature extremes and with each crypto
# provider. Its default-feature build is already part of the ordinary clippy
# pass; this catches what workspace feature unification hides.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

cargo clippy --locked -p moq-tokio --all-features -- -D warnings
for provider in aws-lc-rs ring; do
    cargo clippy --locked -p moq-tokio --no-default-features --features "$provider" -- -D warnings
    cargo nextest run --locked -p moq-tokio --no-default-features --features "$provider" --test backend
done
cargo bench --locked --profile dev -p moq-tokio --bench latency -- --test
for feature in tcp uds websocket; do
    cargo clippy --locked -p moq-tokio --no-default-features --features "aws-lc-rs,$feature" -- -D warnings
done

# shellcheck disable=SC2016 # the backticks are literal, as rustc prints them
want='a rustls QUIC backend requires a crypto provider: enable either the `aws-lc-rs` or `ring` feature'
if output=$(cargo check --locked -p moq-tokio --no-default-features 2>&1); then
    echo "rs: moq-tokio without a crypto provider should fail" >&2
    exit 1
fi
if ! grep -qF "$want" <<<"$output"; then
    echo "rs: moq-tokio should fail on: $want" >&2
    echo "$output" | grep -E '^error' >&2 || true
    exit 1
fi
