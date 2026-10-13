import { describe, expect, test } from "bun:test";
import { AbrController, type AbrDecision, buildAbrLadder, decideRendition, GroupEstimator } from "./abr";

// Comparative vectors from BLO-45475 (moqtail reliable-abr @ e7f31acd vs upstream Source#runSelected).
// Ladder 0.5/1.5/4 Mbps; the live encoder fills 90% of the catalog bitrate. Delivery is ordered: group g
// finishes at max(produced, start + bits / capacity), and the next group's keyframe arrives then.
const RUNGS: Record<string, number> = { low: 500_000, mid: 1_500_000, high: 4_000_000 };
const FILL = 0.9;

type Trace = {
	name: string;
	groups: number;
	capacityKbps: (group: number) => number;
	// Authored group duration in ms; constant unless a test varies it.
	span?: (group: number) => number;
};

const TRACES: Trace[] = [
	{ name: "steady-headroom-10M", groups: 20, capacityKbps: () => 10_000 },
	{ name: "steady-2M", groups: 20, capacityKbps: () => 2_000 },
	{ name: "drop-10M-to-1M@g8", groups: 24, capacityKbps: (g) => (g < 8 ? 10_000 : 1_000) },
	{ name: "dip-1M-g6..g9-then-10M", groups: 30, capacityKbps: (g) => (g >= 6 && g < 10 ? 1_000 : 10_000) },
	{ name: "persistent-3M", groups: 40, capacityKbps: () => 3_000 },
];

// MOQtail's lane (M) on the same traces, from the vectors document revision 2. With a constant GOP the
// measured span equals MOQtail's catalog group duration, so the paths must match exactly.
const MOQTAIL_PATHS: Record<string, string> = {
	"steady-headroom-10M": "LLMMHHHHHHHHHHHHHHHH",
	"steady-2M": "LLMMHHHMMMHHHMMMMHHH",
	"drop-10M-to-1M@g8": "LLMMHHHHHMMMMLLLLMMMMLLL",
	"dip-1M-g6..g9-then-10M": "LLMMHHHMMMMHHHHHHHHHHHHHHHHHHH",
	"persistent-3M": "LLMMHHHHHHMMMHHHHHHMMMMHHHHHHMMMMMMHHHHH",
};

// Upstream with no PROBE estimate (UN lane) stays on the top rung; its worst lag on each trace.
const NO_PROBE_UPSTREAM_LAG_MS: Record<string, number> = {
	"steady-headroom-10M": 0,
	"steady-2M": 32_000,
	"drop-10M-to-1M@g8": 83_200,
	"dip-1M-g6..g9-then-10M": 20_800,
	"persistent-3M": 16_000,
};

function run(trace: Trace, decide?: (controller: AbrController) => void) {
	const ladder = buildAbrLadder(Object.entries(RUNGS).map(([name, bitrate]) => ({ name, bitrate })));
	if (!ladder) throw new Error("ladder");
	const controller = new AbrController(ladder);
	decide?.(controller);

	let rendition = controller.initial;
	let epoch = 0;
	let bytes = 0;
	let groups = 0;
	let at = 0;
	let produced = 0;
	let maxLag = 0;
	const path: string[] = [];
	const decisions: AbrDecision[] = [];

	for (let g = 0; g < trace.groups; g++) {
		const span = trace.span?.(g) ?? 2000;
		const bits = (RUNGS[rendition] / 1000) * FILL * span;
		const start = Math.max(at, produced);
		produced += span;
		at = Math.max(produced, start + bits / trace.capacityKbps(g));
		maxLag = Math.max(maxLag, at - produced);
		bytes += Math.round(bits / 8);
		groups += 1;
		path.push(rendition);

		// The next group's keyframe, authored at `produced`, arrives once this group has drained.
		const decision = controller.observe({
			rendition,
			epoch,
			groups,
			bytes,
			mediaTime: produced,
			arrivedAt: Math.round(at),
		});
		if (decision) {
			controller.settle(decision, true);
			decisions.push(decision);
			rendition = decision.target;
			epoch += 1;
			bytes = 0;
			groups = 0;
		}
	}

	return { path: path.map((name) => name[0].toUpperCase()).join(""), maxLag: Math.round(maxLag), decisions };
}

describe("AbrController vectors", () => {
	for (const trace of TRACES) {
		test(`${trace.name}: matches MOQtail and bounds lag`, () => {
			const { path, maxLag } = run(trace);
			expect(path).toBe(MOQTAIL_PATHS[trace.name]);
			// Never worse than the top-rung default, and bounded to a few groups.
			expect(maxLag).toBeLessThanOrEqual(NO_PROBE_UPSTREAM_LAG_MS[trace.name]);
			expect(maxLag).toBeLessThan(10_000);
		});
	}

	test("starts on the floor", () => {
		expect(run(TRACES[0]).path[0]).toBe("L");
	});

	test("measures the group span from authored timestamps, not a constant", () => {
		// A 1 Mbps path with a GOP alternating 1 s / 3 s. No catalog field states either value.
		const { path, maxLag, decisions } = run({
			name: "variable-gop-1M",
			groups: 30,
			capacityKbps: () => 1_000,
			span: (g) => (g % 2 === 0 ? 1000 : 3000),
		});
		expect(decisions.some((d) => d.direction === "down")).toBe(true);
		expect(path.endsWith("L")).toBe(true);
		expect(maxLag).toBeLessThan(10_000);
	});

	test("backoff escalates on a bottleneck between rungs", () => {
		const { decisions } = run(TRACES[4]);
		const downs = decisions.filter((d) => d.direction === "down");
		expect(downs.length).toBeGreaterThanOrEqual(3);
		for (const d of downs) expect(d.probeCeilingKbps).toBe(3000);
	});
});

describe("buildAbrLadder", () => {
	test("needs two costed rungs", () => {
		expect(buildAbrLadder([{ name: "a", bitrate: 1 }])).toBeNull();
		expect(buildAbrLadder([{ name: "a", bitrate: 1 }, { name: "b" }])).toBeNull();
		expect(
			buildAbrLadder([
				{ name: "a", bitrate: 1 },
				{ name: "b", bitrate: 0 },
			]),
		).toBeNull();
		expect(
			buildAbrLadder([
				{ name: "a", bitrate: 1 },
				{ name: "a", bitrate: 2 },
			]),
		).toBeNull();
		expect(
			buildAbrLadder([
				{ name: "b", bitrate: 2000 },
				{ name: "a", bitrate: 1000 },
			])?.map((r) => r.name),
		).toEqual(["a", "b"]);
	});
});

describe("GroupEstimator", () => {
	const at = (groups: number, mediaTime: number, arrivedAt: number, bytes = groups * 100) => ({
		rendition: "a",
		epoch: 0,
		groups,
		bytes,
		mediaTime,
		arrivedAt,
	});

	test("backlog is arrival lag behind authored time", () => {
		const estimator = new GroupEstimator();
		expect(estimator.observe(at(1, 2000, 2000))).toBeNull();
		expect(estimator.observe(at(2, 4000, 5000))?.backlog).toBe(1000);
		const sample = estimator.observe(at(3, 5000, 7000));
		expect(sample?.backlog).toBe(2000);
		expect(sample?.groupSpan).toBe(1000);
	});

	test("a timestamp regression resets the baseline", () => {
		const estimator = new GroupEstimator();
		estimator.observe(at(1, 2000, 2000));
		estimator.observe(at(2, 4000, 9000));
		expect(estimator.observe(at(3, 3000, 9500))).toBeNull();
	});

	test("a new epoch resets the baseline", () => {
		const estimator = new GroupEstimator();
		estimator.observe(at(1, 2000, 2000));
		expect(estimator.observe({ ...at(2, 4000, 4000), epoch: 1 })).toBeNull();
	});
});

describe("decideRendition", () => {
	const ladder = buildAbrLadder(Object.entries(RUNGS).map(([name, bitrate]) => ({ name, bitrate })));
	if (!ladder) throw new Error("ladder");
	const sample = {
		rendition: "high",
		groupSpan: 2000,
		groupsObserved: 2,
		span: 4000,
		backlog: 2000,
		backlogGrowth: 1000,
		windowRateKbps: 1000,
		congestedRateKbps: 1600,
	};

	test("one group of backlog steps down to the rung the drained rate carries", () => {
		expect(decideRendition({ ladder, active: "high", sample, probeCeilingKbps: null })).toMatchObject({
			target: "mid",
			direction: "down",
		});
	});

	test("less than one group of backlog does not step down", () => {
		expect(
			decideRendition({ ladder, active: "high", sample: { ...sample, backlog: 1999 }, probeCeilingKbps: null }),
		).toBeNull();
	});

	test("a refutation gates the probe", () => {
		const onSchedule = { ...sample, rendition: "mid", backlog: 0, backlogGrowth: 0, windowRateKbps: 1350 };
		expect(decideRendition({ ladder, active: "mid", sample: onSchedule, probeCeilingKbps: null })?.reason).toBe(
			"probe",
		);
		expect(decideRendition({ ladder, active: "mid", sample: onSchedule, probeCeilingKbps: 3000 })).toBeNull();
	});
});
