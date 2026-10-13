/**
 * Rendition selection for a receiver with no PROBE capacity estimate.
 *
 * Adapted from MOQtail's reliable-leg controller
 * (`apps/client-js/src/lib/reliable-abr.ts`, Copyright 2026 The MOQtail Authors,
 * Apache-2.0). The decision rules are unchanged; what differs is where the group
 * duration comes from. MOQtail reads it from its catalog. The hang catalog carries
 * no group duration, so here every bound is the authored timestamp span between
 * the two most recent group starts (keyframes), which the wire states exactly.
 *
 * Evidence model. On a live subscription the producer sends at the rendition's own
 * rate, so a receive rate measures the stream, not the path: it converges on the
 * rung's encoded rate however much headroom the link has.
 *
 * - A receive rate below the rung's catalog bitrate is not evidence of shortfall
 *   (encoders routinely undershoot). The shortfall signal is backlog: delivery is
 *   ordered, so when the path cannot carry the rung, group starts arrive later and
 *   later relative to their authored timestamps. One whole group of backlog steps
 *   down.
 * - A delivered rate is a lower bound on capacity. When it reaches a higher rung's
 *   bitrate that rung is proven carriable; otherwise the only way to learn about
 *   headroom is to try the next rung.
 *
 * A step-down refutes the rate the path drained at, and that refutation gates
 * probes for a run of on-schedule group starts: one group after the first
 * refutation, doubling with each consecutive one (binary exponential backoff, as
 * RFC 9002 section 6.2.1 applies to QUIC's probe timeout). It is cleared by a
 * keeping-pace window that delivers more than the refuted rate.
 *
 * There are no timers. The caller feeds one observation per group start.
 */

export type AbrRung = Readonly<{
	name: string;
	bitrateKbps: number;
}>;

export type AbrRungInput = Readonly<{
	name: string;
	/** Catalog bitrate in bits per second. */
	bitrate?: number | null;
}>;

/** Observed at the arrival of a group's first frame (its keyframe). */
export type GroupObservation = Readonly<{
	rendition: string;
	/** Changes whenever the subscription restarts; a new epoch resets the baseline. */
	epoch: number;
	/** Group starts seen on this subscription, including this one. */
	groups: number;
	/** Payload bytes received on this subscription before this group's first frame. */
	bytes: number;
	/** Authored presentation timestamp of the group's first frame, in milliseconds. */
	mediaTime: number;
	/** Wall-clock arrival time of the group's first frame, in milliseconds. */
	arrivedAt: number;
}>;

export type GroupSample = Readonly<{
	rendition: string;
	/** Authored span of the group that just completed: the one-group bound. */
	groupSpan: number;
	/** Group starts observed since the anchor. */
	groupsObserved: number;
	/** Wall time from the anchor to this group start. */
	span: number;
	/** Lag behind the best delivery schedule observed since the reset. */
	backlog: number;
	/** Backlog change across the trailing whole-group window; null until one exists. */
	backlogGrowth: number | null;
	/** Delivered rate over the trailing window of at least one group; null until one exists. */
	windowRateKbps: number | null;
	/** Delivered rate since the best-schedule point: the path's rate while backlogged. */
	congestedRateKbps: number | null;
}>;

export type AbrDecision =
	| Readonly<{
			target: string;
			direction: "down";
			reason: "backlog";
			/** Rungs at or above this rate are not probed while the refutation holds. */
			probeCeilingKbps: number;
	  }>
	| Readonly<{
			target: string;
			direction: "up";
			reason: "capacity" | "probe";
			/** Rungs at or above this rate are not probed; null when nothing is refuted. */
			probeCeilingKbps: number | null;
	  }>;

/**
 * The ladder, lowest bitrate first. Null unless at least two renditions each carry a
 * positive catalog bitrate: a rung without a cost cannot be placed, and a
 * partially-costed ladder is not a ladder.
 */
export function buildAbrLadder(inputs: readonly AbrRungInput[]): readonly AbrRung[] | null {
	if (inputs.length < 2) return null;
	const rungs: AbrRung[] = [];
	for (const { name, bitrate } of inputs) {
		if (typeof bitrate !== "number" || !Number.isFinite(bitrate) || bitrate <= 0) return null;
		rungs.push(Object.freeze({ name, bitrateKbps: bitrate / 1000 }));
	}
	if (new Set(rungs.map((rung) => rung.name)).size !== rungs.length) return null;
	rungs.sort((a, b) => a.bitrateKbps - b.bitrateKbps);
	return Object.freeze(rungs);
}

type Point = { groups: number; at: number; bytes: number; backlog: number };

/**
 * Backlog and delivered-rate estimation from successive group starts of one
 * subscription. The baseline resets on a new rendition or epoch, and on any
 * regression in the counters or timestamps.
 */
export class GroupEstimator {
	#identity: { rendition: string; epoch: number } | null = null;
	#points: Point[] = [];
	#anchor: Point | null = null;
	#lastMediaTime: number | null = null;
	/** Best (earliest) schedule offset `arrivedAt - mediaTime` seen since reset. */
	#base: { offset: number; at: number; bytes: number } | null = null;

	reset(): void {
		this.#identity = null;
		this.#points = [];
		this.#anchor = null;
		this.#lastMediaTime = null;
		this.#base = null;
	}

	observe(observation: GroupObservation): GroupSample | null {
		const { groups, bytes, mediaTime, arrivedAt: at } = observation;
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			!Number.isSafeInteger(groups) ||
			groups < 0 ||
			!Number.isFinite(mediaTime) ||
			!Number.isFinite(at)
		) {
			this.reset();
			return null;
		}

		const identity = this.#identity;
		if (!identity || identity.rendition !== observation.rendition || identity.epoch !== observation.epoch) {
			this.reset();
			this.#identity = { rendition: observation.rendition, epoch: observation.epoch };
		}

		const last = this.#points.at(-1);
		if (last && this.#lastMediaTime !== null) {
			if (groups < last.groups || bytes < last.bytes || at < last.at || mediaTime <= this.#lastMediaTime) {
				const kept = this.#identity;
				this.reset();
				this.#identity = kept;
			} else if (groups === last.groups) {
				return null;
			}
		}

		const previousMediaTime = this.#lastMediaTime;
		this.#lastMediaTime = mediaTime;

		const offset = at - mediaTime;
		if (!this.#base || offset < this.#base.offset) {
			this.#base = { offset, at, bytes };
		}
		const point: Point = { groups, at, bytes, backlog: offset - this.#base.offset };
		this.#points.push(point);
		if (!this.#anchor || previousMediaTime === null) {
			this.#anchor = point;
			return null;
		}

		// The one-group bound: the authored span of the group that just completed.
		const groupSpan = mediaTime - previousMediaTime;

		// Trailing window: the latest earlier point at least one group back.
		let windowStart: Point | undefined;
		let windowIndex = -1;
		for (let index = this.#points.length - 2; index >= 0; index--) {
			if (at - this.#points[index].at >= groupSpan) {
				windowStart = this.#points[index];
				windowIndex = index;
				break;
			}
		}
		if (windowIndex > 0) this.#points.splice(0, windowIndex);

		const base = this.#base;
		const windowRateKbps =
			windowStart && windowStart.at >= base.at ? ((bytes - windowStart.bytes) * 8) / (at - windowStart.at) : null;
		const congestedRateKbps = at > base.at ? ((bytes - base.bytes) * 8) / (at - base.at) : null;

		return Object.freeze({
			rendition: observation.rendition,
			groupSpan,
			groupsObserved: groups - this.#anchor.groups,
			span: at - this.#anchor.at,
			backlog: point.backlog,
			backlogGrowth: windowStart ? point.backlog - windowStart.backlog : null,
			windowRateKbps,
			congestedRateKbps,
		});
	}
}

/** Pure switch decision for one group-start sample on the active rung. */
export function decideRendition(input: {
	ladder: readonly AbrRung[];
	active: string;
	sample: GroupSample;
	probeCeilingKbps: number | null;
}): AbrDecision | null {
	const { ladder, active, sample, probeCeilingKbps } = input;
	const index = ladder.findIndex((rung) => rung.name === active);
	if (index < 0 || sample.rendition !== active) return null;
	const groupSpan = sample.groupSpan;

	// Dwell: judge a rung only on a whole group it delivered since it started.
	if (sample.groupsObserved < 1 || sample.span < groupSpan) return null;

	if (sample.backlog >= groupSpan) {
		if (index === 0) return null;
		// While backlogged the sender always had data queued, so the drained rate is
		// the path's rate. Take the highest lower rung it carries.
		const capacity = sample.congestedRateKbps;
		let target = 0;
		if (capacity === null) target = index - 1;
		else {
			for (let candidate = index - 1; candidate > 0; candidate--) {
				if (ladder[candidate].bitrateKbps <= capacity) {
					target = candidate;
					break;
				}
			}
		}
		const refuted = Math.min(
			capacity ?? ladder[index].bitrateKbps,
			ladder[index].bitrateKbps,
			probeCeilingKbps ?? Number.POSITIVE_INFINITY,
		);
		return Object.freeze({
			target: ladder[target].name,
			direction: "down",
			reason: "backlog",
			probeCeilingKbps: refuted,
		});
	}

	const rate = sample.windowRateKbps;
	if (rate !== null) {
		for (let candidate = ladder.length - 1; candidate > index; candidate--) {
			if (ladder[candidate].bitrateKbps <= rate) {
				return Object.freeze({
					target: ladder[candidate].name,
					direction: "up",
					reason: "capacity",
					// New capacity evidence above an old refutation supersedes it.
					probeCeilingKbps: probeCeilingKbps !== null && rate >= probeCeilingKbps ? null : probeCeilingKbps,
				});
			}
		}
	}

	const next = ladder[index + 1];
	if (
		next &&
		sample.backlogGrowth !== null &&
		sample.backlogGrowth <= 0 &&
		(probeCeilingKbps === null || next.bitrateKbps < probeCeilingKbps)
	) {
		return Object.freeze({ target: next.name, direction: "up", reason: "probe", probeCeilingKbps });
	}
	return null;
}

/** Hold, in group starts, after the k-th consecutive failed attempt (k >= 1). */
function backoffGroups(consecutiveFailures: number): number {
	return 2 ** (consecutiveFailures - 1);
}

export type AbrState = Readonly<{
	probeCeilingKbps: number | null;
	probeHoldGroups: number;
	refutations: number;
	downSwitchHoldGroups: number;
	switching: boolean;
	lastSample: GroupSample | null;
}>;

/**
 * One estimator, the probe refutation and its backoff, and a single in-flight
 * switch. `observe()` never decides while a switch is in flight; the caller reports
 * the outcome through `settle()`, or `abandon()`s a decision it did not carry out.
 */
export class AbrController {
	readonly ladder: readonly AbrRung[];
	readonly #estimator = new GroupEstimator();
	#refutedKbps: number | null = null;
	#refutations = 0;
	#probeHoldGroups = 0;
	#failedDownStreak = 0;
	#downSwitchHoldGroups = 0;
	#inFlight: AbrDecision | null = null;
	#lastSample: GroupSample | null = null;

	constructor(ladder: readonly AbrRung[]) {
		this.ladder = ladder;
	}

	/** The rung to start on without evidence: the floor, so a slow path cannot run away. */
	get initial(): string {
		return this.ladder[0].name;
	}

	get pending(): AbrDecision | null {
		return this.#inFlight;
	}

	get state(): AbrState {
		return Object.freeze({
			probeCeilingKbps: this.#probeGate(),
			probeHoldGroups: this.#probeHoldGroups,
			refutations: this.#refutations,
			downSwitchHoldGroups: this.#downSwitchHoldGroups,
			switching: this.#inFlight !== null,
			lastSample: this.#lastSample,
		});
	}

	observe(observation: GroupObservation): AbrDecision | null {
		if (!this.ladder.some((rung) => rung.name === observation.rendition)) {
			this.#estimator.reset();
			this.#lastSample = null;
			return null;
		}
		const sample = this.#estimator.observe(observation);
		if (!sample) return null;
		this.#lastSample = sample;
		if (this.#inFlight) return null;

		// Not a whole group behind: the complement of the step-down criterion.
		const onSchedule = sample.backlog < sample.groupSpan;
		if (this.#contradictsRefutation(sample, onSchedule)) this.#clearRefutation();
		if (onSchedule) this.#clearDownSwitchFailures();

		// Both holds gate this group start, then age by it.
		const probeCeilingKbps = this.#probeGate();
		const downHeld = this.#downSwitchHoldGroups > 0;
		if (this.#probeHoldGroups > 0) {
			// Consecutive: a start a whole group behind restarts the run.
			this.#probeHoldGroups = onSchedule ? this.#probeHoldGroups - 1 : backoffGroups(this.#refutations);
		}
		if (downHeld) this.#downSwitchHoldGroups -= 1;

		const decision = decideRendition({
			ladder: this.ladder,
			active: observation.rendition,
			sample,
			probeCeilingKbps,
		});
		if (!decision) return null;
		if (decision.direction === "down") {
			if (downHeld) return null;
			// A retry after a failed down-switch re-measures the same congestion.
			this.#refute(decision.probeCeilingKbps, this.#failedDownStreak === 0);
		} else if (probeCeilingKbps !== null && decision.probeCeilingKbps === null) {
			this.#clearRefutation();
		}
		this.#inFlight = decision;
		return decision;
	}

	/** Report whether the switch for `decision` committed. */
	settle(decision: AbrDecision, committed: boolean): void {
		if (this.#inFlight !== decision) return;
		this.#inFlight = null;
		if (decision.direction === "down") {
			if (committed) {
				this.#clearDownSwitchFailures();
				return;
			}
			this.#failedDownStreak += 1;
			this.#downSwitchHoldGroups = backoffGroups(this.#failedDownStreak);
			return;
		}
		if (committed) return;
		// A failed up-switch refutes the rung it named, under the same backoff.
		const target = this.ladder.find((rung) => rung.name === decision.target);
		if (!target) return;
		this.#refute(Math.min(this.#refutedKbps ?? Number.POSITIVE_INFINITY, target.bitrateKbps), true);
	}

	/** Release `decision` without an outcome: it is evidence of nothing. */
	abandon(decision: AbrDecision): void {
		if (this.#inFlight === decision) this.#inFlight = null;
	}

	#probeGate(): number | null {
		return this.#probeHoldGroups > 0 ? this.#refutedKbps : null;
	}

	#refute(refutedKbps: number, escalate: boolean): void {
		this.#refutedKbps = refutedKbps;
		if (escalate || this.#refutations === 0) this.#refutations += 1;
		this.#probeHoldGroups = backoffGroups(this.#refutations);
	}

	#contradictsRefutation(sample: GroupSample, onSchedule: boolean): boolean {
		const refuted = this.#refutedKbps;
		return (
			refuted !== null &&
			onSchedule &&
			sample.backlogGrowth !== null &&
			sample.backlogGrowth <= 0 &&
			sample.windowRateKbps !== null &&
			sample.windowRateKbps > refuted
		);
	}

	#clearRefutation(): void {
		this.#refutedKbps = null;
		this.#refutations = 0;
		this.#probeHoldGroups = 0;
	}

	#clearDownSwitchFailures(): void {
		this.#failedDownStreak = 0;
		this.#downSwitchHoldGroups = 0;
	}
}
