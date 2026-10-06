# [L] Audio and video codecs get their own namespaces

## Goal

`audio` and `video` each own a broadcast-bound producer, a codec-only
encoder, and a decoder, mirroring moq-audio's and moq-video's types, with one
shape between them. `video.Producer` and `audio.Producer` mirror Rust's
`encode::Producer` and are constructed from the handles it takes (the
broadcast and its catalog). `video.Encoder` and `audio.Encoder` mirror
`encode::Encoder` and take only a codec config. `BroadcastProducer` loses
`encode_audio`/`encode_video` and `BroadcastConsumer` loses
`decode_audio`/`decode_video`.

## Plan

Decided by the maintainer in the 2026-10-06 audit: the binding names mirror
Rust, so every moq-ffi type maps to the Rust type of the same name. The
broadcast-bound types are `video.Producer`/`audio.Producer`
(`rs/moq-video/src/encode/producer.rs`, `rs/moq-audio/src/encode/producer.rs`),
and this quest also owns the codec-only `video.Encoder`/`audio.Encoder`
(`encode::Encoder` in `encoder.rs`). The OBS adapters
([video](/quest/m1/obs-moq-video/adapter.md),
[audio](/quest/m1/obs-moq-video/audio-publish.md)) consume these rather than
adding their own. Rejected: shipping only the Producers here and leaving the
codec-only Encoder to the OBS audio quest.

Mirror moq-audio's and moq-video's `encode`/`decode` modules. Today the two
disagree on where the track name goes (`encode_audio` takes it as an
argument, `encode_video` reads `output.track`), and decode passes the catalog
key apart from its rendition; pick one convention for both. Go's
`EncodeAudio` takes an options struct. Encoder producers watch subscribers
through `demand()` only. Both groups stay behind their cargo features and off
wasm.

The video encoder's output mirrors moq-video's `encode::Gop`:
`MoqVideoEncoderOutput.gop: Option<u32>` becomes a `MoqVideoGop` enum with a
`Keyframe { interval }` variant, defaulting to keyframes at two seconds, and
documented as non-exhaustive like the core. The wrappers expose it as an enum
their callers construct, not one they are asked to match, so
[intra-refresh bindings](/quest/m3/intra-refresh-bindings.md) adds the refresh
variant additively instead of breaking `gop` a second time. Go gets no uniffi
default, so its zero value must read as keyframe mode.

The audio and video frame and decoder-output records carry microsecond fields
(`timestamp_us`, `max_age_us`, `frame_duration_us`); in Python and Go they
should become owned `timedelta` / `time.Duration` records like net's.

Public API: breaking in every binding. Wire: none.
