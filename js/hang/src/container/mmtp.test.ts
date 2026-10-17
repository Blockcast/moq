import { expect, test } from "bun:test";
import { Time } from "@moq/net";
import { ContainerSchema, containerSupported } from "../catalog/container.ts";
import { Format, MmtpError } from "./mmtp.ts";
import vectors from "./mmtp.vectors.json";

interface VectorFrame {
	timestampUs: number | null;
	packet: { hex: string; fields: { field: string; hex: string }[] };
}

interface VectorCase {
	name: string;
	packetId: number;
	frames: VectorFrame[];
	expect: {
		frames?: { payloadHex: string; timestampUs: number; keyframe: boolean }[];
		pendingAfterEachFrame?: number[];
		metadata?: number;
		error?: string;
		gate?: string;
	};
}

function bytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(data: Uint8Array): string {
	return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The three packets of the fragmented-sample vector, in emission order. */
function fragments(): [Uint8Array, Uint8Array, Uint8Array] {
	const found = positive.find((v) => v.name === "fragmented-sample-three-fragments");
	const [head, middle, tail] = found?.frames.map((f) => bytes(f.packet.hex)) ?? [];
	if (!head || !middle || !tail) throw new Error("missing vector");
	return [head, middle, tail];
}

function timestamp(us: number | null): Time.Timestamp | undefined {
	return us === null ? undefined : Time.Timestamp.fromMicros(us);
}

const positive = vectors.positive as VectorCase[];
const negative = vectors.negative as VectorCase[];

test("every vector packet is the concatenation of its annotated fields", () => {
	for (const c of [...positive, ...negative]) {
		for (const frame of c.frames) {
			expect(frame.packet.fields.map((field) => field.hex).join("")).toBe(frame.packet.hex);
		}
	}
});

test.each(positive.map((c) => [c.name, c] as const))("positive vector: %s", (_name, c) => {
	const format = new Format({ kind: "mmtp", packetId: c.packetId });
	const frames = [];
	for (const [i, frame] of c.frames.entries()) {
		frames.push(...format.decode(bytes(frame.packet.hex), timestamp(frame.timestampUs)));
		if (c.expect.pendingAfterEachFrame) expect(format.stats.pending).toBe(c.expect.pendingAfterEachFrame[i]);
	}

	expect(
		frames.map((f) => ({ payloadHex: hex(f.payload), timestampUs: f.timestamp as number, keyframe: f.keyframe })),
	).toEqual(c.expect.frames ?? []);
	expect(format.stats.metadata).toBe(c.expect.metadata ?? 0);
});

test.each(negative.map((c) => [c.name, c] as const))("negative vector: %s", (_name, c) => {
	const format = new Format({ kind: "mmtp", packetId: c.packetId });
	const last = c.frames.length - 1;
	for (const [i, frame] of c.frames.entries()) {
		const decode = () => format.decode(bytes(frame.packet.hex), timestamp(frame.timestampUs));
		if (i < last) {
			expect(decode()).toEqual([]);
			continue;
		}

		let error: unknown;
		try {
			decode();
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(MmtpError);
		expect((error as MmtpError).code).toBe(c.expect.error as MmtpError["code"]);
		if (c.expect.gate) expect((error as MmtpError).message).toContain(c.expect.gate);
	}
});

test("a refused overlapping head leaves the first data unit intact", () => {
	const overlap = negative.find((v) => v.name === "overlapping-head")?.frames[1];
	if (!overlap) throw new Error("missing vector");
	const [head, middle, tail] = fragments();

	const format = new Format({ kind: "mmtp", packetId: 100 });
	expect(format.decode(head, Time.Timestamp.fromMicros(2000))).toEqual([]);
	expect(() => format.decode(bytes(overlap.packet.hex), Time.Timestamp.fromMicros(9999))).toThrow(MmtpError);
	expect(format.decode(middle, Time.Timestamp.fromMicros(2001))).toEqual([]);

	const [frame] = format.decode(tail, Time.Timestamp.fromMicros(2002));
	expect(frame && hex(frame.payload)).toBe("1122334455");
	// The refused head's frame timestamp must not replace the accepted one.
	expect(frame?.timestamp as number).toBe(2000);
});

test("a continuation with no head yields nothing until its head arrives", () => {
	const [head, middle, tail] = fragments();

	const format = new Format({ kind: "mmtp", packetId: 100 });
	expect(format.decode(tail, undefined)).toEqual([]);
	expect(format.decode(middle, undefined)).toEqual([]);
	const frames = format.decode(head, Time.Timestamp.fromMicros(5000));
	expect(frames.map((f) => [hex(f.payload), f.timestamp as number, f.keyframe])).toEqual([
		["1122334455", 5000, true],
	]);
});

test("reset drops an incomplete data unit", () => {
	const [head, middle, tail] = fragments();

	const format = new Format({ kind: "mmtp", packetId: 100 });
	format.decode(head, Time.Timestamp.fromMicros(2000));
	format.decode(middle, undefined);
	format.reset();
	// Without its head the tail cannot complete anything.
	expect(format.decode(tail, undefined)).toEqual([]);
});

test("catalog: mmtp container parses with a media packet_id and refuses the signaling flow", () => {
	const parsed = ContainerSchema.parse({ kind: "mmtp", packetId: 100 });
	expect(parsed).toEqual({ kind: "mmtp", packetId: 100 });
	expect(containerSupported(parsed)).toBe(true);

	for (const packetId of [0, 65_536, 1.5, -1, "100", undefined]) {
		expect(() => ContainerSchema.parse({ kind: "mmtp", packetId })).toThrow();
	}
});

test("format refuses the signaling packet_id even when built without the schema", () => {
	expect(() => new Format({ kind: "mmtp", packetId: 0 })).toThrow(MmtpError);
});
