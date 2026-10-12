import { describe, expect, test } from "bun:test";
import { type Catalog, decode, encode } from "./catalog";
import { type Fec, FecSchema } from "./fec";
import type { AmtNetworkSource, Multicast, MulticastEndpoint } from "./multicast";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

// A minimal MMTP source track plus the repair track it names, as a publisher
// writes them. Individual tests override one field at a time. The schema types
// are applied here rather than inferred, so a fixture that drifts out of the
// contract is a compile error instead of a passing test.
const sourceFec: Fec = {
	algorithm: "raptorq",
	sourceSymbols: 4,
	repairSymbols: 2,
	symbolSize: 1320,
	interleaveDepthMs: 1000,
	blockProfile: "iso-ssbg1-v1",
	repairTrack: "video/1080p/repair",
	repairContainer: "native",
};

const mmtpTrack = {
	name: "video/1080p",
	packaging: "mmtp",
	mmtpMode: "mfu",
	timescale: 90_000,
	groupDurationMs: 1000,
	keyframeIntervalMs: 1000,
	isLive: true,
	role: "video",
	codec: "avc1.640028",
	fec: sourceFec,
};

const repairTrack = {
	name: "video/1080p/repair",
	packaging: "fec-repair",
	isLive: true,
	role: "repair",
	depends: ["video/1080p"],
	repairLayer: 0,
	repairSymbols: 2,
	priority: 240,
};

const catalogOf = (...tracks: unknown[]) => bytes({ version: 1, tracks });

describe("MMTP track fields", () => {
	test("an MMTP source track survives decode with every field intact", () => {
		const [track] = decode(catalogOf(mmtpTrack)).tracks;

		expect(track.packaging).toBe("mmtp");
		expect(track.mmtpMode).toBe("mfu");
		expect(track.timescale).toBe(90_000);
		expect(track.groupDurationMs).toBe(1000);
		expect(track.keyframeIntervalMs).toBe(1000);
		expect(track.fec).toEqual(mmtpTrack.fec);
	});

	// The regression this file exists for. Before the MMTP fields were modelled,
	// `z.object` stripped every one of them on decode and the track came back as
	// a bare name/packaging pair -- no error, no warning, just absent geometry.
	test("MMTP fields are modelled, not stripped as unknown keys", () => {
		const [track] = decode(catalogOf(mmtpTrack)).tracks;

		for (const field of ["mmtpMode", "timescale", "groupDurationMs", "keyframeIntervalMs", "fec"]) {
			expect(field in track).toBe(true);
		}
	});

	test("an MMTP track round-trips through encode and decode unchanged", () => {
		const once = decode(catalogOf(mmtpTrack, repairTrack));
		const twice = decode(encode(once));

		expect(twice).toEqual(once);
	});

	test("groupDurationTicks carries the exact cadence a millisecond cannot", () => {
		// 1001/30000 fps over 30 frames: 1001 ticks exactly, 33.3666... ms.
		const [track] = decode(catalogOf({ ...mmtpTrack, groupDurationTicks: 1001 })).tracks;

		expect(track.groupDurationTicks).toBe(1001);
	});

	test("a non-integer or non-positive timescale is refused", () => {
		for (const timescale of [0, -90_000, 90_000.5]) {
			expect(() => decode(catalogOf({ ...mmtpTrack, timescale }))).toThrow();
		}
	});

	test("a non-positive group duration is refused in either denomination", () => {
		expect(() => decode(catalogOf({ ...mmtpTrack, groupDurationMs: 0 }))).toThrow();
		expect(() => decode(catalogOf({ ...mmtpTrack, groupDurationTicks: -1 }))).toThrow();
	});

	// Upstream's packaging union already accepts any string, so "mmtp" needed no
	// schema change to parse. Naming it in the enum arm is documentation; this
	// pins that adding it did not accidentally close the union.
	test("an unrecognized packaging string still parses", () => {
		const [track] = decode(catalogOf({ ...mmtpTrack, packaging: "something-later" })).tracks;

		expect(track.packaging).toBe("something-later");
	});
});

describe("FEC block geometry", () => {
	// The inverse of `depends`, bounded the same way: absence is the one spelling
	// of "no repair track", so `""` is not a second one.
	test("an empty repairTrack is refused", () => {
		expect(decode(catalogOf(mmtpTrack)).tracks[0].fec?.repairTrack).toBe("video/1080p/repair");
		expect(() => decode(catalogOf({ ...mmtpTrack, fec: { ...sourceFec, repairTrack: "" } }))).toThrow();
	});

	test("an unrecognized algorithm is refused", () => {
		expect(() => decode(catalogOf({ ...mmtpTrack, fec: { algorithm: "turbo" } }))).toThrow();
	});

	// `"none"` means absent FEC, not an unrecognized code, and a zero repair count
	// is how a publisher says so. Refusing it would reject a valid catalog.
	test("algorithm none with zero repair symbols is valid", () => {
		const [track] = decode(catalogOf({ ...mmtpTrack, fec: { algorithm: "none", repairSymbols: 0 } })).tracks;

		expect(track.fec).toEqual({ algorithm: "none", repairSymbols: 0 });
	});

	// The profile decides repair-symbol ESI arithmetic, so a token this build does
	// not know must reach the decoder that does. Rejecting it here would refuse a
	// catalog a newer receiver handles; defaulting it would silently pick the
	// wrong arithmetic.
	test("an unknown blockProfile is carried verbatim, never rejected or defaulted", () => {
		for (const blockProfile of ["k-padded-v1", "iso-ssbg1-v1", "k-padded-v2", 7]) {
			const [track] = decode(catalogOf({ ...mmtpTrack, fec: { ...mmtpTrack.fec, blockProfile } })).tracks;
			expect(track.fec?.blockProfile).toEqual(blockProfile);
		}
	});

	test("an absent blockProfile is never defaulted", () => {
		const { blockProfile: _dropped, ...fec } = mmtpTrack.fec;
		const [track] = decode(catalogOf({ ...mmtpTrack, fec })).tracks;

		expect(track.fec && "blockProfile" in track.fec).toBe(false);
	});

	// K is the block partition, so 0 is not a degenerate case -- it is not a
	// partition at all -- and the ceiling is the 24-bit space the symbols are
	// addressed in. Both bounds hold for every algorithm. The tighter RaptorQ
	// ceiling of 56403 is deliberately NOT applied here: a source track may be
	// reed-solomon, ldpc or xor, for which that number means nothing, so libmmt's
	// validator applies it conditionally on the algorithm. The overlay's own K is
	// the opposite case and is covered separately below.
	test("a source track's K is at least 1 and fits the 24-bit symbol space", () => {
		const fecWith = (sourceSymbols: number) => ({ ...mmtpTrack.fec, sourceSymbols });

		expect(decode(catalogOf({ ...mmtpTrack, fec: fecWith(1) })).tracks[0].fec?.sourceSymbols).toBe(1);
		expect(decode(catalogOf({ ...mmtpTrack, fec: fecWith(16_777_215) })).tracks[0].fec?.sourceSymbols).toBe(
			16_777_215,
		);
		for (const sourceSymbols of [0, -1, 1.5, 16_777_216]) {
			expect(() => decode(catalogOf({ ...mmtpTrack, fec: fecWith(sourceSymbols) }))).toThrow();
		}
	});

	// A non-RaptorQ source track is not held to RaptorQ's source-block limit.
	// This is the control for the test above: it fails if the 56403 cap is ever
	// applied unconditionally to a source track's K.
	test("a non-raptorq source track accepts a K above the RaptorQ limit", () => {
		const fec = { algorithm: "reed-solomon", sourceSymbols: 56_404 };
		const [track] = decode(catalogOf({ ...mmtpTrack, fec })).tracks;

		expect(track.fec?.sourceSymbols).toBe(56_404);
	});

	// A source track's P is its layer 0's repair count, the same number that
	// layer's repair track declares, so it shares that track's 24-bit ceiling.
	// The floor stays 0: zero is how a source says it has no FEC.
	test("a source track's P fits the 24-bit symbol space", () => {
		const fecWith = (repairSymbols: number) => ({ ...mmtpTrack.fec, repairSymbols });

		expect(decode(catalogOf({ ...mmtpTrack, fec: fecWith(16_777_215) })).tracks[0].fec?.repairSymbols).toBe(
			16_777_215,
		);
		for (const repairSymbols of [-1, 1.5, 16_777_216]) {
			expect(() => decode(catalogOf({ ...mmtpTrack, fec: fecWith(repairSymbols) }))).toThrow();
		}
	});

	// T is the divisor in block arithmetic, so `0` is a division by zero one layer
	// down rather than a degenerate symbol. Unlike K and P there is no ceiling:
	// no wire field addresses T, so there is no width to bound it to.
	test("a zero symbol size is refused and a large one is not", () => {
		const fecWith = (symbolSize: number) => ({ ...mmtpTrack.fec, symbolSize });

		for (const symbolSize of [0, -1, 1.5]) {
			expect(() => decode(catalogOf({ ...mmtpTrack, fec: fecWith(symbolSize) }))).toThrow();
		}
		expect(decode(catalogOf({ ...mmtpTrack, fec: fecWith(1) })).tracks[0].fec?.symbolSize).toBe(1);
		expect(decode(catalogOf({ ...mmtpTrack, fec: fecWith(16_777_216) })).tracks[0].fec?.symbolSize).toBe(
			16_777_216,
		);
	});

	// `"native"` is the only repair container. A repair flow carried some other
	// way must fail closed rather than be joined and found unusable.
	test("a non-native repairContainer is refused", () => {
		expect(() => decode(catalogOf({ ...mmtpTrack, fec: { repairContainer: "mmtp" } }))).toThrow();
	});

	test("interleaveDepthMs is the only interleave field", () => {
		// The input carries a unit-denominated `interleaveDepth` beside it. It is
		// carried verbatim (`fec` is loose) but never modelled: a second interleave
		// field would let two readers of the same stream derive different spans.
		const [track] = decode(catalogOf({ ...mmtpTrack, fec: { ...sourceFec, interleaveDepth: 4 } })).tracks;

		expect(track.fec?.interleaveDepthMs).toBe(1000);
		// Positive anchor: without it the negative assertion below passes vacuously if `.shape` is empty.
		expect(Object.keys(FecSchema.shape)).toContain("interleaveDepthMs");
		expect(Object.keys(FecSchema.shape)).not.toContain("interleaveDepth");
		expect((track.fec as Record<string, unknown>).interleaveDepth).toBe(4);
	});

	// Compared against the RAW source for the reason the multicast test is: a
	// member stripped by a first decode is absent from both sides of
	// decode(encode(once)), so only the raw input can catch stripping.
	test("unmodelled fec and alta members survive a round trip byte-for-byte", () => {
		const fec = { ...sourceFec, overhead: 0.2 };
		const alta = { publicKey: "MCowBQYDK2VwAyEA", algorithm: "ed25519" };
		const decoded = decode(catalogOf({ ...mmtpTrack, fec, alta }));
		const reencoded = JSON.parse(new TextDecoder().decode(encode(decoded)));

		expect(reencoded.tracks[0].fec).toEqual(fec);
		expect(reencoded.tracks[0].alta).toEqual(alta);
	});

	test("a modelled fec field is still validated when the object is loose", () => {
		expect(() => decode(catalogOf({ ...mmtpTrack, fec: { ...sourceFec, symbolSize: 0 } }))).toThrow();
	});
});

describe("repair tracks", () => {
	test("a repair track's self-describing fields survive decode", () => {
		const [, track] = decode(catalogOf(mmtpTrack, repairTrack)).tracks;

		expect(track.depends).toEqual(["video/1080p"]);
		expect(track.repairLayer).toBe(0);
		expect(track.repairSymbols).toBe(2);
		expect(track.priority).toBe(240);
	});

	// A repair track that claimed two sources would have no single partition to
	// share, and one that claimed none could not be placed.
	test("depends names exactly one source", () => {
		for (const depends of [[], ["a", "b"], [""]]) {
			expect(() => decode(catalogOf({ ...repairTrack, depends }))).toThrow();
		}
	});

	test("a keyframe overlay declares its own K", () => {
		const overlay = { ...repairTrack, scope: "keyframe", sourceSymbols: 2 };
		const [track] = decode(catalogOf(overlay)).tracks;

		expect(track.scope).toBe("keyframe");
		expect(track.sourceSymbols).toBe(2);
	});

	// An unrecognized scope must fail closed rather than degrade to a base layer,
	// which would put the overlay's symbols in the base layer's ID space.
	test("an unrecognized scope is refused", () => {
		expect(() => decode(catalogOf({ ...repairTrack, scope: "group" }))).toThrow();
	});

	test("K above RaptorQ's maximum is refused", () => {
		expect(() => decode(catalogOf({ ...repairTrack, sourceSymbols: 56_404 }))).toThrow();
		expect(decode(catalogOf({ ...repairTrack, sourceSymbols: 56_403 })).tracks[0].sourceSymbols).toBe(56_403);
	});

	test("priority stays inside the MoQT byte", () => {
		expect(() => decode(catalogOf({ ...repairTrack, priority: 256 }))).toThrow();
		expect(() => decode(catalogOf({ ...repairTrack, priority: -1 }))).toThrow();
	});
});

describe("multicast", () => {
	const endpoint: MulticastEndpoint = {
		protocol: "udp",
		sourceAddress: "203.0.113.1",
		groupAddress: "232.0.0.1",
		port: 5000,
		tracks: [
			{ name: "video/1080p", packetId: 1 },
			{ name: "audio/main", packetId: 2 },
		],
		bandwidth: 5_000_000,
	};

	const multicast: Multicast = {
		endpoints: [endpoint],
		networkSource: [{ type: "amt", discovery: "driad", relay: "amt-relay.example.net", port: 2268 }],
	};

	const withMulticast = (section: unknown) => bytes({ version: 1, tracks: [mmtpTrack], multicast: section });

	test("the multicast section survives a decode/encode round trip", () => {
		const once = decode(withMulticast(multicast));

		expect(once.multicast).toEqual(multicast);
		expect(decode(encode(once))).toEqual(once);
	});

	// packet_id 0 is the MMTP signaling flow, which carries the AL-FEC signaling
	// message into the same group as the media. Admitting it as a track's would
	// not merely mislabel one track: an empty packet-ID filter means "no filter",
	// so a receiver that accepted 0 would widen its join to every packet ID.
	test("packet_id 0 is the signaling flow and is refused", () => {
		const tracks = [{ name: "video/1080p", packetId: 0 }];
		expect(() => decode(withMulticast({ endpoints: [{ ...endpoint, tracks }] }))).toThrow();
	});

	test("the packet_id range is 1 to 65535", () => {
		const at = (packetId: number) =>
			withMulticast({ endpoints: [{ ...endpoint, tracks: [{ name: "v", packetId }] }] });

		expect(decode(at(1)).multicast?.endpoints?.[0].tracks[0].packetId).toBe(1);
		expect(decode(at(65_535)).multicast?.endpoints?.[0].tracks[0].packetId).toBe(65_535);
		for (const packetId of [65_536, -1, 1.5]) {
			expect(() => decode(at(packetId))).toThrow();
		}
	});

	// The group address and port are the two fields a receiver actually joins on.
	// They were the last unbounded ones in a section whose stated purpose is to
	// enforce the join parameters rather than merely carry them.
	test("the multicast port range is 1 to 65535", () => {
		const at = (port: unknown) => withMulticast({ endpoints: [{ ...endpoint, port }] });

		expect(decode(at(1)).multicast?.endpoints?.[0].port).toBe(1);
		expect(decode(at(65_535)).multicast?.endpoints?.[0].port).toBe(65_535);
		for (const port of [0, -1, 1.5, 65_536, 70_000]) {
			expect(() => decode(at(port))).toThrow();
		}
	});

	// An endpoint naming no track contributes no packet IDs, and an empty filter
	// means "no filter", so it would widen the join exactly as packet_id 0 would.
	test("an endpoint naming no track is refused", () => {
		expect(decode(withMulticast({ endpoints: [endpoint] })).multicast?.endpoints?.[0].tracks).toHaveLength(2);
		expect(() => decode(withMulticast({ endpoints: [{ ...endpoint, tracks: [] }] }))).toThrow();
	});

	test("bandwidth is a positive integer", () => {
		const at = (bandwidth: unknown) => withMulticast({ endpoints: [{ ...endpoint, bandwidth }] });

		expect(decode(at(1)).multicast?.endpoints?.[0].bandwidth).toBe(1);
		for (const bandwidth of [0, -1, 1.5, 1e-9]) {
			expect(() => decode(at(bandwidth))).toThrow();
		}
	});

	test("an empty group or source address is refused", () => {
		expect(() => decode(withMulticast({ endpoints: [{ ...endpoint, groupAddress: "" }] }))).toThrow();
		expect(() => decode(withMulticast({ endpoints: [{ ...endpoint, sourceAddress: "" }] }))).toThrow();
	});

	test("a bare networkSource object is accepted beside the array form", () => {
		const bare: AmtNetworkSource = { type: "amt", relay: "amt-relay.example.net" };
		const decoded = decode(withMulticast({ networkSource: bare }));

		expect(decoded.multicast?.networkSource).toEqual(bare);
	});

	// An under-specified AMT entry must degrade to a defined join rather than to
	// an unsatisfiable tunnel: a missing port resolves to the RFC 7450 well-known
	// one at the consumer, and a DRIAD entry leaves the relay to discovery.
	test("an AMT source naming neither relay nor port is valid", () => {
		const decoded = decode(withMulticast({ networkSource: [{ type: "amt", discovery: "driad" }] }));

		expect(decoded.multicast?.networkSource).toEqual([{ type: "amt", discovery: "driad" }]);
	});

	// A delivery path this build does not model is carried, not refused: refusing
	// it would cost the receiver the whole catalog, unicast renditions included.
	test("an unrecognized network source type is carried with its members", () => {
		const satellite = { type: "satellite", transponder: 12 };
		const decoded = decode(withMulticast({ networkSource: [satellite] }));

		expect(decoded.tracks).toHaveLength(1);
		expect(decoded.multicast?.networkSource).toEqual([satellite]);
	});

	// The unknown arm must not become an escape hatch for a known type that fails
	// its own schema -- otherwise every AMT/ATSC bound would be silently void.
	test("a known network source type failing its schema does not fall through", () => {
		expect(() => decode(withMulticast({ networkSource: [{ type: "amt", port: 70_000 }] }))).toThrow();
		expect(() => decode(withMulticast({ networkSource: { type: "amt", port: 0 } }))).toThrow();
		expect(() => decode(withMulticast({ networkSource: [{ type: "atsc3", plpId: 64 }] }))).toThrow();
		expect(() => decode(withMulticast({ networkSource: [{ type: "atsc3", serviceId: 1.5 }] }))).toThrow();
		expect(() => decode(withMulticast({ networkSource: [{ type: "atsc3", frequency: -1 }] }))).toThrow();
	});

	// An under-specified ATSC 3.0 entry degrades like an AMT one: carried, with
	// the consumer deciding whether it is tunable, never refusing every track.
	test("an ATSC 3.0 source missing its tuning fields is carried", () => {
		const decoded = decode(withMulticast({ networkSource: [{ type: "atsc3", serviceId: 5004 }] }));

		expect(decoded.tracks).toHaveLength(1);
		expect(decoded.multicast?.networkSource).toEqual([{ type: "atsc3", serviceId: 5004 }]);
	});

	// Compared against the RAW source, not against a first decode: a member
	// stripped by that decode would be absent from both sides of a
	// decode(encode(once)) comparison, so only the raw bytes can catch stripping.
	test("unmodelled multicast members survive a round trip byte-for-byte", () => {
		const raw = {
			endpoints: [
				{
					...endpoint,
					ttl: 32,
					tracks: [{ name: "video/1080p", packetId: 1, layer: "base" }],
				},
			],
			networkSource: [
				{ type: "amt", relay: "amt-relay.example.net", anycast: true },
				{ type: "atsc3", frequency: 593, plpId: 0, serviceId: 5004, slsUri: "x", bsid: 7 },
				{ type: "satellite", transponder: 12 },
			],
			fallbackUrl: "https://example.net/live",
		};

		const reencoded = JSON.parse(new TextDecoder().decode(encode(decode(withMulticast(raw)))));

		expect(reencoded.multicast).toEqual(raw);
	});

	// `multicast` is a modelled root field, so it must not also be copied into the
	// untyped extension map -- a reader taking the `ext` copy would bypass the
	// packet-ID range this schema enforces.
	test("multicast does not leak into the extension map", () => {
		expect(decode(withMulticast(multicast)).ext).toBeUndefined();
	});

	test("an extension member named multicast is refused on encode", () => {
		const catalog = { tracks: [], ext: { multicast: {} } } as unknown as Catalog;

		expect(() => encode(catalog)).toThrow(/collides with a reserved root field/);
	});
});
