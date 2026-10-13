# @moq/media-sync

Transport-neutral media clock, pacing, and generation-safe per-track delivery queues.
No dependencies: no transport, container, decoder, or renderer.

```ts
import { MediaSync } from "@moq/media-sync";

const sync = new MediaSync({ buffer: { video: 50, audio: 100 }, timestampScale: 1_000 }); // µs timestamps
sync.enqueue(frame.timestamp, "video", async (signal) => {
	const decoded = await decode(frame, signal); // stage the effect
	return () => render(decoded); // commit only if the generation is still current
});
sync.cancel("video"); // retire the video generation: staged commits are discarded
```

- `received(timestamp)` seeds the clock. It must run before `wait()`, which throws on an unseeded clock.
- `timestampScale` is the number of media timestamp units per clock unit, so callers keep their own units.
- `cancel(kind)` and `reset()` retire a generation: nothing staged before the retirement commits after it,
  including stages that are mid-`await`, and timestamps may be reused afterwards.
- `reset()` also clears the clock and wakes every waiter, so parked waits release.

`@moq/media-sync/vectors` exports the clock, pacing, and retirement vectors, so a wrapper that adapts units
or callbacks can be tested against the same cases as the core.
