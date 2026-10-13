import * as Catalog from "@moq/hang/catalog";
import type * as Moq from "@moq/net";
import { Effect, type Getter, getter, type Inputs, type Readonlys, readonlys, Signal } from "@moq/signals";
import type { Broadcast } from "../broadcast";
import { AbrController, type AbrDecision, buildAbrLadder, type GroupObservation } from "./abr";
import { supportCacheKey } from "./config";

/**
 * A function that checks if a video configuration can be played.
 *
 * `Decoder.supported` is the WebCodecs probe used by `<moq-watch>`.
 */
export type Supported = (config: Catalog.VideoConfig) => Promise<boolean>;

type CacheableSupported = Supported & {
	[supportCacheKey]?: (config: Catalog.VideoConfig) => string;
};

/** A video source error that prevents choosing a usable rendition. */
export type SourceError = "unsupported";

export type Target = {
	// Optional manual override for the selected rendition name.
	name?: string;

	// Maximum desired pixel area (codedWidth * codedHeight).
	pixels?: number;

	// Maximum desired coded width in pixels.
	width?: number;

	// Maximum desired coded height in pixels.
	height?: number;

	// Maximum desired bitrate in bits per second.
	bitrate?: number;
};

export type SourceInput = {
	broadcast: Getter<Broadcast | undefined>;
	target: Getter<Target | undefined>;

	// A function that checks if a video configuration can be played. Renditions that fail the
	// probe are filtered out. Nothing is selected until one is provided.
	supported: Getter<Supported | undefined>;

	// The connection's PROBE estimates, used to auto-select a rendition when the target has no
	// explicit bitrate. Usually wired from a `Connection`'s `probe`.
	// Optional: without an estimate, a catalog whose renditions form a bitrate ladder is selected
	// from delivery evidence the decoder reports (see `observeGroup`); any other catalog falls back
	// to the rank order alone.
	probe: Getter<Moq.Connection.Probe | undefined>;
};

type SourceOutput = {
	catalog: Signal<Catalog.Video | undefined>;
	available: Signal<Record<string, Catalog.VideoConfig>>;

	// The current source error, or undefined while healthy or still probing.
	error: Signal<SourceError | undefined>;

	// The name of the active rendition.
	track: Signal<string | undefined>;
	config: Signal<Catalog.VideoConfig | undefined>;
};

/**
 * A filter that returns matching renditions sorted by preference (most preferred first).
 * Must return at least one rendition.
 */
type RenditionFilter = (entries: [string, Catalog.VideoConfig][]) => string[];

/**
 * Filter and rank renditions by a maximum pixel count.
 * Returns renditions within budget (largest first for best quality).
 * Over-budget and unknown-resolution renditions are excluded.
 * If nothing is within budget, falls back to the single smallest rendition.
 */
function byPixels(target: number): RenditionFilter {
	return (entries) => {
		const within: { name: string; size: number }[] = [];
		const rest: { name: string; size: number }[] = [];

		for (const [name, config] of entries) {
			if (config.codedWidth && config.codedHeight) {
				const size = config.codedWidth * config.codedHeight;
				if (size <= target) {
					within.push({ name, size });
				} else {
					rest.push({ name, size });
				}
			}
		}

		// Best quality within budget
		within.sort((a, b) => b.size - a.size);

		if (within.length > 0) {
			return within.map((e) => e.name);
		}

		// Degrade to smallest over-budget resolution.
		if (rest.length > 0) {
			rest.sort((a, b) => a.size - b.size);
			return [rest[0].name];
		}

		// No entries had resolution metadata, so return all names unranked.
		return entries.map(([name]) => name);
	};
}

/**
 * Filter and rank renditions by maximum coded dimensions.
 * Returns renditions where codedWidth <= width AND codedHeight <= height
 * (each cap is optional). Within-budget renditions rank by area (largest first).
 * If nothing fits, falls back to the single smallest over-budget rendition.
 */
function byDimensions(width?: number, height?: number): RenditionFilter {
	return (entries) => {
		const within: { name: string; size: number }[] = [];
		const rest: { name: string; size: number }[] = [];

		for (const [name, config] of entries) {
			if (!config.codedWidth || !config.codedHeight) continue;
			const size = config.codedWidth * config.codedHeight;
			const fitsWidth = width == null || config.codedWidth <= width;
			const fitsHeight = height == null || config.codedHeight <= height;
			if (fitsWidth && fitsHeight) {
				within.push({ name, size });
			} else {
				rest.push({ name, size });
			}
		}

		// Best quality within budget
		within.sort((a, b) => b.size - a.size);

		if (within.length > 0) {
			return within.map((e) => e.name);
		}

		// Degrade to smallest over-budget rendition.
		if (rest.length > 0) {
			rest.sort((a, b) => a.size - b.size);
			return [rest[0].name];
		}

		// No entries had resolution metadata, so return all names unranked.
		return entries.map(([name]) => name);
	};
}

/**
 * Filter and rank renditions by a maximum bitrate budget.
 * Returns renditions within budget (highest bitrate first for best quality).
 * Over-budget and unknown-bitrate renditions are excluded.
 * If nothing is within budget, falls back to the single lowest-bitrate rendition.
 */
function byBitrate(target: number): RenditionFilter {
	return (entries) => {
		const within: { name: string; bitrate: number }[] = [];
		const rest: { name: string; bitrate: number }[] = [];

		for (const [name, config] of entries) {
			if (config.bitrate != null && config.bitrate <= target) {
				within.push({ name, bitrate: config.bitrate });
			} else if (config.bitrate != null) {
				rest.push({ name, bitrate: config.bitrate });
			}
		}

		// Best quality within budget
		within.sort((a, b) => b.bitrate - a.bitrate);

		if (within.length > 0) {
			return within.map((e) => e.name);
		}

		// Degrade to lowest over-budget bitrate.
		if (rest.length > 0) {
			rest.sort((a, b) => a.bitrate - b.bitrate);
			return [rest[0].name];
		}

		// No entries had bitrate metadata, so return all names unranked.
		return entries.map(([name]) => name);
	};
}

/**
 * The ABR ladder over `renditions`, or undefined when they do not form one: fewer than two
 * renditions, any without a positive bitrate, or two at the same bitrate (equal cost cannot be
 * ordered, so the preference rank decides instead).
 */
function abrLadder(renditions: Record<string, Catalog.VideoConfig>) {
	const ladder = buildAbrLadder(
		Object.entries(renditions).map(([name, config]) => ({ name, bitrate: config.bitrate })),
	);
	if (!ladder) return undefined;
	for (let index = 1; index < ladder.length; index++) {
		if (ladder[index].bitrateKbps === ladder[index - 1].bitrateKbps) return undefined;
	}
	return ladder;
}

/** Return the renditions that may be selected: a disabled one has no frames coming. */
function enabledRenditions(renditions: Record<string, Catalog.VideoConfig>): Record<string, Catalog.VideoConfig> {
	return Object.fromEntries(Object.entries(renditions).filter(([, config]) => config.enabled !== false));
}

/** Keep only the highest preference: a lower one is a fallback for players that can't decode it. */
function preferredRenditions(renditions: Record<string, Catalog.VideoConfig>): Record<string, Catalog.VideoConfig> {
	const entries = Object.entries(renditions);
	const top = Math.max(...entries.map(([, config]) => config.preference ?? 0));
	return Object.fromEntries(entries.filter(([, config]) => (config.preference ?? 0) === top));
}

/**
 * Source handles catalog extraction, support checking, and rendition selection
 * for video playback. The Decoder consumes whichever rendition it picks.
 */
export class Source {
	readonly in: Readonlys<SourceInput>;

	readonly #out: SourceOutput = {
		catalog: new Signal<Catalog.Video | undefined>(undefined),
		available: new Signal<Record<string, Catalog.VideoConfig>>({}),
		error: new Signal<SourceError | undefined>(undefined),
		track: new Signal<string | undefined>(undefined),
		config: new Signal<Catalog.VideoConfig | undefined>(undefined),
	};
	readonly out = readonlys(this.#out);

	#signals = new Effect();
	// Selection without a PROBE estimate: the controller for the current ladder, and the decision
	// in flight with the rendition it switched away from.
	#abr?: { key: string; controller: AbrController; from?: string };
	#abrSelected = new Signal<string | undefined>(undefined);
	#supportCache = new WeakMap<Supported, Map<string, { key: string; supported: boolean }>>();

	constructor(props?: Inputs<SourceInput>) {
		this.in = {
			broadcast: getter(props?.broadcast),
			target: getter(props?.target),
			supported: getter(props?.supported),
			probe: getter(props?.probe),
		};

		this.#signals.run(this.#runCatalog.bind(this));
		this.#signals.run(this.#runSupported.bind(this));
		this.#signals.run(this.#runSelected.bind(this));
	}

	#runCatalog(effect: Effect): void {
		const broadcast = effect.get(this.in.broadcast);
		if (!broadcast) return;

		const catalog = effect.get(broadcast.out.catalog)?.video;
		if (!catalog) return;

		effect.set(this.#out.catalog, catalog);
	}

	#runSupported(effect: Effect): void {
		const supported = effect.get(this.in.supported);
		if (!supported) {
			this.#out.error.set(undefined);
			return;
		}

		const renditions = effect.get(this.#out.catalog)?.renditions ?? {};
		this.#out.error.set(undefined);
		let cache = this.#supportCache.get(supported);
		if (!cache) {
			cache = new Map();
			this.#supportCache.set(supported, cache);
		}
		const names = new Set(Object.keys(renditions));
		for (const name of cache.keys()) {
			if (!names.has(name)) cache.delete(name);
		}

		effect.spawn(async () => {
			const available: Record<string, Catalog.VideoConfig> = {};

			for (const [name, config] of Object.entries(renditions)) {
				const cacheKey = (supported as CacheableSupported)[supportCacheKey];
				const key = cacheKey ? cacheKey(config) : JSON.stringify(config);
				const cached = cache.get(name);
				let isSupported: boolean | undefined = false;
				if (cached?.key === key) {
					isSupported = cached.supported;
				} else {
					let failed = false;
					try {
						// `supported` comes from the consumer, so we cannot assume it ever settles. A
						// rerun waits for the tasks it spawned, so an unraced probe would hold it shut.
						isSupported = await effect.race(supported(config));
					} catch (err) {
						failed = true;
						console.warn(
							`[Source] video rendition ${name} (${config.codec}) support probe failed; treating as unsupported`,
							err,
						);
					}
					if (!failed && isSupported !== undefined) {
						cache.set(name, {
							key: cacheKey ? cacheKey(config) : JSON.stringify(config),
							supported: isSupported,
						});
					}
				}

				// Torn down: stop probing and publish nothing, since the rerun redoes this.
				if (effect.abort.aborted) return;

				if (isSupported) available[name] = config;
			}

			const error =
				Object.keys(available).length === 0 && Object.keys(renditions).length > 0 ? "unsupported" : undefined;
			if (error === "unsupported") {
				console.warn("[Source] No supported video renditions found:", renditions);
			}

			this.#out.error.set(error);
			this.#out.available.set(available);
		});
	}

	#runSelected(effect: Effect): void {
		const available = enabledRenditions(effect.get(this.#out.available));
		const target = effect.get(this.in.target);

		if (target?.name && target.name in available) {
			// A manual choice is not evidence about the path, and ABR resumes from the floor.
			this.#stopAbr();
			const config = available[target.name];
			effect.set(this.#out.track, target.name);
			effect.set(this.#out.config, config);
			return;
		}

		if (Object.keys(available).length === 0) return;

		// Auto-select: use recv bandwidth if no explicit bitrate target.
		let effectiveTarget = target;
		let abr = false;
		if (!target?.bitrate) {
			const estimate = effect.get(this.in.probe)?.estimatedRecvRate;
			if (estimate != null) {
				// Apply a safety margin (80%) to avoid oscillation.
				const safeBitrate = Math.round(estimate * 0.8);
				effectiveTarget = { ...target, bitrate: safeBitrate };
			} else {
				abr = true;
			}
		}

		const preferred = preferredRenditions(available);
		const selected = abr ? this.#selectAbr(effect, preferred, target) : this.#select(preferred, effectiveTarget);
		if (!abr) this.#stopAbr();
		if (!selected) return;

		const config = available[selected];

		effect.set(this.#out.track, selected);
		effect.set(this.#out.config, config);
	}

	/**
	 * Select without a capacity estimate. Renditions within the target's size caps that form a
	 * bitrate ladder start on the floor and move by delivery evidence; anything else falls back to
	 * the preference rank.
	 */
	#selectAbr(effect: Effect, available: Record<string, Catalog.VideoConfig>, target?: Target): string | undefined {
		const capped = this.#capped(available, target);
		const ladder = capped && abrLadder(capped);
		if (!ladder) {
			this.#stopAbr();
			return this.#select(available, target);
		}

		const key = JSON.stringify(ladder);
		if (this.#abr?.key !== key) {
			this.#stopAbr();
			const controller = new AbrController(ladder);
			this.#abr = { key, controller };
			this.#abrSelected.set(controller.initial);
		}
		const selected = effect.get(this.#abrSelected);
		return selected !== undefined && selected in capped ? selected : this.#abr.controller.initial;
	}

	/** The renditions within the target's size caps, or undefined if a cap leaves no choice. */
	#capped(
		renditions: Record<string, Catalog.VideoConfig>,
		target?: Target,
	): Record<string, Catalog.VideoConfig> | undefined {
		const entries = Object.entries(renditions);
		const filters: RenditionFilter[] = [];
		if (target?.pixels != null) filters.push(byPixels(target.pixels));
		if (target?.width != null || target?.height != null) filters.push(byDimensions(target.width, target.height));
		const sets = filters.map((filter) => new Set(filter(entries)));
		const kept = entries.filter(([name]) => sets.every((set) => set.has(name)));
		return kept.length > 0 ? Object.fromEntries(kept) : undefined;
	}

	#stopAbr(): void {
		const abr = this.#abr;
		if (!abr) return;
		const pending = abr.controller.pending;
		if (pending) abr.controller.abandon(pending);
		this.#abr = undefined;
		this.#abrSelected.set(undefined);
	}

	/**
	 * Report a group start delivered on the rendition the decoder is playing. Without a PROBE
	 * estimate this is the evidence that moves the selection; otherwise it is ignored.
	 */
	observeGroup(observation: GroupObservation): void {
		const abr = this.#abr;
		if (!abr) return;
		const pending = abr.controller.pending;
		// The decoder plays a rendition only once it has caught up, so a group from the target commits.
		if (pending && observation.rendition === pending.target) {
			abr.controller.settle(pending, true);
			abr.from = undefined;
		}
		const decision = abr.controller.observe(observation);
		if (!decision) return;
		abr.from = observation.rendition;
		this.#abrSelected.set(decision.target);
	}

	/** Report that the rendition the decoder was switching to failed before it played. */
	abandonRendition(rendition: string): void {
		const abr = this.#abr;
		const pending: AbrDecision | null | undefined = abr?.controller.pending;
		if (!abr || !pending || pending.target !== rendition) return;
		abr.controller.settle(pending, false);
		const from = abr.from;
		abr.from = undefined;
		if (from !== undefined) this.#abrSelected.set(from);
	}

	/**
	 * Select the best rendition using a generic filter system.
	 *
	 * Each enabled filter returns matching renditions sorted by preference.
	 * The first rendition present in every filter's output is selected.
	 * If no rendition satisfies all filters, a warning is logged.
	 */
	#select(renditions: Record<string, Catalog.VideoConfig>, target?: Target): string | undefined {
		const entries = Object.entries(renditions);
		if (entries.length === 0) return undefined;
		if (entries.length === 1) return entries[0][0];

		// Build enabled filters based on the target.
		const filters: RenditionFilter[] = [];

		if (target?.pixels != null) {
			filters.push(byPixels(target.pixels));
		}
		if (target?.width != null || target?.height != null) {
			filters.push(byDimensions(target.width, target.height));
		}
		if (target?.bitrate != null) {
			filters.push(byBitrate(target.bitrate));
		}

		// No cap: the same rank as Rust's single-rendition egresses.
		if (filters.length === 0) {
			return Catalog.Video.ranked(renditions)[0][0];
		}

		// Run each filter to get ranked preference lists.
		const rankings = filters.map((f) => f(entries));

		// Select the first rendition (in the first ranking's order) present in all rankings.
		const sets = rankings.map((r) => new Set(r));

		for (const name of rankings[0]) {
			if (sets.every((s) => s.has(name))) {
				return name;
			}
		}

		console.warn("conflicting rendition filters, no rendition satisfies all criteria");
		return undefined;
	}

	close(): void {
		this.#stopAbr();
		this.#signals.close();
	}
}
