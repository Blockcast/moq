import { Once } from "@moq/signals";

/** Tracks session-local announcement loops until their withdrawals are acknowledged. @internal */
export class Withdrawal {
	readonly closing = new Once<true>();
	#tasks = new Set<Promise<void>>();

	track(task: Promise<void>): Promise<void> {
		const tracked = task.finally(() => this.#tasks.delete(tracked));
		this.#tasks.add(tracked);
		return tracked;
	}

	async close(): Promise<void> {
		if (!this.closing.peek()) this.closing.set(true);
		await Promise.all(this.#tasks);
	}
}
