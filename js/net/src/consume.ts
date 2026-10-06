import type * as broadcast from "./broadcast.ts";
import type * as Epoch from "./epoch.ts";
import type * as Path from "./path.ts";

/**
 * Per-identity dedup cache for consumed broadcasts, shared by the moq-lite and moq-ietf
 * subscribers.
 *
 * Resolving the same path must not mint a fresh subscription per call: repeat requests
 * for the same path (e.g. several renditions referencing one `broadcast: "./source"`) should
 * share a single upstream subscription. This mirrors the Rust `origin::Consumer` weak-cache:
 * a still-live identity resolves to a shared {@link broadcast.Consumer.clone}, a closed one is
 * re-consumed on the next request. Each handle is reference-counted, so the shared broadcast
 * closes once every caller has closed its handle.
 *
 * @internal
 */
export class BroadcastCache {
	// The base handle per (path, epoch); callers get reference-counted clones of it.
	#cache = new Map<string, broadcast.Consumer>();

	/** A shared handle to the live broadcast cached for `path`, or `undefined` on a miss. */
	get(path: Path.Valid, epoch?: Epoch.Valid): broadcast.Consumer | undefined {
		const base = this.#cache.get(JSON.stringify([path, epoch]));
		if (base && base.closed.peek() === undefined) return base.clone();
		return undefined;
	}

	/**
	 * Cache `consumer` as the base handle for `path` (evicting it once it closes) and return it.
	 * Call on a {@link get} miss, after wiring up the fresh consumer's subscribe loop.
	 */
	insert(path: Path.Valid, consumer: broadcast.Consumer, epoch?: Epoch.Valid): broadcast.Consumer {
		this.#cache.set(JSON.stringify([path, epoch]), consumer);

		// Drop the entry once the broadcast closes (every handle released), so the next request
		// re-consumes rather than cloning a dead handle. Guard against a newer entry for the path.
		void consumer.closed.then(() => {
			if (this.#cache.get(JSON.stringify([path, epoch])) === consumer)
				this.#cache.delete(JSON.stringify([path, epoch]));
		});

		return consumer;
	}

	/**
	 * Stop sharing the broadcast cached for `path`, so the next request subscribes fresh.
	 *
	 * Call when the path's advertisement goes away. A handle only leaves the cache on its own
	 * once *every* holder has closed it, so one holder outliving the publisher (a second
	 * watcher, or a caller consuming the path directly) would otherwise keep the dead
	 * generation's cached tracks alive and hand them to whoever consumes the path next.
	 * Existing handles are left alone: they belong to their holders, and the wire resets
	 * whatever they still have open.
	 *
	 * An epoch's retraction evicts only that identity. Unidentified advertisements still
	 * evict conservatively when overlapping announcement streams retract the same path.
	 */
	evict(path: Path.Valid, epoch?: Epoch.Valid): void {
		this.#cache.delete(JSON.stringify([path, epoch]));
	}
}
