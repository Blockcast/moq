import { describe, expect, it } from "bun:test";
import { MediaSync } from "./index.ts";
import { MEDIA_SYNC_CLOCK_VECTORS, MEDIA_SYNC_DELIVERY_VECTORS, MEDIA_SYNC_PACING_VECTORS } from "./vectors.ts";

describe("MediaSync", () => {
	for (const vector of MEDIA_SYNC_CLOCK_VECTORS) {
		it(`runs the shared clock vector: ${vector.name}`, () => {
			let now: number = vector.anchorClock;
			const sync = new MediaSync({
				now: () => now,
				buffer: vector.buffer,
				timestampScale: vector.timestampScale,
			});
			sync.received(vector.anchorTimestamp);
			now = vector.readClock;

			expect(sync.reference).toBe(vector.expected.reference);
			expect(sync.timestamp).toBe(vector.expected.timestamp);
			expect(sync.now("video")).toBe(vector.expected.videoNow);
			expect(sync.now("audio")).toBe(vector.expected.audioNow);
		});
	}

	for (const vector of MEDIA_SYNC_PACING_VECTORS) {
		it(`runs the shared pacing vector: ${vector.name}`, async () => {
			let now: number = vector.anchorClockMs;
			const sync = new MediaSync({ now: () => now, buffer: vector.bufferMs });
			sync.received(vector.anchorTimestampMs);
			now = vector.earlyClockMs;
			sync.received(vector.deliveryTimestampMs);
			let delivered = false;
			sync.enqueue(vector.deliveryTimestampMs, vector.kind, () => () => (delivered = true));
			await Promise.resolve();
			await Promise.resolve();
			expect(delivered).toBe(false);

			now = vector.dueClockMs;
			sync.received(vector.anchorTimestampMs);
			await sync.drain(vector.kind);
			expect(delivered).toBe(true);
		});
	}

	it("clears clock state on reset", () => {
		const sync = new MediaSync({ now: () => 1_000 });
		sync.received(900);
		sync.reset();
		expect(sync.reference).toBeUndefined();
		expect(sync.timestamp).toBeUndefined();
	});

	for (const vector of MEDIA_SYNC_DELIVERY_VECTORS) {
		it(`prevents post-await and queued commits after ${vector.name}`, async () => {
			const sync = new MediaSync({ now: () => 0 });
			const started = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const delivered: number[] = [];
			const signal = sync.captureSignal(vector.kind);
			const retire = () => {
				if (vector.retire === "cancel") sync.cancel(vector.kind);
				else sync.reset();
			};

			sync.enqueue(
				vector.firstTimestampMs,
				vector.kind,
				async () => {
					started.resolve();
					await release.promise;
					return () => delivered.push(1);
				},
				undefined,
				signal,
				false,
			);
			sync.enqueue(
				vector.queuedTimestampMs,
				vector.kind,
				() => () => delivered.push(2),
				undefined,
				signal,
				false,
			);

			await started.promise;
			retire();
			release.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(signal.aborted).toBe(true);
			expect(delivered).toEqual([]);
		});

		it(`accepts timestamp reuse after ${vector.name}`, async () => {
			const sync = new MediaSync({ now: () => 0 });
			let delivered = 0;
			const retire = () => {
				if (vector.retire === "cancel") sync.cancel(vector.kind);
				else sync.reset();
			};
			const enqueue = () =>
				sync.enqueue(
					vector.reusedTimestampMs,
					vector.kind,
					() => () => delivered++,
					undefined,
					undefined,
					false,
				);
			enqueue();
			await sync.drain(vector.kind);
			retire();
			enqueue();
			await sync.drain(vector.kind);
			expect(delivered).toBe(2);
		});
	}

	it("does not advance clock state for a canceled speculative delivery", () => {
		let now = 1_000;
		const sync = new MediaSync({ now: () => now });
		sync.received(900);

		now = 1_010;
		sync.enqueue(950, "video", () => () => undefined, undefined, undefined, false);
		sync.cancel("video");

		expect(sync.reference).toBe(100);
		expect(sync.timestamp).toBe(900);
	});

	it("reports a synchronous immediate-stage failure", () => {
		const sync = new MediaSync();
		let failure: unknown;
		sync.deliver(
			"video",
			() => {
				throw new Error("stage failed");
			},
			(error) => {
				failure = error;
			},
		);
		expect(failure).toBeInstanceOf(Error);
	});
});
