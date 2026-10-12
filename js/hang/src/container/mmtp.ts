/**
 * The MMTP container: each MoQ frame carries one MMTP packet, which libmmt
 * reassembles (packet -> MFU -> frame) into media frames.
 *
 * Unlike {@link Legacy} and {@link Cmaf}, one input frame is not one output
 * frame: a media sample is fragmented across MMTP packets, so `decode` returns
 * the frames that *completed* on this packet -- usually none, occasionally
 * several. Reassembly state lives on the instance, so a Format belongs to
 * exactly one track and must not be shared between them.
 *
 * Lifecycle is the caller's job. The generic {@link ContainerFormat} interface
 * carries only `decode`, so whatever wires this format into a consumer must
 * also call {@link Format.flush} at the end of a finite stream and
 * {@link Format.close} when the track goes away; nothing here does it for them.
 *
 * @module
 */
import {
	MmtpContainerParser,
	type MmtpFeedOutcomeKey,
	type MmtpParserFeedStats,
	type ParserFrameMeta,
	reliableMoqMfuReassembly,
} from "@blockcast/mmt-container";
import type { Time } from "@moq/net";
import type { Format as ContainerFormat } from "./format";
import type { Frame } from "./types";

export type { MmtpFeedOutcomeKey, MmtpParserFeedStats, ParserFrameMeta };

/**
 * Track geometry for an MMTP consumer, every field read from the catalog.
 *
 * Nothing here is defaulted or inferred. A receiver that cannot read a value it
 * needs fails closed at the point of use rather than substituting one -- the
 * same rule the `js/msf` MMTP catalog schema is written to.
 */
export interface Config {
	/** The track's media kind, which decides keyframe detection. */
	type: "video" | "audio";

	/** The track's codec string, e.g. `avc1.640028`. */
	codec: string;

	/**
	 * The track's MMTP `packet_id`, from the catalog's multicast track entry.
	 *
	 * `packet_id` 0 is the signaling flow and is never a track, so it is
	 * refused rather than passed through: an accepted 0 would widen the parser
	 * to a flow carrying AL-FEC signaling messages rather than media.
	 */
	packetId: number;

	/** Catalog frame cadence, exposed to downstream media stages. */
	framerate?: number;

	/** Catalog MMTP group duration in milliseconds, exposed to downstream stages. */
	groupDurationMs?: number;
}

// `packet_id` 0 is the signaling flow (moqcast-draft #44 makes advertising it
// for a track a MUST NOT), and the field is 16 bits on the wire.
const PACKET_ID_MIN = 1;
const PACKET_ID_MAX = 65_535;

/**
 * MMTP container format: decodes each MoQ frame as one MMTP packet.
 *
 * Reassembly is clock-free. MoQ is a reliable transport, so a fragment that has
 * not arrived yet is late rather than lost and no deadline can tell the two
 * apart; completion is decided by the fragment chain alone, and memory is
 * bounded by the reassembler's buffer limit instead. The policy is passed
 * explicitly rather than left off because the parser's own default is a 1000 ms
 * deadline -- omitting it would silently reintroduce exactly the wall-clock
 * completion assumption a reliable path exists to avoid.
 */
export class Format implements ContainerFormat {
	#parser: MmtpContainerParser;
	// Frames emitted during the in-flight decode() call. The parser reports
	// through a callback rather than a return value, because a single packet can
	// release several frames once reordering resolves; this buffer turns that
	// back into one return value.
	#completed: Frame[] = [];
	#init?: Uint8Array;
	#closed = false;

	/** Create a format for one track, configured from its catalog entry. */
	constructor(config: Config) {
		if (!Number.isInteger(config.packetId) || config.packetId < PACKET_ID_MIN || config.packetId > PACKET_ID_MAX) {
			throw new Error(`MMTP track packet_id must be an integer in ${PACKET_ID_MIN}..${PACKET_ID_MAX}`);
		}

		const track = {
			type: config.type,
			codec: config.codec,
			framerate: config.framerate,
			groupDurationMs: config.groupDurationMs,
		};

		this.#parser = new MmtpContainerParser({
			tracks: new Map([[config.packetId, track]]),
			reassemblyPolicy: reliableMoqMfuReassembly(),
		});

		this.#parser.onFrame((data, meta) => {
			this.#completed.push({
				payload: data,
				timestamp: meta.timestamp as Time.Micro,
				keyframe: meta.keyframe,
				// `FrameMeta.duration` is typed optional, so it is forwarded
				// only when present rather than written through as an explicit
				// `undefined`: an absent duration and a zero one are different
				// facts to the consumer's group-reach arithmetic. In practice a
				// frame always carries one at this pin -- authored in the trun
				// or inherited from trex, and dropped outright when neither
				// resolves -- which the suite pins, so this arm is defensive
				// against the type rather than a path exercised here.
				...(meta.duration === undefined ? {} : { duration: meta.duration as Time.Micro }),
			});
		});
		this.#parser.onInit((data) => {
			this.#init = data;
		});
	}

	/**
	 * Decode one MMTP packet, returning the media frames it completed.
	 *
	 * An empty array is the ordinary case, not a failure: most packets carry a
	 * fragment of a sample still being reassembled. A packet the parser refused
	 * is attributable through {@link lastOutcome} and {@link stats}.
	 */
	decode(frame: Uint8Array): Frame[] {
		this.#assertOpen();
		this.#completed = [];
		this.#parser.feed(frame);
		return this.#completed;
	}

	/**
	 * The initialization segment the stream carried in band, once one has
	 * arrived. MMTP carries it as an MPU rather than in the catalog, so unlike
	 * CMAF it is not available when the format is constructed.
	 */
	get init(): Uint8Array | undefined {
		return this.#init;
	}

	/**
	 * How the last {@link decode} ended: a record kind, or `drop:<reason>`.
	 *
	 * This is the typed outcome for every drop path. It names the stage that
	 * refused the packet -- a header parse, MFU extraction, and a timing
	 * resolver refusing a sample are three different components, and a track
	 * that stops producing frames looks identical from outside under all three.
	 */
	get lastOutcome(): MmtpFeedOutcomeKey | null {
		return this.#parser.lastFeedOutcome;
	}

	/**
	 * Feed tallies for this track: one counter per record kind and per drop
	 * reason, summing to `fedObjects`.
	 *
	 * Read this rather than scraping logs -- console output is diagnostic, not
	 * an acceptance API. Each read is a fresh snapshot -- libmmt builds the
	 * object per access rather than handing out its live tally -- so a value
	 * held by a caller does not change under it. The suite pins that, since it
	 * is libmmt's behaviour rather than this file's.
	 */
	get stats(): MmtpParserFeedStats {
		return this.#parser.feedStats;
	}

	/**
	 * The underlying parser, for the repair path.
	 *
	 * The FEC lifecycle needs coordinates this interface does not carry: a
	 * repair track's symbols are fed by SS_ID and released through the parser's
	 * FEC release gate, neither of which is expressible as a `Uint8Array` in,
	 * `Frame[]` out. Exposed rather than wrapped because wrapping it here would
	 * mean inventing a second vocabulary for a contract libmmt already owns.
	 */
	get parser(): MmtpContainerParser {
		return this.#parser;
	}

	/**
	 * Release frames the parser is holding for ordering, returning them. A
	 * finite stream calls this at its end.
	 *
	 * A data unit whose fragments never all arrived is not a frame and is not
	 * returned: flushing does not emit a partial sample.
	 */
	flush(): Frame[] {
		this.#assertOpen();
		this.#completed = [];
		this.#parser.flush();
		return this.#completed;
	}

	/**
	 * Release the parser's reassembly state. The format is unusable afterwards:
	 * a later {@link decode} or {@link flush} throws rather than reaching a
	 * disposed parser, whose behaviour would then be libmmt's to decide.
	 */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#parser.dispose();
	}

	#assertOpen() {
		if (this.#closed) throw new Error("MMTP format is closed");
	}
}
