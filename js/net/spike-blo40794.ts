// BLO-40794 / BLO-40848: does @moq/net carry MMTP objects at draft-20?
//
// The measurement the spike ran against unpatched upstream, re-run against this branch.
// Each case states objects SENT on the wire against objects RECEIVED through the track,
// and asserts on the received values rather than on the absence of an error.
//
//   bun js/net/spike-blo40794.ts
//
// Kept out of the upstream commits: it measures the same three rows the `js/net` suite
// pins as tests (`src/ietf/subscriber.test.ts`, `src/ietf/ietf.test.ts`), in the shape the
// spike reported them.

import assert from "node:assert/strict";
import type * as netGroup from "./src/group.ts";
import { NativeSession } from "./src/ietf/adapter.ts";
import { type GroupFlags, Group as GroupMessage } from "./src/ietf/object.ts";
import { Subscribe, SubscribeOk } from "./src/ietf/subscribe.ts";
import { Subscriber } from "./src/ietf/subscriber.ts";
import { ALPN, Version } from "./src/ietf/version.ts";
import { createMockTransportPair } from "./src/mock.ts";
import * as Path from "./src/path.ts";
import { Reader, Stream } from "./src/stream.ts";
import { Timescale } from "./src/time.ts";
import type * as track from "./src/track.ts";

const VERSION = Version.DRAFT_20;
const ALIAS = 9n;

const PROP_TIMESTAMP = 0x10;
/** An arbitrary even-typed MOQ Object Property, standing in for an MMTP one. */
const PROP_MMTP = 0x20;

/** A subscriber with one track subscribed and answered, which is what binds {@link ALIAS}. */
async function subscribeTrack(timescale?: Timescale): Promise<{ subscriber: Subscriber; track: track.Subscriber }> {
	const pair = createMockTransportPair(ALPN.DRAFT_20);
	const subscriber = new Subscriber({ session: new NativeSession(pair.server, VERSION, true) });
	const consumed = subscriber.consume(Path.from("room")).track("video").subscribe();

	const reader = pair.client.incomingBidirectionalStreams.getReader();
	const next = await reader.read();
	reader.releaseLock();
	if (next.done) throw new Error("the subscriber never opened a subscribe stream");
	const peer = new Stream({
		readable: next.value.readable,
		writable: next.value.writable,
		version: VERSION,
	});

	await peer.reader.u53();
	const request = await Subscribe.decode(peer.reader, VERSION);
	await peer.writer.u53(SubscribeOk.id);
	await new SubscribeOk({
		requestId: request.requestId,
		trackAlias: ALIAS,
		properties: timescale !== undefined ? { timescale } : undefined,
	}).encode(peer.writer, VERSION);

	return { subscriber, track: consumed };
}

function flags(overrides: Partial<GroupFlags> = {}): GroupFlags {
	return {
		hasExtensions: false,
		hasSubgroup: false,
		hasSubgroupObject: false,
		hasEnd: true,
		hasPriority: true,
		firstObject: true,
		...overrides,
	};
}

/** One object: its Object ID Delta, properties block and payload. Every value is a 1-byte varint. */
function object(delta: number, properties: number[] | undefined, payload: string): number[] {
	const body = Array.from(new TextEncoder().encode(payload));
	const block = properties === undefined ? [] : [properties.length, ...properties];
	return [delta, ...block, body.length, ...body];
}

/** Read up to `count` objects, stopping at the end of the group rather than hanging. */
async function read(group: netGroup.Consumer, count: number) {
	const objects = [];
	for (let i = 0; i < count; i++) {
		const frame = await group.readFrameSequence();
		if (!frame) break;
		objects.push(frame);
	}
	return objects;
}

let failures = 0;
function check(name: string, fn: () => void) {
	try {
		fn();
	} catch (err) {
		failures++;
		console.log(`  FAIL ${name}: ${(err as Error).message}`);
	}
}

// ---------------------------------------------------------------- subgroups
{
	const { subscriber, track } = await subscribeTrack();
	const sent = ["a", "b", "c"];
	const header = new GroupMessage({
		trackAlias: ALIAS,
		groupId: 4,
		subGroupId: 1,
		publisherPriority: 0,
		flags: flags({ hasSubgroup: true }),
	});
	const wire = new Uint8Array(sent.flatMap((payload) => object(0, undefined, payload)));
	await subscriber.handleGroup(header, new Reader(undefined, wire, VERSION));

	const group = await track.ordered().nextGroup();
	const received = group ? await read(group, sent.length) : [];
	console.log(
		`[js/subscriber] subgroup=1 sent=${sent.length} received=${received.length} dropped=${sent.length - received.length} ` +
			`subgroups=[${received.map((f) => f.object?.subgroup).join(",")}]`,
	);
	check("every object arrives", () => assert.equal(received.length, sent.length));
	check("payloads survive", () =>
		assert.deepEqual(
			received.map((f) => new TextDecoder().decode(f.payload)),
			sent,
		),
	);
	check("the subgroup travels with each object", () =>
		assert.deepEqual(
			received.map((f) => f.object?.subgroup),
			[1, 1, 1],
		),
	);
	track.close();
}

// -------------------------------------------------------- object id spacing
{
	const { subscriber, track } = await subscribeTrack();
	// Object IDs 0, 2, 5 -> deltas 0, 1, 2 (draft-20 11.4.3: later id = prior + delta + 1).
	const ids = [0, 2, 5];
	const deltas = [0, 1, 2];
	const header = new GroupMessage({
		trackAlias: ALIAS,
		groupId: 4,
		subGroupId: 0,
		publisherPriority: 0,
		flags: flags(),
	});
	const wire = new Uint8Array(deltas.flatMap((delta, i) => object(delta, undefined, `obj${ids[i]}`)));
	await subscriber.handleGroup(header, new Reader(undefined, wire, VERSION));

	const group = await track.ordered().nextGroup();
	const received = group ? await read(group, ids.length) : [];
	console.log(
		`[js/subscriber] ids=[${ids}] sent=${ids.length} received=${received.length} dropped=${ids.length - received.length} ` +
			`received_ids=[${received.map((f) => f.object?.id).join(",")}]`,
	);
	check("every object arrives", () => assert.equal(received.length, ids.length));
	check("the ids are the ids that were sent", () =>
		assert.deepEqual(
			received.map((f) => f.object?.id),
			ids,
		),
	);
	track.close();
}

// ------------------------------------------------------------- properties
{
	const { subscriber, track } = await subscribeTrack(Timescale.MILLI);
	// Delta-encoded property types: 0x10 (Timestamp), then +0x10 -> 0x20.
	const properties = [[PROP_TIMESTAMP, 20, 0x10, 42] as number[], [PROP_TIMESTAMP, 30, 0x10, 42] as number[]];
	const payloads = ["a", "b"];
	const header = new GroupMessage({
		trackAlias: ALIAS,
		groupId: 4,
		subGroupId: 1,
		publisherPriority: 0,
		flags: flags({ hasSubgroup: true, hasExtensions: true }),
	});
	const wire = new Uint8Array(payloads.flatMap((payload, i) => object(0, properties[i], payload)));
	await subscriber.handleGroup(header, new Reader(undefined, wire, VERSION));

	const group = await track.ordered().nextGroup();
	const received = group ? await read(group, payloads.length) : [];
	const perObject = received.map((f) => f.object?.propertyList?.length ?? 0);
	console.log(
		`[js/subscriber] sent=${payloads.length} received=${received.length} properties_sent_per_object=2 ` +
			`properties_received_per_object=[${perObject.join(",")}] ` +
			`carried_property=0x${PROP_MMTP.toString(16)}=${received[0]?.object?.propertyList?.[1]?.value}`,
	);
	check("every object arrives", () => assert.equal(received.length, payloads.length));
	check("payloads survive", () =>
		assert.deepEqual(
			received.map((f) => new TextDecoder().decode(f.payload)),
			payloads,
		),
	);
	check("timestamps survive", () => {
		for (const [i, f] of received.entries()) assert.equal(f.timestamp.value, 20 + 10 * i, `timestamp ${i}`);
	});
	check("both properties reach the consumer", () => assert.deepEqual(perObject, [2, 2]));
	check("the arbitrary property keeps its id and value", () => {
		for (const [i, f] of received.entries()) {
			assert.deepEqual(f.object?.propertyList?.[1], { type: BigInt(PROP_MMTP), value: 42n }, `object ${i}`);
		}
	});
	check("and the block survives verbatim", () => {
		for (const [i, f] of received.entries()) {
			assert.deepEqual(Array.from(f.object?.properties ?? []), properties[i], `block ${i}`);
		}
	});
	track.close();
}

console.log(failures === 0 ? "\nALL ASSERTIONS PASSED" : `\n${failures} ASSERTION(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
