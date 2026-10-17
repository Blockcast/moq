/**
 * The MMTP container: each MoQ frame is one MMTP packet (ISO/IEC 23008-1) of the catalog's
 * `packetId`, and a sample may arrive as several MFU fragments across consecutive frames.
 *
 * Packet parsing and fragment reassembly are libmmt's ({@link https://github.com/Blockcast/libmmt}),
 * not reimplemented here, so this receiver applies the same fail-closed rules as every other
 * libmmt consumer. This file only binds them to hang: which packets a track accepts, where the
 * presentation time comes from, and which data units a WebCodecs decoder can take.
 *
 * @module
 */
import {
	explainMFURejection,
	extractMFUPayload,
	MMTP_SIGNALING_PACKET_ID,
	readMMTPPacketId,
} from "@blockcast/mmt-base";
import { createFragment, MFUReassembler } from "@blockcast/mmt-container/mfu";
import type { Time } from "@moq/net";
import type { MmtpContainer } from "../catalog/container";
import type { Format as ContainerFormat } from "./format";
import type { Frame } from "./types";

/** MPU fragment type of a media fragment unit, the only one that carries a sample. */
const FRAGMENT_TYPE_MFU = 2;

/** Incomplete data units held at once; a reliable stream needs one, the rest is slack. */
const MAX_BUFFERED = 16;

/** Why {@link Format.decode} refused a frame. Stable: callers may switch on it. */
export type MmtpErrorCode =
	// The frame is not an MMTP packet libmmt will take. `detail` carries libmmt's own gate.
	| "malformed"
	// The packet belongs to a different packet_id than the catalog declared.
	| "packet-id-mismatch"
	// The packet is on the signaling flow (packet_id 0), which never carries media.
	| "signaling-packet"
	// A non-timed (T=0) data unit: it has no sample identity and no media time.
	| "non-timed-data-unit"
	// A subsample data unit (nonzero DU offset), which this receiver does not recombine.
	| "subsample-data-unit"
	// A sample's first fragment arrived on an untimed frame, so it has no presentation time.
	| "untimed-frame"
	// libmmt's reassembler refused the fragment. `detail` carries its error code.
	| "reassembly";

/** A frame {@link Format.decode} refused, with a stable {@link MmtpErrorCode}. */
export class MmtpError extends Error {
	/** Why the frame was refused. */
	readonly code: MmtpErrorCode;

	/** Build an error with a stable code and a human-readable detail. */
	constructor(code: MmtpErrorCode, detail: string) {
		super(`mmtp: ${code}: ${detail}`);
		this.name = "MmtpError";
		this.code = code;
	}
}

/** Counters for packets that were valid MMTP but produced no frame. */
export interface MmtpStats {
	/** MPU or movie-fragment metadata packets (FT 0 or 1). The catalog carries decoder config. */
	metadata: number;
	/** Fragments held until the rest of their data unit arrives. */
	pending: number;
	/** Incomplete data units libmmt evicted to stay within its bound. */
	evicted: number;
}

/**
 * Decodes MMTP packets into hang frames.
 *
 * Stateful: fragments of one sample are joined across `decode` calls, so use one instance per
 * track subscription.
 */
export class Format implements ContainerFormat {
	/** The packet_id this track's frames must carry. */
	readonly packetId: number;

	readonly #reassembler = new MFUReassembler({ timeoutMs: null, maxBuffered: MAX_BUFFERED });

	// Presentation time and keyframe flag of each data unit whose first fragment was accepted,
	// keyed by its intrinsic identity. Bounded with the reassembler.
	readonly #heads = new Map<string, { timestamp: Time.Micro; keyframe: boolean }>();

	readonly #stats: MmtpStats = { metadata: 0, pending: 0, evicted: 0 };

	/** Configure the format from the catalog's MMTP container. */
	constructor(container: MmtpContainer) {
		if (container.packetId === MMTP_SIGNALING_PACKET_ID) {
			throw new MmtpError("signaling-packet", "packet_id 0 is the signaling flow, not a media track");
		}
		this.packetId = container.packetId;
	}

	/** A snapshot of the counters for packets that produced no frame. */
	get stats(): MmtpStats {
		return { ...this.#stats, evicted: this.#reassembler.stats.evictedMemoryLimit };
	}

	/** Decode one MMTP packet. Returns a frame when it completes a sample, and throws {@link MmtpError} on a packet it must refuse. */
	decode(payload: Uint8Array, timestamp: Time.Timestamp | undefined): Frame[] {
		const packetId = readMMTPPacketId(payload);
		if (packetId === null) {
			const rejection = explainMFURejection(payload);
			throw new MmtpError(
				"malformed",
				rejection ? `${rejection.gate}: ${rejection.detail}` : "unparseable header",
			);
		}
		if (packetId === MMTP_SIGNALING_PACKET_ID) {
			throw new MmtpError("signaling-packet", "packet_id 0 is the signaling flow, not media");
		}
		if (packetId !== this.packetId) {
			throw new MmtpError("packet-id-mismatch", `packet_id ${packetId}, catalog declares ${this.packetId}`);
		}

		const extraction = extractMFUPayload(payload);
		if (!extraction) {
			const rejection = explainMFURejection(payload);
			throw new MmtpError("malformed", rejection ? `${rejection.gate}: ${rejection.detail}` : "refused");
		}
		if (extraction.fragmentType !== FRAGMENT_TYPE_MFU) {
			this.#stats.metadata++;
			return [];
		}
		if (extraction.mpu.timedFlag !== 1) {
			throw new MmtpError("non-timed-data-unit", "hang media needs a timed (T=1) MFU");
		}

		const fragment = createFragment(payload);
		const head = fragment.fragmentationIndicator <= 1;
		if (head) {
			if (fragment.sampleOffset !== 0) {
				throw new MmtpError("subsample-data-unit", `DU offset ${fragment.sampleOffset}`);
			}
			if (timestamp === undefined) {
				throw new MmtpError("untimed-frame", "a sample's first fragment needs a frame timestamp");
			}
		}

		let complete: ReturnType<MFUReassembler["addFragment"]>;
		try {
			complete = this.#reassembler.addFragment(fragment);
		} catch (err) {
			const code = (err as { code?: unknown }).code;
			throw new MmtpError("reassembly", typeof code === "string" ? code : String(err));
		}

		// Record the head only once libmmt accepted it, so a refused head leaves nothing behind.
		if (head && timestamp !== undefined && !complete) {
			this.#remember(identity(fragment), {
				timestamp: timestamp.asMicros() as Time.Micro,
				keyframe: fragment.rapFlag,
			});
		}

		if (!complete) {
			this.#stats.pending++;
			return [];
		}

		let at: { timestamp: Time.Micro; keyframe: boolean } | undefined;
		if (head && timestamp !== undefined) {
			// A whole-sample data unit: this frame is its own first fragment.
			at = { timestamp: timestamp.asMicros() as Time.Micro, keyframe: complete.rapFlag };
		} else {
			const key = identity(complete);
			at = this.#heads.get(key);
			this.#heads.delete(key);
		}
		// Unreachable unless libmmt completes a data unit without its head, which it refuses to do.
		if (!at) throw new MmtpError("reassembly", "completed data unit has no accepted first fragment");

		return [{ payload: complete.data, timestamp: at.timestamp, keyframe: at.keyframe }];
	}

	/** Drop every incomplete data unit, e.g. when the subscription restarts. */
	reset() {
		this.#reassembler.reset();
		this.#heads.clear();
	}

	#remember(key: string, value: { timestamp: Time.Micro; keyframe: boolean }) {
		this.#heads.delete(key);
		this.#heads.set(key, value);
		// Oldest first, matching the reassembler's own replacement order.
		while (this.#heads.size > MAX_BUFFERED) {
			const oldest = this.#heads.keys().next().value;
			if (oldest === undefined) break;
			this.#heads.delete(oldest);
		}
	}
}

/** A data unit's intrinsic identity: MPU, movie fragment and sample, as written on the wire. */
function identity(du: { mpuSequenceNumber: number; movieFragmentSequenceNumber?: number; sampleNumber?: number }) {
	return `${du.mpuSequenceNumber}:${du.movieFragmentSequenceNumber}:${du.sampleNumber}`;
}
