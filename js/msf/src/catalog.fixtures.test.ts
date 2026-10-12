import { describe, expect, test } from "bun:test";
import { decode, encode } from "./catalog";

// The moqcast-native-v16 conformance catalogs, copied verbatim from this
// repository's `main` branch at
// `rs/moq-msf/tests/fixtures/moqcast-native-v16-v{1..5}/catalog.json`, so this
// schema is checked against catalogs it did not author. They are the wire shape
// a publisher actually emits, which is the only thing that makes this a
// compatibility test rather than a self-consistency one -- a fixture
// regenerated from this schema would pass no matter what the schema did.
//
// That claim reaches the track geometry and stops there: none of these fixtures
// carries a root `multicast` section, so the multicast schema is checked only
// against the hand-written catalogs in `catalog.mmtp.test.ts`.
//
// That path is absent from this branch, not from the repository: this branch is
// a fresh cut from moq-dev `main` and carries none of the Blockcast fixture
// bundle. Check the provenance against `main`, where `rs/moq-msf-fixtures` and
// `rs/moq-msf/tests/verify_moqcast_fixtures.py` own these files; checking it
// against this branch will find nothing and prove nothing.
//
// Upstream ships five fixture directories but only FOUR distinct catalogs: v1
// and v2 share one byte-for-byte, git blob 1036c611. They are a pair that holds
// the catalog constant and varies the MoQT control-plane wire (their
// `manifest.json` vectors differ in the SUBSCRIBE/FETCH encodings --
// `catalog-discovery`, `media-late-join`, `repair-fetch`,
// `reconnect-resubscribe`, `truncated-control`). This schema models the catalog
// and not the control plane, so loading v2 here would assert the same bytes
// twice and cover nothing. It is deliberately absent rather than missing.
//
// The four differ in what they say about the repair tracks and the FEC profile:
//
//   v1  repair tracks declare the retired `packaging: "condensed"`
//   v3  the same tracks on the current `packaging: "fec-repair"`
//   v4  as v3, with the repair tracks' timing fields omitted
//   v5  as v4, with `fec.blockProfile` present on the source tracks
const FIXTURES = ["v1", "v3", "v4", "v5"] as const;

const load = async (name: string) =>
	new Uint8Array(await Bun.file(`${import.meta.dir}/../test-vectors/moqcast-native-v16-${name}.json`).arrayBuffer());

describe("moqcast-native-v16 catalogs", () => {
	for (const name of FIXTURES) {
		test(`${name} parses and keeps its MMTP geometry`, async () => {
			const catalog = decode(await load(name));

			const source = catalog.tracks.find((track) => track.name === "video/1080p");
			expect(source?.packaging).toBe("mmtp");
			expect(source?.mmtpMode).toBe("mfu");
			expect(source?.timescale).toBe(90_000);
			expect(source?.keyframeIntervalMs).toBe(1000);
			expect(source?.fec).toMatchObject({
				algorithm: "raptorq",
				sourceSymbols: 4,
				repairSymbols: 2,
				symbolSize: 1320,
				interleaveDepthMs: 1000,
				repairTrack: "video/1080p/repair",
				repairContainer: "native",
			});

			// Every source names a repair track, and that track is in the catalog.
			for (const track of catalog.tracks) {
				if (track.fec?.repairTrack === undefined) continue;
				expect(catalog.tracks.some((other) => other.name === track.fec?.repairTrack)).toBe(true);
			}
		});

		test(`${name} round-trips through encode and decode`, async () => {
			const once = decode(await load(name));

			expect(decode(encode(once))).toEqual(once);
		});
	}

	// v1 predates the `fec-repair` packaging name. Upstream's packaging union
	// accepts any string, so it still parses -- the retired name must not become a
	// parse failure, because a publisher that has not yet been updated is still
	// serving real media.
	test("the retired `condensed` repair packaging still parses", async () => {
		const catalog = decode(await load("v1"));
		const repair = catalog.tracks.find((track) => track.name === "video/1080p/repair");

		expect(repair?.packaging).toBe("condensed");
		expect(repair?.role).toBe("repair");
	});

	test("v3 onward carry the current `fec-repair` packaging", async () => {
		for (const name of ["v3", "v4", "v5"]) {
			const catalog = decode(await load(name));

			expect(catalog.tracks.find((track) => track.name === "video/1080p/repair")?.packaging).toBe("fec-repair");
		}
	});

	// v4 drops `timescale` and `groupDurationMs` from the repair tracks. Absent
	// must stay absent: a repair track inheriting its source's timing would be a
	// value the catalog never stated.
	test("v4's repair tracks keep their timing absent rather than defaulted", async () => {
		const repair = decode(await load("v4")).tracks.find((track) => track.name === "video/1080p/repair");

		expect(repair).toBeDefined();
		expect("timescale" in (repair ?? {})).toBe(false);
		expect("groupDurationMs" in (repair ?? {})).toBe(false);
	});

	test("only v5 declares a blockProfile, and it is carried verbatim", async () => {
		for (const name of FIXTURES) {
			const source = decode(await load(name)).tracks.find((track) => track.name === "video/1080p");

			expect(source?.fec?.blockProfile).toBe(name === "v5" ? "k-padded-v1" : undefined);
		}
	});
});
