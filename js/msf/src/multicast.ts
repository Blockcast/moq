import * as z from "@zod/mini";

// Multicast delivery for `packaging: "mmtp"` tracks: which group carries which
// track, and how a receiver off the multicast path reaches the same media.
//
// Every object here is a `looseObject`: the fields this build names are
// validated, and members it does not name are carried rather than stripped.
// Before this section was modelled it travelled through the root `ext` map and
// round-tripped verbatim; modelling it must not quietly make a newer publisher's
// members vanish on decode, which is the regression the track fields had.

/**
 * Zod schema binding one track name to its MMTP `packet_id` inside a group.
 *
 * `packet_id` 0 is the MMTP signaling flow — the AL-FEC signaling message
 * (0x0203) rides it into the same group as the media — so it is never a track's
 * and the range starts at 1. This bound is load-bearing rather than cosmetic: an
 * empty packet-ID filter means "no filter", so a track admitted with 0 would
 * widen a receiver's join to every packet ID, the signaling flow included.
 */
export const MulticastTrackRefSchema = z.looseObject({
	name: z.string().check(z.minLength(1)),
	packetId: z.number().check(z.int(), z.gte(1), z.lte(65_535)),
});

/** One track's MMTP `packet_id` within a multicast group. */
export type MulticastTrackRef = z.infer<typeof MulticastTrackRefSchema>;

/** Zod schema for one multicast group carrying a set of tracks. */
export const MulticastEndpointSchema = z.looseObject({
	protocol: z.optional(z.string()),
	sourceAddress: z.optional(z.string().check(z.minLength(1))),
	// The group address and port a receiver actually joins. Bounded for the same
	// reason `packetId` is: this section exists so the join parameters are
	// enforced rather than carried, and `""`, `0`, `-1`, `1.5` or `70000` name no
	// reachable endpoint. A receiver would take them as stated and fail at the
	// socket, one layer past the catalog that could have named the bad field.
	groupAddress: z.string().check(z.minLength(1)),
	port: z.number().check(z.int(), z.gte(1), z.lte(65_535)),
	// At least one track: an endpoint naming none contributes no packet IDs, and
	// an empty packet-ID filter means "no filter" (see `MulticastTrackRefSchema`).
	tracks: z.array(MulticastTrackRefSchema).check(z.minLength(1)),
	// A positive integer, matching libmmt's `catalog.schema.json`; a consumer
	// sizing a buffer from a zero or negative value would size it wrong silently.
	bandwidth: z.optional(z.number().check(z.int(), z.positive())),
});

/** One multicast group and the tracks it carries. */
export type MulticastEndpoint = z.infer<typeof MulticastEndpointSchema>;

/**
 * Zod schema for an AMT relay reachable for this media.
 *
 * Every field but `type` is optional, and that is deliberate: an under-specified
 * AMT entry must degrade to a defined join rather than to an unsatisfiable
 * tunnel. An entry naming no `port` joins on the RFC 7450 well-known port; a
 * `discovery: "driad"` entry's `relay` is a resolution hint rather than a pinned
 * relay, so such an entry resolves exactly as a relay-less one does and leaves
 * the relay to runtime discovery. Which entry is dialable is decided by the
 * consumer, not by this schema refusing to carry it.
 */
export const AmtNetworkSourceSchema = z.looseObject({
	type: z.literal("amt"),
	// Known value "driad"; a string so a discovery method this build has not seen
	// still reaches the resolver that may understand it.
	discovery: z.optional(z.union([z.literal("driad"), z.string()])),
	relay: z.optional(z.string()),
	port: z.optional(z.number().check(z.int(), z.gte(1), z.lte(65_535))),
});

/** An AMT relay reachable for this media. */
export type AmtNetworkSource = z.infer<typeof AmtNetworkSourceSchema>;

/**
 * Zod schema for an ATSC 3.0 broadcast source carrying this media.
 *
 * Every field but `type` is optional, for the reason the AMT entry's are: an
 * under-specified entry is carried and the consumer decides whether it is
 * tunable, rather than one missing field refusing the whole catalog. A field
 * that IS present is bounded, so `atsc3` stays a known type and a bad value
 * cannot escape through the unknown arm. `plpId` is 6 bits and `serviceId` 16
 * bits in A/331; `frequency` carries no unit here, so it is only positive.
 */
export const Atsc3NetworkSourceSchema = z.looseObject({
	type: z.literal("atsc3"),
	frequency: z.optional(z.number().check(z.positive())),
	plpId: z.optional(z.number().check(z.int(), z.nonnegative(), z.lte(63))),
	serviceId: z.optional(z.number().check(z.int(), z.nonnegative(), z.lte(65_535))),
	slsUri: z.optional(z.string().check(z.minLength(1))),
});

/** An ATSC 3.0 broadcast source carrying this media. */
export type Atsc3NetworkSource = z.infer<typeof Atsc3NetworkSourceSchema>;

// The source types this build models. An entry naming one of these must pass
// that type's schema; it never falls through to the unknown arm below.
const KNOWN_NETWORK_SOURCE_TYPES: readonly string[] = ["amt", "atsc3"];

/**
 * Zod schema for a network source whose `type` this build does not model.
 *
 * Carried rather than refused, for the reason `discovery` above is a string: a
 * delivery path a newer publisher knows about should reach a consumer that may
 * understand it, and refusing it here would throw away the whole catalog --
 * every track, including unicast renditions the path has nothing to do with.
 * The `type` refinement is load-bearing: without it an `amt` entry that fails
 * its own bounds (`port: 70000`) would succeed here and silently disable them.
 */
export const UnknownNetworkSourceSchema = z.looseObject({
	type: z.string().check(z.refine((type) => !KNOWN_NETWORK_SOURCE_TYPES.includes(type))),
});

/** A network source of a type this build does not model, carried for the consumer. */
export type UnknownNetworkSource = z.infer<typeof UnknownNetworkSourceSchema>;

/**
 * Zod schema for a non-IP-unicast path to this media.
 *
 * A plain union rather than a `discriminatedUnion`: the unknown arm's `type` is
 * any string but the known ones, which no literal discriminator can express.
 * Consumers narrow on `type === "amt"` and treat anything else they do not
 * recognize as not dialable.
 */
export const NetworkSourceSchema = z.union([
	AmtNetworkSourceSchema,
	Atsc3NetworkSourceSchema,
	UnknownNetworkSourceSchema,
]);

/** A non-IP-unicast path to this media. */
export type NetworkSource = z.infer<typeof NetworkSourceSchema>;

/** Zod schema for the catalog's multicast section. */
export const MulticastSchema = z.looseObject({
	endpoints: z.optional(z.array(MulticastEndpointSchema)),
	// Accepts a bare object as well as an array: catalogs in the field carry both
	// shapes for a single source, and normalizing here would reject working media.
	networkSource: z.optional(z.union([z.array(NetworkSourceSchema), NetworkSourceSchema])),
});

/** The catalog's multicast section: groups carrying the media, and how else to reach it. */
export type Multicast = z.infer<typeof MulticastSchema>;
