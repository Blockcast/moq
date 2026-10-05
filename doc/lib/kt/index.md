---
title: Kotlin
description: Coroutines and Flow for Android and the JVM via dev.moq:moq
---

# Kotlin

[![Maven Central](https://img.shields.io/maven-central/v/dev.moq/moq)](https://central.sonatype.com/artifact/dev.moq/moq)

`dev.moq:moq` on Maven Central: a Kotlin Multiplatform wrapper with a
`Moq.connect(...)` facade, `Flow`s for every live sequence, and structured
cancellation that reaches the native consumer. It pulls in `dev.moq:moq-ffi`,
which carries the native binaries for Android (arm64-v8a, armeabi-v7a,
x86\_64) and desktop JVM (Linux x86\_64/aarch64, macOS arm64, Windows x64).

`dev.moq.media` owns catalogs, encoded imports, and container consumers. `TrackProducer.audio`
/ `.video` take a broadcast, a `Named` or `Requested` target, and an init record.
`CatalogProducer(broadcast)` holds its broadcast weakly and fails with `Closed` after it closes.
Construct readers with `CatalogConsumer.subscribe`, `ContainerConsumer.subscribe`, or
`ContainerGroupConsumer.fetch`.

```kotlin ignore
dependencies {
    implementation("dev.moq:moq:<version>")   // latest: see the badge above
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
}
```

```kotlin
import dev.moq.*
import dev.moq.media.*

// Subscribe. The Flow is live, so run it in its own coroutine.
Moq.connect("https://relay.example.com", ClientConfig(tls = ClientTls(roots = listOf("ca.pem")))).use { moq ->
    moq.announced(AnnounceConfig(prefix = "live/", filter = "*/camera")).updates().collect { event ->
        if (event !is AnnounceEventStart) return@collect // Update, End, or Live
        // Prefixes stay origin-relative; captures reports what each wildcard matched.
        println(event.announce.captures)
        val broadcast = moq.requestBroadcast(event.announce.prefix)
        println(catalog(broadcast))
    }
}
```

```kotlin
// Publish encoded frames, or raw pixels with the codec inside the binding.
// opusInit, packet, pts, and rgba come from your encoder or capture source.
Moq.connect("https://relay.example.com").use { moq ->
    val broadcast = moq.createBroadcast("my-stream.hang")
    val audio = dev.moq.media.TrackProducer.audio(broadcast, Named(null), AudioInit(format = AudioFormat.OPUS, data = opusInit))
    audio.writeFrame(Frame(payload = packet, timestampUs = 20_000u))

    val video = broadcast.encodeVideo(
        VideoEncoderInput(format = VideoPixelFormat.RGBA, width = 1280u, height = 720u, framerate = 30u),
        VideoEncoderOutput(codec = VideoCodec.H264, track = "camera", bitrate = null, gop = null, kind = autoEncoder),
    )
    video.write(VideoFrame(timestampUs = pts, data = rgba))
    broadcast.announce(Route())
    audio.finish()
    video.finish()
    broadcast.end()
    moq.shutdown()
}
```

`media.TrackProducer.flush(timestampUs)` records a locally encoded frame's transport handoff on the broadcast media clock. Call it after `writeFrame` for live encoder output; omit it for file, pipe, and network imports. `media.TrackProducer` is a typealias, so the generated method is available directly.

Call `media.discontinuity()` when the source seeks, pauses, or changes its time base. It publishes a timeline marker and restarts handoff measurement without lowering advertised jitter. Resume with timestamps that continue forward on the broadcast media clock; this does not permit timestamp rewinds. On a video track, resume with a keyframe: a delta frame before it fails.

The three advertising operations: `moq.createBroadcast(path)` (or
`origin.createBroadcast`) returns an unannounced producer, invisible to everyone;
`broadcast.announce(route)` / `broadcast.unannounce()` own that exact-path
advertisement, and `broadcast.end()` ends the broadcast for good (a second call
is a no-op; Kotlin spells it `end` because `close()`, or `use { }`, releases the
handle, which ends the broadcast only once no `dynamic()` handle remains); `origin.dynamic(prefix, route)` claims `prefix` and every
path beneath it (`""` for everything). Hold the returned `OriginDynamic`
while the claim should stay advertised, and reject the requests you will not
serve. A route is a capability, not an inventory. `announced(config).updates()` takes
a literal prefix plus an optional relative pattern and yields `AnnounceEvent`s:
`AnnounceEventStart`, `AnnounceEventUpdate`, or `AnnounceEventEnd`
carrying an `Announce`, whose `prefix` stays origin-relative and whose
`captures` reports the wildcard matches, or `AnnounceEventLive` once every route
live at subscribe time has been delivered. Paths with
a `.`-prefixed segment below the prefix are [hidden](/concept/moq-lite#hidden-broadcasts) unless `hidden = true`.

Sessions reconnect with backoff when the transport drops and re-announce local
broadcasts. `moq.epoch()` counts the connections, 1 on the first, pairing with
`MoqSession.status` to log each reconnect. `Moq.connect(url, config)` takes a
`ClientConfig`: `backoff` tunes the pacing (`timeoutUs = 0uL` retries forever),
`quic = QuicConfig(maxStreams = ...)` raises the peer's inbound stream cap,
`versions` pins the protocol versions offered, and `once = true` dials once. A
value the native side cannot use throws `MoqException.Config`.

The [WebSocket fallback](/concept/transport#websocket-fallback) races QUIC after
a 200 ms head start. `WebSocketConfig(enabled = false)` turns it off for a
QUIC-only relay, and `delayUs` changes the head start.

`Server.listen(ServerConfig(bind = ..., tls = ServerTls(generate = ...)))` accepts
sessions with per-request `accept(publish = null, consume = null)`/`reject()`.
Null inherits the server default; a supplied origin replaces it. Pass a fresh
origin for isolation, or the same origin on both sides to share it. Origins are
captured when accept starts; a second response throws `AlreadyResponded`, and
calls after cancel throw `Cancelled`. `MoqRequest.transport()` returns a `Transport` enum.
JSON tracks live in the `dev.moq.json` package and take `@Serializable` types:
`SnapshotProducer(broadcast, track, SnapshotConfig())` takes over a track from
`publishTrack`, `SnapshotConsumer(track, SnapshotConfig())` one from
`subscribeTrack`, and `valuesAs<T>()` decodes. The rest of
the [shared feature list](/lib/#what-every-binding-can-do) maps one to one:
`fetchGroup`/`media.ContainerGroupConsumer.fetch`, `dynamic()` for tracks and `dynamic(prefix)` for broadcasts, `appendDatagram`/`datagrams()`,
`media.CatalogProducer.setSection`, `demand()` for `name()`, `used()`, and `unused()`. `session.bandwidth()` divides the
connection's send estimate; pass it to `encodeVideo` / `encodeAudio` or
`reserve` a share for an app-owned track. `MoqException.isAuth` and
`isShutdown` classify errors. Microsecond fields read back as a
`kotlin.time.Duration`: `stats.rtt`, `backoff.initial`, `frame.timestamp`. `protocolError` is the structured protocol failure
(scope, verbatim code, kind) when the peer sent one. An exception's `toString()` is the Rust error message.
Cancelling the collecting coroutine cancels the native side.

`encodeAudio` encodes raw PCM inside the binding. Its codec is an object,
`AudioCodec.opus()` or `AudioCodec.aac()`, and
`AudioEncoderOutput.frameDurationUs` sets the Opus frame length: 2500, 5000,
10000, 20000 (the default), 40000, or 60000. 0 takes the codec's own frame,
which AAC needs. AAC-LC encodes through the platform's encoder, so a host
without one refuses it.

Audio `channels` also names the speaker layout, by the WAVE convention: 1 is
mono, 2 stereo, 3 2.1, 4 quad, 5 5.0, 6 5.1, 7 6.1, and 8 7.1, interleaved
front left, front right, center, LFE, back, then side. Decoding remixes to the
count you ask for; past 8 channels the samples pass through but can't be
remixed.

Each frame from `decodeVideo` owns its decoded picture until `close()` (or
`use {}`), including after the consumer is cancelled. `frame.pixels(format)`
converts it on demand: `VideoPixelFormat.I420`, or `VideoPixelFormat.RGBA` for
four bytes a pixel. Close frames promptly, since held frames hold decoder
buffers. `resize` is best effort: only NVDEC has a built-in scaler, and
MediaCodec is not it, so read each frame's own `width()` and `height()` rather
than assuming it took. `VideoDecoderOutput(surface = true)` keeps the decoder's
surface for `frame.surface()` instead of downloading it. Only macOS has one, so
`decodeVideo` fails as unsupported elsewhere.

## Connection stats

`session.stats()` returns a `ConnectionStats` snapshot. Each field is `null`
when the transport backend does not report it (native QUIC reports all of them;
browser WebTransport reports few or none) or before it is available, which is
not the same as zero. `rttUs` is microseconds; the `rtt` extension property
reads it as a `kotlin.time.Duration`.

| Field | Unit | Meaning |
| --- | --- | --- |
| `rttUs` | microseconds | Smoothed round-trip time. |
| `estimatedSendRateBps` | bits per second | Send bandwidth from the congestion controller. |
| `estimatedRecvRateBps` | bits per second | Receive bandwidth from MoQ PROBE. |
| `bytesSent` | bytes | Total sent, including retransmissions and overhead. |
| `bytesReceived` | bytes | Total received, including duplicates and overhead. |
| `bytesLost` | bytes | Total lost, detected via retransmission or acknowledgement. |
| `packetsSent` | datagrams | Total datagrams sent. |
| `packetsReceived` | datagrams | Total datagrams received. |
| `packetsLost` | datagrams | Total datagrams detected as lost. |

- API reference: [javadoc.io/doc/dev.moq/moq](https://javadoc.io/doc/dev.moq/moq)
- Source: [`kt/`](https://github.com/moq-dev/moq/tree/main/kt); `just kt check` builds and tests locally
- Artifacts: [dev.moq:moq](https://central.sonatype.com/artifact/dev.moq/moq), [dev.moq:moq-ffi](https://central.sonatype.com/artifact/dev.moq/moq-ffi)

Raw track publisher metadata has an optional maximum age. Omitting it imposes no publisher age limit; zero keeps the live edge. Local cache limits still apply, and media imports explicitly retain 30 seconds. See [publisher retention](/concept/moq-lite).

Call suspending `session.shutdown()` or `moq.shutdown()` to drain finished tracks before disconnecting. They throw if delivery has not completed within one second. Finish or abort live tracks first. `cancel(0u)` and synchronous `Moq.close()` remain immediate; `use { }` therefore cancels on exit. IETF media streams are not drained yet.
