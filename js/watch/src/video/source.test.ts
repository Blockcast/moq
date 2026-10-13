import { describe, expect, it } from "bun:test";
import * as Catalog from "@moq/hang/catalog";
import { Path } from "@moq/net";
import { Signal } from "@moq/signals";
import { Broadcast } from "../broadcast";
import { decoderConfigKey, supportCacheKey } from "./config";
import { Source } from "./source";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await flush();
}

function config(codec: string, fields: Record<string, unknown> = {}): Catalog.VideoConfig {
	return Catalog.VideoConfigSchema.parse({ codec, container: { kind: "legacy" }, ...fields });
}

function mockBroadcast(renditions: Record<string, Catalog.VideoConfig>): Broadcast {
	return {
		in: {
			connection: new Signal(undefined),
		},
		out: {
			catalog: new Signal({ video: { renditions } }),
		},
	} as unknown as Broadcast;
}

function mutableBroadcast(renditions: Record<string, Catalog.VideoConfig>): {
	broadcast: Broadcast;
	catalog: Signal<Catalog.Root>;
} {
	const catalog = new Signal<Catalog.Root>({ video: { renditions } });
	return {
		broadcast: {
			in: { connection: new Signal(undefined) },
			out: { catalog },
		} as unknown as Broadcast,
		catalog,
	};
}

async function withoutWarnings(fn: () => Promise<void>): Promise<void> {
	const warn = console.warn;
	console.warn = () => {};
	try {
		await fn();
	} finally {
		console.warn = warn;
	}
}

describe("Source error signal", () => {
	it("is unsupported when the catalog has video renditions but none are supported", async () => {
		await withoutWarnings(async () => {
			const source = new Source({
				broadcast: mockBroadcast({ hd: config("hev1.1.6.L120.90") }),
				supported: async () => false,
			});

			await settle();
			expect(source.out.error.peek()).toBe("unsupported");
			expect(source.out.available.peek()).toEqual({});

			source.close();
		});
	});

	it("treats a support probe throw as unsupported without aborting the remaining renditions", async () => {
		await withoutWarnings(async () => {
			const source = new Source({
				broadcast: mockBroadcast({
					bad: config("not-a-codec"),
					good: config("avc1.640028"),
				}),
				supported: async (rendition) => {
					if (rendition.codec === "not-a-codec") throw new Error("probe failed");
					return true;
				},
			});

			await settle();
			expect(source.out.error.peek()).toBeUndefined();
			expect(Object.keys(source.out.available.peek())).toEqual(["good"]);

			source.close();
		});
	});

	it("does not wedge the effect when a support probe never settles", async () => {
		// `supported` is consumer-supplied, and a rerun waits for the tasks it spawned, so a probe
		// that never settles would hold the next run shut for good unless it races the teardown.
		await withoutWarnings(async () => {
			const supported = new Signal<(config: Catalog.VideoConfig) => Promise<boolean>>(
				() => new Promise<boolean>(() => {}), // never settles
			);

			const source = new Source({
				broadcast: mockBroadcast({ hd: config("avc1.640028") }),
				supported,
			});

			await settle();
			expect(source.out.available.peek()).toEqual({});

			// Swapping the probe reruns the effect, which has to tear the parked one down first.
			// If it cannot, this rerun never opens and the new probe never runs.
			supported.set(async () => true);
			await settle();

			expect(Object.keys(source.out.available.peek())).toEqual(["hd"]);

			source.close();
		});
	});

	it("is undefined when the catalog has no video renditions", async () => {
		const source = new Source({
			broadcast: mockBroadcast({}),
			supported: async () => false,
		});

		await settle();
		expect(source.out.error.peek()).toBeUndefined();
		expect(source.out.available.peek()).toEqual({});

		source.close();
	});

	// The catalog goes as a whole rather than losing the one rendition, so a valid sibling
	// is no rescue: the reference names content outside the consumer's authorized subtree,
	// and selecting the fallback would leave a publisher bug to surface later as a track
	// that never fills.
	it("selects nothing when an escaping rendition rejects the catalog", async () => {
		const invalidVideo = { ...config("avc1.640028"), broadcast: Path.normalizeRelative("../../source") };
		const validVideo = { ...config("avc1.640028"), broadcast: Path.normalizeRelative("./source") };
		const audioConfig = Catalog.AudioConfigSchema.parse({
			codec: "opus",
			container: { kind: "legacy" },
			sampleRate: 48_000,
			numberOfChannels: 2,
		});
		const broadcast = new Broadcast({
			enabled: true,
			name: Path.from("room/catalog.hang"),
			catalogFormat: "manual",
			catalog: {
				video: { renditions: { invalid: invalidVideo, fallback: validVideo } },
				audio: {
					renditions: {
						invalid: { ...audioConfig, broadcast: Path.normalizeRelative("../../source") },
						fallback: { ...audioConfig, broadcast: Path.normalizeRelative("./source") },
					},
				},
			},
		});
		const source = new Source({ broadcast, supported: async () => true });

		const error = console.error;
		console.error = () => {};
		try {
			await settle();
			expect(broadcast.out.catalog.peek()).toBeUndefined();
			expect(Object.keys(source.out.available.peek())).toEqual([]);
			expect(source.out.track.peek()).toBeUndefined();
		} finally {
			console.error = error;
		}

		source.close();
		broadcast.close();
	});
});

describe("Source disabled rendition selection", () => {
	it("moves to an enabled rendition when the selected one is disabled, and back", async () => {
		const state = mutableBroadcast({
			low: config("avc1.64001e", { bitrate: 1_000_000 }),
			high: config("avc1.640028", { bitrate: 2_000_000 }),
		});
		// A capacity estimate admitting both rungs: with none, a costed ladder starts on its floor.
		const source = new Source({
			broadcast: state.broadcast,
			supported: async () => true,
			probe: new Signal({ estimatedRecvRate: 10_000_000 } as never),
		});

		await settle();
		expect(source.out.track.peek()).toBe("high");

		state.catalog.set({
			video: {
				renditions: {
					low: config("avc1.64001e", { bitrate: 1_000_000 }),
					high: config("avc1.640028", { bitrate: 2_000_000, enabled: false }),
				},
			},
		});
		await settle();
		expect(source.out.track.peek()).toBe("low");

		state.catalog.set({
			video: {
				renditions: {
					low: config("avc1.64001e", { bitrate: 1_000_000 }),
					high: config("avc1.640028", { bitrate: 2_000_000 }),
				},
			},
		});
		await settle();
		expect(source.out.track.peek()).toBe("high");
		source.close();
	});

	it("never selects a disabled manual target", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				low: config("avc1.64001e", { bitrate: 1_000_000 }),
				high: config("avc1.640028", { bitrate: 2_000_000, enabled: false }),
			}),
			target: { name: "high" },
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("low");
		source.close();
	});

	it("selects nothing when every rendition is disabled", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				high: config("avc1.640028", { bitrate: 2_000_000, enabled: false }),
				low: config("avc1.64001e", { bitrate: 1_000_000, enabled: false }),
			}),
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBeUndefined();
		expect(source.out.config.peek()).toBeUndefined();
		source.close();
	});

	it("ignores a legacy stalled flag", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				low: config("avc1.64001e", { bitrate: 1_000_000 }),
				high: config("avc1.640028", { bitrate: 2_000_000, stalled: true }),
			}),
			supported: async () => true,
			probe: new Signal({ estimatedRecvRate: 10_000_000 } as never),
		});

		await settle();
		expect(source.out.track.peek()).toBe("high");
		source.close();
	});

	it("does not repeat support probes for metadata-only changes", async () => {
		const state = mutableBroadcast({ high: config("avc1.640028", { bitrate: 2_000_000 }) });
		let probes = 0;
		const supported = async () => {
			probes++;
			return true;
		};
		Object.assign(supported, { [supportCacheKey]: decoderConfigKey });
		const source = new Source({
			broadcast: state.broadcast,
			supported,
		});

		await settle();
		expect(probes).toBe(1);

		state.catalog.set({
			video: {
				renditions: {
					high: config("avc1.640028", {
						bitrate: 1_500_000,
						label: "Main camera",
						codedWidth: 1280,
						codedHeight: 720,
					}),
				},
			},
		});
		await settle();

		expect(probes).toBe(1);
		expect(Number(source.out.config.peek()?.bitrate)).toBe(1_500_000);
		expect(source.out.config.peek()?.label).toBe("Main camera");
		source.close();
	});

	it("repeats custom support probes when metadata changes", async () =>
		withoutWarnings(async () => {
			const state = mutableBroadcast({ high: config("avc1.640028", { codedWidth: 1280 }) });
			let probes = 0;
			const source = new Source({
				broadcast: state.broadcast,
				supported: async (rendition) => {
					probes++;
					return (rendition.codedWidth ?? 0) <= 1920;
				},
			});

			await settle();
			expect(probes).toBe(1);
			expect(Object.keys(source.out.available.peek())).toEqual(["high"]);

			state.catalog.set({
				video: { renditions: { high: config("avc1.640028", { codedWidth: 3840 }) } },
			});
			await settle();

			expect(probes).toBe(2);
			expect(source.out.available.peek()).toEqual({});
			source.close();
		}));
});

describe("Source rendition rank", () => {
	it("breaks an exact tie by name, not catalog order", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				e: config("avc1.640028", { codedWidth: 1280, codedHeight: 720, bitrate: 3_000_000 }),
				d: config("avc1.64001e", { codedWidth: 1280, codedHeight: 720, bitrate: 3_000_000 }),
			}),
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("d");
		source.close();
	});

	it("ranks a known zero bitrate above an unknown one", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				unknown: config("avc1.640028", { codedWidth: 1280, codedHeight: 720 }),
				zero: config("avc1.64001e", { codedWidth: 1280, codedHeight: 720, bitrate: 0 }),
			}),
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("zero");
		source.close();
	});

	it("prefers a known picture over a higher bitrate with no size", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				a: config("avc1.640028", { bitrate: 9_000_000 }),
				b: config("avc1.64001e", { codedWidth: 640, codedHeight: 360, bitrate: 1_000_000 }),
			}),
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("b");
		source.close();
	});
});

describe("Source rendition preference", () => {
	// An H.265 source beside its own H.264 compatibility transcode.
	const renditions = () => ({
		source: config("hvc1.1.6.L93.B0", { codedWidth: 1280, codedHeight: 720, bitrate: 2_000_000 }),
		fallback: config("avc1.64001f", { codedWidth: 1280, codedHeight: 720, bitrate: 4_000_000, preference: -1 }),
	});
	const decodes = (prefix: string) => async (config: Catalog.VideoConfig) => !config.codec.startsWith(prefix);

	it("selects a supported source over a lower preference with a higher bitrate", async () => {
		const source = new Source({ broadcast: mockBroadcast(renditions()), supported: async () => true });

		await settle();
		expect(source.out.track.peek()).toBe("source");
		source.close();
	});

	it("selects a supported source over a lower preference that fits the bitrate budget", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				source: config("hvc1.1.6.L93.B0", { bitrate: 2_000_000 }),
				fallback: config("avc1.64001f", { bitrate: 1_000_000, preference: -1 }),
			}),
			target: { bitrate: 1_500_000 },
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("source");
		source.close();
	});

	it("selects a lower preference when the source is unsupported", async () => {
		const source = new Source({ broadcast: mockBroadcast(renditions()), supported: decodes("hvc1") });

		await settle();
		expect(source.out.track.peek()).toBe("fallback");
		source.close();
	});

	it("resolves three tiers to the highest supported one", async () => {
		const broadcast = mockBroadcast({
			av1: config("av01.0.08M.08", { codedWidth: 1280, codedHeight: 720, preference: 1 }),
			...renditions(),
		});
		const all = new Source({ broadcast, supported: async () => true });
		const noAv1 = new Source({ broadcast, supported: decodes("av01") });

		await settle();
		expect(all.out.track.peek()).toBe("av1");
		expect(noAv1.out.track.peek()).toBe("source");
		all.close();
		noAv1.close();
	});

	it("lets a manual target select a lower preference", async () => {
		const source = new Source({
			broadcast: mockBroadcast(renditions()),
			target: { name: "fallback" },
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("fallback");
		source.close();
	});

	it("steps down a transcoded ladder that shares its source's preference", async () => {
		const source = new Source({
			broadcast: mockBroadcast({
				video: config("hvc1.1.6.L93.B0", {
					codedWidth: 1920,
					codedHeight: 1080,
					bitrate: 5_000_000,
					preference: 1,
				}),
				"video/360p": config("avc1.64001e", {
					codedWidth: 640,
					codedHeight: 360,
					bitrate: 600_000,
					preference: 1,
				}),
				other: config("avc1.640028", { codedWidth: 1280, codedHeight: 720, bitrate: 900_000 }),
			}),
			target: { bitrate: 1_000_000 },
			supported: async () => true,
		});

		await settle();
		expect(source.out.track.peek()).toBe("video/360p");
		source.close();
	});
});

describe("Source selection without a PROBE estimate", () => {
	const ladder = () => ({
		low: config("avc1.64001e", { codedWidth: 640, codedHeight: 360, bitrate: 500_000 }),
		mid: config("avc1.64001f", { codedWidth: 1280, codedHeight: 720, bitrate: 1_500_000 }),
		high: config("avc1.640028", { codedWidth: 1920, codedHeight: 1080, bitrate: 4_000_000 }),
	});

	// Feed whole 1 s groups on `source`'s selected rendition. `lag(g)` is how late group g's keyframe
	// arrives behind its authored time; the encoder fills 90% of the catalog bitrate.
	function deliver(source: Source, groups: number, lag: (group: number) => number = () => 0): string[] {
		const path: string[] = [];
		let bytes = 0;
		for (let group = 0; group < groups; group++) {
			const rendition = source.out.track.peek();
			if (!rendition) throw new Error("nothing selected");
			path.push(rendition);
			const mediaTime = group * 1000;
			source.observeGroup({
				rendition,
				epoch: 1,
				groups: group + 1,
				bytes,
				mediaTime,
				arrivedAt: mediaTime + lag(group),
			});
			bytes += Math.round(((ladder()[rendition as "low"].bitrate ?? 0) * 0.9) / 8);
		}
		return path;
	}

	it("keeps the PROBE selection when an estimate exists and ignores group evidence", async () => {
		const source = new Source({
			broadcast: mockBroadcast(ladder()),
			supported: async () => true,
			probe: new Signal({ estimatedRecvRate: 2_500_000 } as never),
		});
		await settle();
		// 80% of 2.5 Mbps admits only `mid`, exactly as before.
		expect(source.out.track.peek()).toBe("mid");
		deliver(source, 10, (group) => group * 2000);
		await settle();
		expect(source.out.track.peek()).toBe("mid");
		source.close();
	});

	it("starts a costed ladder on the floor rather than the top rung", async () => {
		const source = new Source({ broadcast: mockBroadcast(ladder()), supported: async () => true });
		await settle();
		expect(source.out.track.peek()).toBe("low");
		source.close();
	});

	it("falls back to the preference rank when the renditions are not a ladder", async () => {
		const renditions = ladder();
		const source = new Source({
			broadcast: mockBroadcast({
				...renditions,
				high: config("avc1.640028", { codedWidth: 1920, codedHeight: 1080 }),
			}),
			supported: async () => true,
		});
		await settle();
		expect(source.out.track.peek()).toBe("high");
		source.observeGroup({ rendition: "high", epoch: 1, groups: 1, bytes: 0, mediaTime: 0, arrivedAt: 0 });
		await settle();
		expect(source.out.track.peek()).toBe("high");
		source.close();
	});

	it("climbs on on-schedule delivery and steps down on a whole group of backlog", async () => {
		const source = new Source({ broadcast: mockBroadcast(ladder()), supported: async () => true });
		await settle();

		const climb: string[] = [];
		for (let i = 0; i < 12 && source.out.track.peek() !== "high"; i++) {
			climb.push(...deliver(source, 3));
			await settle();
		}
		expect(climb[0]).toBe("low");
		expect(source.out.track.peek()).toBe("high");

		// Each keyframe arrives 600 ms later than the last: one group of backlog after two groups.
		deliver(source, 4, (group) => group * 600);
		await settle();
		expect(source.out.track.peek()).not.toBe("high");
		source.close();
	});

	it("reverts a switch whose target fails before it plays", async () => {
		const source = new Source({ broadcast: mockBroadcast(ladder()), supported: async () => true });
		await settle();
		for (let i = 0; i < 12 && source.out.track.peek() === "low"; i++) {
			deliver(source, 3);
			await settle();
		}
		const target = source.out.track.peek();
		expect(target).not.toBe("low");

		source.abandonRendition(target ?? "");
		await settle();
		expect(source.out.track.peek()).toBe("low");
		source.close();
	});

	it("honors a manual choice over the controller", async () => {
		const target = new Signal<{ name?: string } | undefined>(undefined);
		const source = new Source({ broadcast: mockBroadcast(ladder()), supported: async () => true, target });
		await settle();
		expect(source.out.track.peek()).toBe("low");
		target.set({ name: "mid" });
		await settle();
		expect(source.out.track.peek()).toBe("mid");
		// On-schedule delivery that would make a live controller probe upward.
		for (let i = 0; i < 4; i++) {
			deliver(source, 3);
			await settle();
		}
		expect(source.out.track.peek()).toBe("mid");

		// Releasing the choice restarts from the floor: nothing seen under it was ABR evidence.
		target.set(undefined);
		await settle();
		expect(source.out.track.peek()).toBe("low");
		source.close();
	});
});
