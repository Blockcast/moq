import { expect, jest, test } from "bun:test";
import * as Track from "../track.ts";
import { abandoned, REQUEST_LINGER_MS } from "./linger.ts";

function fakeTime(): Disposable {
	jest.useFakeTimers();
	return { [Symbol.dispose]: () => jest.useRealTimers() };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

function watch(promise: Promise<void>): { done: boolean } {
	const state = { done: false };
	void promise.then(() => {
		state.done = true;
	});
	return state;
}

test("abandoned: resolves once demand stays unused through the linger", async () => {
	using _time = fakeTime();
	const producer = new Track.Producer("video");
	const subscriber = producer.subscribe();
	const watched = watch(abandoned(producer.demand()));

	subscriber.close();
	await settle();
	jest.advanceTimersByTime(REQUEST_LINGER_MS - 1);
	await settle();
	expect(watched.done).toBe(false);

	jest.advanceTimersByTime(1);
	await settle();
	expect(watched.done).toBe(true);
	producer.close();
});

test("abandoned: a returning reader restarts the linger", async () => {
	using _time = fakeTime();
	const producer = new Track.Producer("video");
	const first = producer.subscribe();
	const watched = watch(abandoned(producer.demand()));

	first.close();
	await settle();
	jest.advanceTimersByTime(REQUEST_LINGER_MS / 2);
	const second = producer.subscribe();
	await settle();
	jest.advanceTimersByTime(REQUEST_LINGER_MS);
	await settle();
	expect(watched.done).toBe(false);

	// The window counts from the second reader leaving.
	second.close();
	await settle();
	jest.advanceTimersByTime(REQUEST_LINGER_MS - 1);
	await settle();
	expect(watched.done).toBe(false);
	jest.advanceTimersByTime(1);
	await settle();
	expect(watched.done).toBe(true);
	producer.close();
});

test("abandoned: resolves at once when the track closes", async () => {
	using _time = fakeTime();
	const producer = new Track.Producer("video");
	const subscriber = producer.subscribe();
	const watched = watch(abandoned(producer.demand()));

	producer.close();
	subscriber.close();
	await settle();
	expect(watched.done).toBe(true);
});
