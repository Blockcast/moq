/**
 * Transport-neutral media clock, pacing, and generation-safe delivery queues.
 *
 * {@link MediaSync} anchors media timestamps to a local clock, paces each delivery until its
 * timestamp is due, and serializes deliveries per {@link MediaKind}. Each delivery stages its
 * effects and returns a commit; {@link MediaSync.cancel} and {@link MediaSync.reset} retire the
 * current generation so a stage that resolves afterwards is discarded instead of committed.
 *
 * @module
 */

/** The independently-queued media kinds. */
export type MediaKind = "video" | "audio";

/** A staged delivery: `commit` runs only while its generation is current, `discard` otherwise. */
export type MediaDelivery = {
	commit(): void;
	discard?(): void;
};

/**
 * Stage a delivery. Return a commit function, a {@link MediaDelivery}, or `null` for nothing to commit.
 * `signal` aborts when the generation is retired.
 */
export type MediaDeliveryStage = (
	signal: AbortSignal,
) => null | (() => void) | MediaDelivery | Promise<null | (() => void) | MediaDelivery>;

/** Options for {@link MediaSync}. */
export interface MediaSyncOptions {
	/** Clock source, in clock units (default: `performance.now()` milliseconds). */
	now?: () => number;
	/** Playout delay in clock units, shared or per kind (default: zero). */
	buffer?: number | Partial<Record<MediaKind, number>>;
	/** Number of media timestamp units in one clock/buffer unit. */
	timestampScale?: number;
	/** Called whenever the reference or latest timestamp changes, including on reset. */
	onState?: (reference: number | undefined, timestamp: number | undefined) => void;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Transport-neutral media clock and generation-safe per-track delivery queue. */
export class MediaSync {
	#now: () => number;
	#buffers: Record<MediaKind, number>;
	#timestampScale: number;
	#reference: number | undefined;
	#timestamp: number | undefined;
	#onState?: MediaSyncOptions["onState"];
	#update = deferred();
	#tails: Record<MediaKind, Promise<void>> = { video: Promise.resolve(), audio: Promise.resolve() };
	#independent: Record<MediaKind, Set<Promise<void>>> = { video: new Set(), audio: new Set() };
	#controllers: Record<MediaKind, AbortController> = {
		video: new AbortController(),
		audio: new AbortController(),
	};

	constructor(options: MediaSyncOptions = {}) {
		this.#now = options.now ?? (() => performance.now());
		const buffer = options.buffer ?? 0;
		this.#buffers =
			typeof buffer === "number"
				? { video: buffer, audio: buffer }
				: { video: buffer.video ?? 0, audio: buffer.audio ?? 0 };
		this.#timestampScale = options.timestampScale ?? 1;
		if (!Number.isFinite(this.#timestampScale) || this.#timestampScale <= 0) {
			throw new Error("timestampScale must be finite and greater than zero");
		}
		this.#onState = options.onState;
	}

	/** The local clock time of media timestamp zero, or undefined until seeded. */
	get reference(): number | undefined {
		return this.#reference;
	}

	/** The latest media timestamp received, or undefined until seeded. */
	get timestamp(): number | undefined {
		return this.#timestamp;
	}

	/** The playout delay for `kind`, in clock units. */
	buffer(kind: MediaKind): number {
		return this.#buffers[kind];
	}

	/** Set the playout delay for `kind`, or for both kinds, and re-evaluate parked waits. */
	setBuffer(buffer: number, kind?: MediaKind): void {
		if (kind) {
			if (buffer === this.#buffers[kind]) return;
			this.#buffers[kind] = buffer;
		} else {
			if (buffer === this.#buffers.video && buffer === this.#buffers.audio) return;
			this.#buffers.video = buffer;
			this.#buffers.audio = buffer;
		}
		this.#wake();
	}

	/** Seed or advance the clock with a received media timestamp. Call before {@link MediaSync.wait}. */
	received(timestamp: number): void {
		if (this.#timestamp === undefined || timestamp > this.#timestamp) this.#timestamp = timestamp;
		const reference = this.#now() - timestamp / this.#timestampScale;
		if (this.#reference === undefined || reference < this.#reference) this.#reference = reference;
		this.#onState?.(this.#reference, this.#timestamp);
		this.#wake();
	}

	/** The media timestamp due for presentation now, in timestamp units, or undefined until seeded. */
	now(kind: MediaKind = "video"): number | undefined {
		if (this.#reference === undefined) return undefined;
		return (this.#now() - this.#reference - this.#buffers[kind]) * this.#timestampScale;
	}

	/** Sleep until `timestamp` is due, the clock resets, or `signal` aborts. Throws if the clock was never seeded. */
	async wait(timestamp: number, kind: MediaKind = "video", signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) return;
		if (this.#reference === undefined) throw new Error("reference not set; call received() first");

		for (;;) {
			const reference = this.#reference;
			if (reference === undefined || signal?.aborted) return;
			const sleep = reference - (this.#now() - timestamp / this.#timestampScale) + this.#buffers[kind];
			if (sleep < 5) return;

			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(timeout);
					signal?.removeEventListener("abort", finish);
					resolve();
				};
				const timeout = setTimeout(finish, sleep);
				signal?.addEventListener("abort", finish, { once: true });
				void this.#update.promise.then(finish);
				if (signal?.aborted) finish();
			});
		}
	}

	/** The signal of the current `kind` generation; it aborts when that generation is retired. */
	captureSignal(kind: MediaKind): AbortSignal {
		return this.#controllers[kind].signal;
	}

	/** Queue a staged delivery for `kind`, paced to `timestamp` and serialized behind earlier deliveries unless
	 * `pace`/`serialize` are false. A delivery captured under a retired `capturedSignal` is dropped. */
	enqueue(
		timestamp: number,
		kind: MediaKind,
		stage: MediaDeliveryStage,
		onError?: (error: unknown) => void,
		capturedSignal?: AbortSignal,
		pace = true,
		serialize = true,
	): void {
		const signal = capturedSignal ?? this.captureSignal(kind);
		if (!this.#accepts(kind, signal)) return;
		const run = async () => {
			if (!this.#accepts(kind, signal)) return;
			if (pace) await this.wait(timestamp, kind, signal);
			if (!this.#accepts(kind, signal)) return;
			const staged = await stage(signal);
			if (!staged) return;
			const delivery = typeof staged === "function" ? { commit: staged } : staged;
			if (this.#accepts(kind, signal)) delivery.commit();
			else delivery.discard?.();
		};
		const execute = () =>
			run().catch((error) => {
				if (!signal.aborted) onError?.(error);
			});
		if (!serialize) {
			const independent = this.#independent[kind];
			const pending = execute().finally(() => independent.delete(pending));
			independent.add(pending);
			return;
		}
		const independent = [...this.#independent[kind]];
		this.#tails[kind] = Promise.all([this.#tails[kind].catch(() => undefined), ...independent]).then(execute);
	}

	/** Start an unpaced stage immediately while retaining generation ownership. */
	deliver(
		kind: MediaKind,
		stage: MediaDeliveryStage,
		onError?: (error: unknown) => void,
		capturedSignal?: AbortSignal,
	): void {
		const signal = capturedSignal ?? this.captureSignal(kind);
		if (!this.#accepts(kind, signal)) return;
		let staged: ReturnType<MediaDeliveryStage>;
		try {
			staged = stage(signal);
		} catch (error) {
			onError?.(error);
			return;
		}
		void Promise.resolve(staged)
			.then((staged) => {
				if (!staged) return;
				const delivery = typeof staged === "function" ? { commit: staged } : staged;
				if (this.#accepts(kind, signal)) delivery.commit();
				else delivery.discard?.();
			})
			.catch((error) => {
				if (!signal.aborted) onError?.(error);
			});
	}

	/** Resolve once every delivery queued for `kind` so far has settled. */
	async drain(kind: MediaKind): Promise<void> {
		await this.#tails[kind];
		await Promise.all(this.#independent[kind]);
	}

	/** Retire the `kind` generation: queued and in-flight deliveries are discarded rather than committed. */
	cancel(kind: MediaKind): void {
		this.#controllers[kind].abort();
		this.#controllers[kind] = new AbortController();
		this.#tails[kind] = Promise.resolve();
		this.#independent[kind] = new Set();
	}

	/** Retire both generations, clear the clock, and wake every waiter. */
	reset(): void {
		this.cancel("video");
		this.cancel("audio");
		this.#reference = undefined;
		this.#timestamp = undefined;
		this.#onState?.(undefined, undefined);
		this.#wake();
	}

	#accepts(kind: MediaKind, signal: AbortSignal): boolean {
		return !signal.aborted && signal === this.#controllers[kind].signal;
	}

	#wake(): void {
		this.#update.resolve();
		this.#update = deferred();
	}
}
