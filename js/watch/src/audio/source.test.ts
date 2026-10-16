import { expect, test } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import { Signal } from "@moq/signals";
import type { Broadcast } from "../broadcast";
import { Source } from "./source";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("selects an MMTP-only audio rendition", async () => {
	const config = Catalog.AudioConfigSchema.parse({
		codec: "opus",
		container: { kind: "mmtp", packetId: 1 },
		sampleRate: 48_000,
		numberOfChannels: 2,
	});
	const broadcast = {
		in: { connection: new Signal(undefined) },
		out: { catalog: new Signal({ audio: { renditions: { mmtp: config } } }) },
	} as unknown as Broadcast;
	const source = new Source({ broadcast, supported: async () => true });

	await flush();
	await flush();
	expect(source.out.track.peek()).toBe("mmtp");
	expect(source.out.config.peek()?.container).toEqual({ kind: "mmtp", packetId: 1 });

	source.close();
});
