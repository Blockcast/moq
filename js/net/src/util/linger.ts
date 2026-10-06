import { type GetPromise, type Getter, race, Signal } from "@moq/signals";

/**
 * How long an upstream SUBSCRIBE or FETCH outlives the last reader wanting it, mirroring Rust's
 * `track::REQUEST_LINGER`. A reader that re-subscribes, seeks, or blips is back within a round
 * trip, and rides the request still in flight instead of a cancel and a fresh request.
 */
export const REQUEST_LINGER_MS = 1000;

/** The demand a request is held for: a track's subscribers or a group's readers. */
export interface Demand {
	readonly used: Getter<boolean>;
	readonly closed: GetPromise<Error | null>;
	unused(): Promise<void>;
}

/**
 * Resolves once `demand` stays unused through {@link REQUEST_LINGER_MS}, or closes. A reader
 * returning restarts the linger for the next time it leaves.
 */
export async function abandoned(demand: Demand): Promise<void> {
	const lapsed = Symbol("lapsed");
	for (;;) {
		await demand.unused();
		if (demand.closed.peek() !== undefined) return;

		let timer: ReturnType<typeof setTimeout> | undefined;
		const expired = new Promise<typeof lapsed>((resolve) => {
			timer = setTimeout(() => resolve(lapsed), REQUEST_LINGER_MS);
		});
		try {
			while (!demand.used.peek() && demand.closed.peek() === undefined) {
				if ((await race([expired, Signal.race(demand.used, demand.closed)])) === lapsed) return;
			}
		} finally {
			clearTimeout(timer);
		}
	}
}
