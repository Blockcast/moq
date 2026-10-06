/**
 * Everything the page and its driver both have to agree on.
 *
 * Free of browser imports on purpose: the drivers run under Bun, where importing anything that
 * reaches `@moq/publish` or `@moq/watch` fails on a browser-only asset (a worklet, a worker). Values
 * a driver needs live here; the page-side modules add the behavior.
 *
 * @module
 */

import type * as Moq from "@moq/net";

// ── the deterministic publisher ─────────────────────────────────────────────

/** A deliberate defect, used to prove an assertion can fail. */
export type Fault =
	/** Publish the pattern faithfully. */
	| "none"
	/** Mute the tone, leaving the audio track encoding digital silence. */
	| "silent-audio"
	/** Keep painting frame 0, so the picture never advances. */
	| "frozen-video"
	/** Run the tone table ahead of the picture by {@link OFFSET_STEPS}. */
	| "audio-offset";

/** Every recognized {@link Fault}, for argument validation. */
export const FAULTS: readonly Fault[] = ["none", "silent-audio", "frozen-video", "audio-offset"];

/** How far `audio-offset` shifts the tone table. Larger than the tolerance, smaller than half a cycle. */
export const OFFSET_STEPS = 4;

/** What the fixture publishes about itself, mirrored onto its host element's dataset. */
export type FixtureState = {
	/** The frame counter most recently painted, or -1 before the clock starts. */
	frameId: number;
	/** `AudioContext.state`. The pattern clock cannot start until this is "running". */
	audioState: AudioContextState;
	/** True once the broadcast is announced with both a video and an audio config in its catalog. */
	ready: boolean;
	/** True while a subscriber is pulling video, i.e. the encoder's demand gate is open. */
	videoActive: boolean;
	/** True while a subscriber is pulling audio. */
	audioActive: boolean;
	/** Frames the encoder has produced. */
	encodedFrames: number;
};

/** The newest published video's GOP, sampled independently of canvas capture and encoding. */
export type LiveGop = {
	/** The timestamp of its keyframe, in milliseconds on the publisher's media clock. */
	timestamp: number;
};

/** Read the newest published GOP without retaining a subscription or changing its frames. */
export async function readLiveGop(track: Moq.Track.Consumer): Promise<LiveGop> {
	const subscriber = track.subscribe();
	try {
		const group = await subscriber.recvGroup();
		if (!group) throw new Error("the fixture video has no published GOP");
		try {
			const frame = await group.readFrame();
			if (!frame) throw new Error("the fixture GOP has no keyframe");
			return { timestamp: frame.timestamp.asMillis() };
		} finally {
			group.close();
		}
	} finally {
		subscriber.close();
	}
}

/** True when the presented frame belongs to the sampled GOP or a newer one. */
export function lateJoinStartsLive(gop: LiveGop, timestamp: number | undefined): boolean {
	return timestamp !== undefined && timestamp >= gop.timestamp;
}

/** The camera publisher state mirrored onto its element for Playwright. */
export type CaptureState = {
	videoError?: string;
	audioError?: string;
	videoActive: boolean;
	audioActive: boolean;
};

/** Rate the tone is generated and captured at. Stated rather than probed, so the catalog is fixed. */
export const SAMPLE_RATE = 48000;

/** Maximum distance between video keyframes in the deterministic fixture. */
export const KEYFRAME_INTERVAL_MS = 500;

// ── the subscriber's measurements ───────────────────────────────────────────

/** How often the page takes a sample. Fast enough to see a 200ms tone step, cheap enough to sustain. */
export const SAMPLE_MS = 50;

/** How far the tone peak must stand above the spectrum's median for the tone to count as present. */
export const TONE_FLOOR_DB = 15;

/**
 * Waveform level below which the playback sink counts as silent.
 *
 * The fixture's tone reaches the graph root at about 0.35 rms, so this is an order of magnitude of
 * headroom. It exists because a dB margin alone cannot tell silence from a tone: with most of the
 * spectrum at -Infinity, any finite peak stands infinitely above the floor.
 */
export const AUDIBLE_RMS = 0.02;

/** Live instances of each resource the page's wrappers count. */
export type Resources = {
	/** Open `WebTransport` sessions, i.e. connections to the relay. */
	transports: number;
	/** Open `WebSocket`s: the transport a connection falls back to when QUIC loses the race. */
	sockets: number;
	/** Unclosed `AudioContext`s, i.e. audio graphs and their render threads. */
	audioContexts: number;
	/** Unterminated `Worker`s. */
	workers: number;
};

/**
 * True once a leaked player has started, even when it reuses a pooled transport.
 *
 * Two `<moq-watch>` elements on one relay URL share a WebTransport, so a session
 * count cannot move. Each player still builds its own audio graph.
 */
export function leakedPlayerStarted(before: Resources, now: Resources): boolean {
	return now.audioContexts > before.audioContexts;
}

/** One measurement of both playback sinks, taken in a single tick. */
export type Sample = {
	/** Monotonic counter, so a driver can tell a fresh sample from a repeat of the last one. */
	seq: number;
	/** Whether the subscriber has resolved an announced broadcast. */
	broadcastActive: boolean;
	/** The subscriber's catalog state, which stays offline without an announcement. */
	broadcastStatus: "offline" | "loading" | "live" | "error";
	/** Whether this document has received user activation. */
	userActivated: boolean;
	/** `performance.now()` when the sample was taken. */
	at: number;

	/** Whether the canvas holds anything but the renderer's black fill. */
	painted: boolean;
	/** The fixture frame counter read out of the canvas, absent when the picture is not the fixture. */
	frameId?: number;
	/** Gap between the fixture's reference blocks, 0-255. Absent when the picture is not the fixture. */
	contrast?: number;
	/** Frames the decoder has produced. */
	videoFrames: number;
	/** Presentation timestamp of the painted frame, in milliseconds. */
	videoTimestamp?: number;

	/** Whether the catalog offers audio at all. */
	hasAudio: boolean;
	/** Encoded audio bytes received. */
	audioBytes: number;
	/** `AudioContext.state`, absent until the graph exists. */
	audioContext?: string;
	/** Playback timestamp reported by the render worklet, in milliseconds. */
	audioTimestamp?: number;
	/** Whether the audio buffer is waiting to refill. */
	audioStalled: boolean;
	/** How far playback trails the live edge, in milliseconds: the player's resolved sync delay. */
	delay: number;
	/** Peak frequency in the tone band, absent until the graph exists. */
	toneHz?: number;
	/** The tone step that peak names, absent when no tone stands above the floor. */
	toneStep?: number;
	/** Level of the tone peak, in dB. */
	toneDb?: number;
	/** Median level across the spectrum, in dB: the floor the tone has to beat. */
	noiseDb?: number;
	/** Root mean square of the graph root's output over the analyser window. */
	rms?: number;

	/** Whether the player is paused. */
	paused: boolean;
	/** Whether the `paused` attribute is reflected onto the element. */
	pausedAttribute: boolean;

	/** Platform resources the page still holds. See {@link Resources}. */
	resources: Resources;
};

/**
 * Both tracks sitting still this long is a freeze.
 *
 * Shorter than the one-second pause check, and long enough that a slow sample
 * is not one. A 0.4s hole is the freeze the nightly traces were being read for.
 */
export const JOINT_STALL_MS = 400;

/** One player reading, plus the publisher's own frame clock when it was sampled. */
export type JointSample = {
	/** `performance.now()` when the player sample was taken, in milliseconds. */
	at: number;
	/** Presented fixture frame. Absent when the canvas is not the fixture. */
	frameId?: number;
	/** Encoded audio bytes the player has received. */
	audioBytes: number;
	/** Frame the publisher had painted. Absent when that page was not read. */
	publisherFrame?: number;
};

/** A stretch where the presented frame and the received audio both sat still. */
export type JointStall = {
	/** `runner` when the page or the publisher clock stopped. `path` when only playback did. */
	kind: "runner" | "path";
	/** `at` of the first sample in the stretch, in milliseconds. */
	from: number;
	/** `at` of the last sample in the stretch, in milliseconds. */
	to: number;
};

/**
 * Stretches where one presented frame and one audio byte count both sit still.
 *
 * `runner` when the sample clock jumped, because the page was not scheduled, or
 * when the publisher's own frame clock sat still with the tracks. `path` when
 * that clock kept moving: the relay or the player. An unread publisher clock is
 * `path` too. The freeze is not excused without evidence the source stopped.
 */
export function jointStalls(samples: readonly JointSample[], minMs = JOINT_STALL_MS): JointStall[] {
	const stalls: JointStall[] = [];
	let i = 0;
	while (i < samples.length) {
		const start = samples[i];
		if (start.frameId === undefined) {
			i++;
			continue;
		}
		let j = i;
		while (
			j + 1 < samples.length &&
			samples[j + 1].frameId === start.frameId &&
			samples[j + 1].audioBytes === start.audioBytes
		) {
			j++;
		}
		const end = samples[j];
		if (j > i && end.at - start.at >= minMs) {
			// A hole this long means the page was not scheduled. That names the runner
			// even when the publisher frame moved across the hole.
			let samplerGap = false;
			for (let k = i; k < j; k++) {
				if (samples[k + 1].at - samples[k].at >= minMs) samplerGap = true;
			}
			const pubStart = start.publisherFrame;
			const pubEnd = end.publisherFrame;
			// One frame of publisher motion is the gap between the two reads, not a clock that kept running.
			const publisherStopped =
				pubStart !== undefined && pubEnd !== undefined && pubEnd >= pubStart && pubEnd - pubStart <= 1;
			stalls.push({
				kind: samplerGap || publisherStopped ? "runner" : "path",
				from: start.at,
				to: end.at,
			});
		}
		i = j + 1;
	}
	return stalls;
}

/**
 * Wall time minus runner stalls, in milliseconds.
 *
 * A path stall stays in the elapsed time. The picture sitting still while the
 * source moved is a playback failure.
 */
export function countedElapsed(firstAt: number, lastAt: number, stalls: readonly JointStall[]): number {
	let elapsed = lastAt - firstAt;
	for (const stall of stalls) {
		if (stall.kind !== "runner") continue;
		const from = Math.max(stall.from, firstAt);
		const to = Math.min(stall.to, lastAt);
		if (to > from) elapsed -= to - from;
	}
	return elapsed;
}

/**
 * Elapsed time the frame rate uses.
 *
 * Runner stalls come out once a second of the window is left. Below that the
 * stall ate the measurement, and the raw clock has to fail it.
 */
export function rateElapsed(rawMs: number, countedMs: number, minMs = 1000): number {
	return countedMs >= minMs ? countedMs : rawMs;
}

/**
 * Samples a tone or sync agreement counts.
 *
 * A runner stall's interior is the machine, not the player. Too little left is
 * a window that never played, so the whole set is graded and the silence still fails.
 */
export function gradedSamples<T extends { at: number }>(
	samples: readonly T[],
	stalls: readonly JointStall[],
	min = 10,
): readonly T[] {
	const kept = samples.filter(
		(sample) => !stalls.some((stall) => stall.kind === "runner" && sample.at > stall.from && sample.at < stall.to),
	);
	return kept.length >= min ? kept : samples;
}

// ── the refused session ─────────────────────────────────────────────────────

/** How a refused session ended, as `WebTransport.closed` reported it to the page. */
export type CloseState =
	/** `closed` resolved: the close capsule arrived. */
	| { closeCode: number; reason: string }
	/** `closed` rejected, or the relay admitted the session: the close never said why. */
	| { error: string };

// ── the command channel ─────────────────────────────────────────────────────

/**
 * Commands a page publishes, each role providing the subset that applies to it.
 *
 * Each one is a DOM edit plus the bookkeeping that has to happen with it, which is why the page
 * owns them rather than the driver reaching in.
 */
export type InteropControl = {
	/** Read the current video GOP while an existing viewer is still pulling media. */
	liveGop(): Promise<LiveGop>;
	/** Stop the fixture publisher, releasing its session. */
	stop(): void;
	/** Start (or restart) the fixture publisher on the same broadcast path. */
	start(): void;
	/** Remove the player from the DOM. */
	detach(): void;
	/** Blank the canvas the old session left behind, put the player back, and resume sampling. */
	reattach(): void;
	/** Connect a second player and leave it behind for the leaked-session negative control. */
	startLeak(): void;
};

/** The `window` property the commands are published on. */
export const CONTROL = "__moqInterop";

/** Publish the commands a role supports. Page-side only. */
export function publish(commands: Partial<InteropControl>): void {
	(window as unknown as Record<string, unknown>)[CONTROL] = commands;
}
