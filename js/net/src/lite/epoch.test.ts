import { expect, test } from "bun:test";
import * as Epoch from "../epoch.ts";
import * as Path from "../path.ts";
import { Reader, Writer } from "../stream.ts";
import { decodeAnnounceBroadcast, encodeAnnounceBroadcast } from "./announce.ts";
import { Fetch } from "./fetch.ts";
import { Subscribe } from "./subscribe.ts";
import { Track } from "./track.ts";
import { Version } from "./version.ts";

const epoch = Epoch.parse("01900000-0000-7000-8000-000000000001");
const path = Path.from("live");

async function bytes(version: Version, encode: (writer: Writer) => Promise<void>) {
	const chunks: Uint8Array[] = [];
	const writer = new Writer(
		new WritableStream<Uint8Array>({
			write: (chunk) => {
				chunks.push(chunk.slice());
			},
		}),
		version,
	);
	await encode(writer);
	writer.close();
	await writer.closed;
	return Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk)));
}

test.each([Version.DRAFT_05, Version.DRAFT_06, Version.DRAFT_07])(
	"epoch trailers preserve the path on version %s",
	async (version) => {
		for (const identity of [undefined, epoch]) {
			const messages = [
				[new Track(path, "video", identity), Track.decode],
				[new Fetch({ broadcast: path, track: "video", priority: 0, group: 3, epoch: identity }), Fetch.decode],
				[
					new Subscribe({ id: 1n, broadcast: path, track: "video", priority: 0, epoch: identity }),
					Subscribe.decode,
				],
			] as const;
			for (const [message, decode] of messages) {
				const encoded = await bytes(version, (writer) => message.encode(writer, version));
				const reader = new Reader(undefined, encoded, version);
				const got = await decode(reader, version);
				expect(got.broadcast).toBe(path);
				expect(got.epoch).toBe(identity);
				expect(await reader.done()).toBe(true);
			}
			const encoded = await bytes(version, (writer) =>
				encodeAnnounceBroadcast(writer, { status: "active", suffix: path, hops: [], epoch: identity }, version),
			);
			const got = await decodeAnnounceBroadcast(new Reader(undefined, encoded, version), version);
			expect(got.status).toBe("active");
			if (got.status !== "active") throw new Error("expected active");
			expect(got.suffix).toBe(path);
			expect(got.epoch).toBe(identity);
		}
	},
);

test("a plain TRACK keeps its original bytes", async () => {
	const encoded = await bytes(Version.DRAFT_05, (writer) => new Track(path, "v").encode(writer, Version.DRAFT_05));
	expect(encoded).toEqual(Uint8Array.from([7, 4, 108, 105, 118, 101, 1, 118]));
});

test("pre-SETUP versions refuse epoch trailers", async () => {
	await expect(
		bytes(Version.DRAFT_04, (writer) =>
			new Subscribe({ id: 1n, broadcast: path, track: "v", priority: 0, epoch }).encode(writer, Version.DRAFT_04),
		),
	).rejects.toThrow("epoch metadata");
});
