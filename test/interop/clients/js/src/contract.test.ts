import { expect, test } from "bun:test";
import * as Moq from "@moq/net";
import {
	countedElapsed,
	gradedSamples,
	type JointSample,
	jointStalls,
	lateJoinStartsLive,
	leakedPlayerStarted,
	type Resources,
	rateElapsed,
	readLiveGop,
} from "./contract";

const flat = (at: number, frameId: number | undefined, audioBytes: number, publisherFrame?: number): JointSample => ({
	at,
	frameId,
	audioBytes,
	publisherFrame,
});

const playing: Resources = { transports: 1, sockets: 0, audioContexts: 1, workers: 0 };

test("a leaked player is visible when it reuses the pooled transport", () => {
	const leaked: Resources = { transports: 1, sockets: 0, audioContexts: 2, workers: 0 };
	expect(leakedPlayerStarted(playing, leaked)).toBe(true);
});

test("a leaked player is visible when it reuses a pooled websocket fallback", () => {
	const busy: Resources = { transports: 0, sockets: 1, audioContexts: 1, workers: 0 };
	const leaked: Resources = { transports: 0, sockets: 1, audioContexts: 2, workers: 0 };
	expect(leakedPlayerStarted(busy, leaked)).toBe(true);
});

test("unchanged counts are not a leak start", () => {
	expect(leakedPlayerStarted(playing, playing)).toBe(false);
});

test("late join uses the published GOP when painting is ahead of capture", async () => {
	const broadcast = new Moq.Broadcast.Producer();
	const track = broadcast.createTrack("video");
	try {
		const old = track.appendGroup();
		old.writeFrame({ payload: new Uint8Array([1]), timestamp: Moq.Time.Timestamp.fromMillis(3000) });
		old.close();
		const current = track.appendGroup();
		current.writeFrame({ payload: new Uint8Array([2]), timestamp: Moq.Time.Timestamp.fromMillis(3700) });
		current.writeFrame({ payload: new Uint8Array([3]), timestamp: Moq.Time.Timestamp.fromMillis(4199) });

		// Painted counter 127 can precede capture while GOP 111 remains current. The old
		// 127 - 111 <= 15 check rejects a valid join; an earlier published GOP must fail.
		const viewer = track.subscribe();
		const gop = await readLiveGop(broadcast.track("video"));
		expect(gop.timestamp).toBe(3700);
		expect(lateJoinStartsLive(gop, 3700)).toBe(true);
		expect(lateJoinStartsLive(gop, 4199)).toBe(true);
		expect(lateJoinStartsLive(gop, 3000)).toBe(false);
		expect(lateJoinStartsLive(gop, undefined)).toBe(false);
		expect(track.demand().used.peek()).toBe(true);
		const viewed = await viewer.recvGroup();
		expect((await viewed?.readFrame())?.payload).toEqual(new Uint8Array([2]));
		expect((await viewed?.readFrame())?.payload).toEqual(new Uint8Array([3]));
		viewed?.close();
		viewer.close();
		await track.demand().unused();
		expect(track.demand().used.peek()).toBe(false);
	} finally {
		broadcast.close();
	}
});

test("a joint freeze is a runner stall when the publisher clock sits still", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, 10, 1000, 40));
	expect(jointStalls(samples)).toEqual([{ kind: "runner", from: 0, to: 600 }]);
});

test("a joint freeze is the path when the publisher clock keeps moving", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, 10, 1000, 40 + i * 2));
	expect(jointStalls(samples)).toEqual([{ kind: "path", from: 0, to: 600 }]);
});

test("one frame of publisher motion is the read gap, not a moving clock", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, 10, 1000, i === 0 ? 40 : 41));
	expect(jointStalls(samples)).toEqual([{ kind: "runner", from: 0, to: 600 }]);
});

test("a sample-clock hole with both tracks still is a runner stall without a publisher reading", () => {
	expect(jointStalls([flat(0, 10, 1000), flat(600, 10, 1000)])).toEqual([{ kind: "runner", from: 0, to: 600 }]);
});

test("a sample-clock hole names the runner even when the publisher frame jumped across it", () => {
	expect(jointStalls([flat(0, 10, 1000, 10), flat(700, 10, 1000, 40)])).toEqual([
		{ kind: "runner", from: 0, to: 700 },
	]);
});

test("an unread publisher clock does not excuse a steady joint freeze", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, 10, 1000));
	expect(jointStalls(samples)).toEqual([{ kind: "path", from: 0, to: 600 }]);
});

test("a publisher frame that restarts is the path, not a stopped clock", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, 10, 1000, i === 0 ? 100 : 0));
	expect(jointStalls(samples)).toEqual([{ kind: "path", from: 0, to: 600 }]);
});

test("frozen video is not a joint stall while audio is still arriving", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, 0, 1000 + i * 100, 0));
	expect(jointStalls(samples)).toEqual([]);
});

test("advancing frames are not a joint stall while audio sits still", () => {
	const samples = Array.from({ length: 13 }, (_, i) => flat(i * 50, i, 1000, i));
	expect(jointStalls(samples)).toEqual([]);
});

test("a sampling gap during playback is not a joint stall when the frame and the audio both moved", () => {
	expect(jointStalls([flat(0, 10, 100, 10), flat(800, 34, 5000, 34)])).toEqual([]);
});

test("a flat stretch under 400ms is not a stall", () => {
	expect(jointStalls([flat(0, 1, 1, 1), flat(100, 1, 1, 1)])).toEqual([]);
	expect(jointStalls([flat(0, 1, 1, 1), flat(350, 1, 1, 1)])).toEqual([]);
});

test("runner stalls come out of the elapsed time and the tone pool", () => {
	const samples = [flat(0, 1, 1, 1), flat(800, 1, 1, 1), flat(850, 2, 200, 20), flat(4000, 90, 9000, 120)];
	const stalls = jointStalls(samples);
	expect(stalls).toEqual([{ kind: "runner", from: 0, to: 800 }]);
	expect(countedElapsed(0, 4000, stalls)).toBe(3200);
	expect(rateElapsed(4000, 3200)).toBe(3200);
	expect(rateElapsed(4000, 500)).toBe(4000);

	const tone = Array.from({ length: 20 }, (_, i) => ({ at: i * 50 }));
	const interior = gradedSamples(tone, [{ kind: "runner", from: 100, to: 400 }]);
	expect(interior.map((sample) => sample.at)).toEqual([
		0, 50, 100, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950,
	]);

	const eaten = Array.from({ length: 12 }, (_, i) => ({ at: i * 50 }));
	expect(gradedSamples(eaten, [{ kind: "runner", from: 0, to: 550 }])).toBe(eaten);
});
