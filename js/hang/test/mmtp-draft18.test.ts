import { afterEach, expect, test } from "bun:test";
import { Time } from "@moq/net";
// The in-process WebTransport pair and the package-private handle view are @moq/net's own
// test fixtures, so this test runs a real session (SETUP, SUBSCRIBE, data streams) with no
// network. Neither is a public export, hence the relative imports.
import { accept, connect } from "../../net/src/connection/index.ts";
import * as Ietf from "../../net/src/ietf/index.ts";
import { createMockTransportPair } from "../../net/src/mock.ts";
import { Producer as OriginProducer } from "../../net/src/origin.ts";
import * as Path from "../../net/src/path.ts";
import { wireOf } from "../../net/src/wire.ts";
import { Consumer, type Read } from "../src/container/consumer.ts";
import { Format } from "../src/container/mmtp.ts";
import vectors from "../src/container/mmtp.vectors.json";

const url = new URL("https://localhost:4443/mmtp");

function bytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
}

function hex(data: Uint8Array): string {
	return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function vector(name: string) {
	const found = [...vectors.positive, ...vectors.negative].find((c) => c.name === name);
	if (!found) throw new Error(`missing vector ${name}`);
	return found;
}

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanup.splice(0)) fn();
});

type Packet = { timestampUs: number | null; packet: { hex: string } };

/**
 * Open a draft-18 session, subscribe to track "video" through a hang consumer, and return a
 * writer for whole groups of MMTP packets. Groups are written only once the subscription is
 * live, so the test measures the mapping and not the publisher's cache.
 */
async function session() {
	const pair = createMockTransportPair(Ietf.ALPN.DRAFT_18);
	const origin = new OriginProducer();
	const [client, server] = await Promise.all([
		connect({ url, transport: pair.client }),
		accept({ transport: pair.server, url, publish: origin.consume() }),
	]);
	cleanup.push(() => {
		client.abort();
		server.abort();
	});

	const broadcast = origin.createBroadcast(Path.from("mmtp"));
	broadcast.announce();
	cleanup.push(() => broadcast.close());

	const accepted = (async () => {
		for (;;) {
			const request = await wireOf(broadcast).requested();
			if (!request) throw new Error("broadcast closed before the subscription");
			if (request.name === "video") return request.accept({ timescale: Time.Timescale.MICRO });
			request.reject(new Error(`unexpected track ${request.name}`));
		}
	})();

	const remote = wireOf(client).consume(Path.from("mmtp"));
	cleanup.push(() => remote.close());
	const subscriber = remote.track("video").subscribe({ maxDelay: Time.Milli(30_000) });
	const format = new Format({ kind: "mmtp", packetId: 100 });
	const consumer = new Consumer(subscriber, { format, maxDelay: Time.Milli(30_000) });
	cleanup.push(() => consumer.close());

	const track = await accepted;
	const write = (packets: Packet[]) => {
		const group = track.appendGroup();
		for (const p of packets) {
			// A null timestamp vector is written at 0: this test is about the session, not untimed frames.
			group.writeFrame({
				payload: bytes(p.packet.hex),
				timestamp: Time.Timestamp.fromMicros(p.timestampUs ?? 0),
			});
		}
		group.close();
	};
	return { client, consumer, format, write };
}

async function nextFrame(consumer: Consumer): Promise<Extract<Read, { kind: "frame" }>> {
	for (;;) {
		const read = await consumer.next();
		if (!read) throw new Error("track ended before a frame");
		if (read.kind === "frame") return read;
	}
}

test("draft-18 session delivers a fragmented MMTP sample to the hang consumer", async () => {
	const whole = vector("whole-sample-keyframe");
	const fragmented = vector("fragmented-sample-three-fragments");
	const metadata = vector("mpu-metadata-is-not-a-frame");

	const { client, consumer, format, write } = await session();
	write([...metadata.frames, ...whole.frames]);

	// The negotiated protocol is draft-18, not whatever the newest draft this build speaks is.
	expect(client.version).toBe(Ietf.versionName(Ietf.Version.DRAFT_18));

	const first = await nextFrame(consumer);
	expect([hex(first.frame.payload), first.frame.timestamp as number, first.frame.keyframe]).toEqual([
		"aabbcc",
		1000,
		true,
	]);

	write(fragmented.frames);

	const second = await nextFrame(consumer);
	expect([hex(second.frame.payload), second.frame.timestamp as number, second.frame.keyframe]).toEqual([
		"1122334455",
		2000,
		true,
	]);
	expect(second.group).not.toBe(first.group);
	expect(format.stats.metadata).toBe(1);
});

test("draft-18 session: a packet of another packet_id truncates its group, later groups still play", async () => {
	const whole = vector("whole-sample-keyframe");
	const wrong = vector("wrong-packet-id");
	const fec = vector("source-fec-payload-id-trailer");
	const fragmented = vector("fragmented-sample-three-fragments");

	const { consumer, write } = await session();
	write([...whole.frames, ...wrong.frames, ...fec.frames]);

	// The sample decoded before the refused packet still plays.
	const first = await nextFrame(consumer);
	expect([hex(first.frame.payload), first.frame.timestamp as number]).toEqual(["aabbcc", 1000]);

	// The refused packet ends its group: the valid sample written after it (0xdead at 3000) never
	// plays, and the next group does.
	write(fragmented.frames);
	const second = await nextFrame(consumer);
	expect([hex(second.frame.payload), second.frame.timestamp as number]).toEqual(["1122334455", 2000]);
	expect(second.group).not.toBe(first.group);
});
