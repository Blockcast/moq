import * as z from "@zod/mini";

// AL-FEC and repair-track catalog fields, as used by `packaging: "mmtp"` tracks
// and their `packaging: "fec-repair"` companions (draft-ramadan-moq-fec §6.3).
//
// Every field here is optional and none is defaulted. A receiver that cannot
// read a value it needs fails closed at the point of use; it never substitutes
// one. Deriving geometry from an absent field is what this schema exists to
// prevent, so adding a `z._default` to anything below changes a fail-closed
// path into a silently-wrong one.

/** Zod schema for the erasure code protecting a track. */
export const FecAlgorithmSchema = z.enum(["none", "xor", "raptorq", "reed-solomon", "ldpc"]);

/** The erasure code protecting a track. `"none"` means absent FEC, not an unrecognized code. */
export type FecAlgorithm = z.infer<typeof FecAlgorithmSchema>;

// Repair Symbol IDs are addressed by RSB_length, which is 24 bits on the wire,
// so the ID space is 0..2^24-1 and a count is 1..2^24-1. These stay plain
// numbers rather than a wider branded integer: a type broader than the wire
// would force every consumer to re-narrow it.
const repairSymbolCount = z.number().check(z.int(), z.gte(1), z.lte(16_777_215));

// A layer's position in its source's stack, which is NOT a Repair Symbol ID.
// The bounds coincide only because both are addressed in the same 24-bit space,
// so this is spelled separately to stop the next reader inferring a
// relationship that is not there.
const repairLayerIndex = z.number().check(z.int(), z.nonnegative(), z.lte(16_777_215));

// A source track's P for its layer 0: the same number as that layer's repair
// track `repairSymbols`, so it shares `repairSymbolCount`'s 24-bit ceiling. The
// floor is 0, not 1, on purpose: `algorithm: "none", repairSymbols: 0` is how a
// source declares absent FEC.
const sourceRepairSymbolCount = z.number().check(z.int(), z.nonnegative(), z.lte(16_777_215));

// K, the source symbols per block. The floor is 1 for every algorithm -- a block
// of zero source symbols is not a partition -- and the ceiling is the 24-bit
// space its symbols are addressed in.
//
// The RaptorQ-specific ceiling of 56403 (RFC 6330's source block limit) is NOT
// applied here, because a source track's `algorithm` may be reed-solomon, ldpc
// or xor, for which that number means nothing. libmmt's validator owns it and
// applies it conditionally, on `algorithm === "raptorq"` alone
// (`packages/container/src/repair-layers.ts`, `MAX_RAPTORQ_SOURCE_SYMBOLS`).
// The cross-field rule that K + totalP - 1 fits 24 bits spans a whole track set
// and is enforced where that set is known, not here.
const sourceSymbolCount = z.number().check(z.int(), z.gte(1), z.lte(16_777_215));

// The largest K RaptorQ admits. Applied only to an overlay's own K below, where
// it is unconditional for a reason: repair layers and overlays are defined only
// for raptorq -- a block code fixes its codeword length, so symbols of a larger
// P are not symbols of the code a receiver holding fewer layers decodes -- so an
// overlay's algorithm is never anything else.
const raptorqSourceSymbols = z.number().check(z.int(), z.gte(1), z.lte(56_403));

// T, the symbol size in bytes. The floor is 1, not 0: T is the divisor in block
// arithmetic -- symbols per block is derived from a payload length over T -- so
// a zero-byte symbol is not a degenerate partition but a division by zero one
// layer down, which is the silently-wrong-geometry case this file exists to
// prevent. No ceiling: K's and P's come from the 24-bit symbol-ID space, and no
// symbol-ID space addresses T, so that ceiling does not transfer. (A byte-count
// field that carried T, e.g. RFC 6330's 16-bit OTI, would be a different bound,
// and this catalog signals none.)
const symbolSizeBytes = z.number().check(z.int(), z.positive());

// `FecSchema` and `AltaSchema` are `looseObject`s for the reason `blockProfile`
// is `z.unknown()`: a value OR member this build does not recognize must reach
// the consumer that may, rather than vanish on decode. The named fields are
// still validated; only unnamed ones are carried unchecked. (The track object
// around them stays strict -- loosening every track member is a wider call.)

/** Zod schema for a source track's AL-FEC block geometry. */
export const FecSchema = z.looseObject({
	algorithm: z.optional(FecAlgorithmSchema),

	/** K: source symbols per FEC block. */
	sourceSymbols: z.optional(sourceSymbolCount),

	/** P: repair symbols this instance's layer 0 carries per block. */
	repairSymbols: z.optional(sourceRepairSymbolCount),

	/** T: symbol size in bytes. */
	symbolSize: z.optional(symbolSizeBytes),

	// Kept verbatim and never validated, defaulted or inferred here. The profile
	// decides repair-symbol ESI arithmetic and block addressing, so a value this
	// build does not recognize must reach the decoder that does rather than be
	// rejected or guessed at the catalog layer. libmmt's catalog validator owns
	// the check and refuses an unknown token there.
	blockProfile: z.optional(z.unknown()),

	// The FULL FEC block span in milliseconds, not a symbol count and not a
	// multiplier. Receivers derive a count where they need one
	// (`D = round(interleaveDepthMs / unit duration ms)`, floored at 1); absent
	// means no interleaving. This is the only interleave field — a second one
	// denominated in units would let two readers of the same stream disagree.
	interleaveDepthMs: z.optional(z.number().check(z.int(), z.nonnegative())),

	// Added to `interleaveDepthMs` to form a block deadline. Never used as a
	// multiplier on it.
	reorderToleranceMs: z.optional(z.number().check(z.int(), z.nonnegative())),

	// Name of this instance's layer 0 repair track. Bounded like its inverse,
	// `depends`, so absence stays the one spelling of "no repair track".
	repairTrack: z.optional(z.string().check(z.minLength(1))),

	// `"native"` is the only repair container. It is spelled as a literal rather
	// than a free string so a repair flow carried some other way is a parse
	// failure naming this field, not a track the receiver joins and cannot use.
	repairContainer: z.optional(z.literal("native")),
});

/** A source track's AL-FEC block geometry. */
export type Fec = z.infer<typeof FecSchema>;

// Repair-track fields. A `packaging: "fec-repair"` track describes itself: these
// say which source it repairs, where it sits in the layer stack, and how many
// repair symbols it carries. They are all optional because a bare layer 0 repair
// track declares none of them — it is reachable through its source's
// `fec.repairTrack` pointer, and its priority defaults to 240 at the consumer
// when absent. Cross-track rules (layer contiguity, one overlay per source,
// repair reachability, priority ordering) span the whole track set and are
// enforced where that set is known, not here.
export const repairTrackShape = {
	// Names the source track this one repairs. Exactly one: a repair track that
	// claimed two sources would have no single partition to share.
	depends: z.optional(z.array(z.string().check(z.minLength(1))).check(z.minLength(1), z.maxLength(1))),

	/** This track's position in its source's repair layer stack, 0 for the base. */
	repairLayer: z.optional(repairLayerIndex),

	/** P_i: repair symbols this layer carries per block. */
	repairSymbols: z.optional(repairSymbolCount),

	// A keyframe overlay is a separate FEC instance with its own Repair Symbol ID
	// space, outside the layer contiguity and priority chains. An unrecognized
	// scope fails closed rather than degrading to a base layer.
	scope: z.optional(z.literal("keyframe")),

	// K_overlay. Only an overlay declares its own K; base layers share the source
	// track's partition.
	sourceSymbols: z.optional(raptorqSourceSymbols),
};

/** Zod schema for the self-describing fields of a `fec-repair` track. */
export const RepairTrackSchema = z.object(repairTrackShape);

/** The self-describing fields of a `fec-repair` track. */
export type RepairTrack = z.infer<typeof RepairTrackSchema>;

/**
 * Zod schema for ALTA source authentication.
 *
 * `publicKey` is a base64url PKCS#8 SPKI DER key — 44 bytes for Ed25519, 91 for
 * P-256. The length is checked where the key is imported, not here: this schema
 * must not decide which curves are acceptable.
 */
export const AltaSchema = z.looseObject({
	publicKey: z.optional(z.string()),
});

/** ALTA source authentication parameters. */
export type Alta = z.infer<typeof AltaSchema>;
