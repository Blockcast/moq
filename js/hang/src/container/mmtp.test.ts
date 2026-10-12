import { describe, expect, test } from "bun:test";
import { Time } from "@moq/net";
import { Format } from "./mmtp";

// Synthetic MMTP + ISO-BMFF bytes, authored from the specifications: the MMTP
// packet and MPU/MFU headers from ISO/IEC 23008-1, the box layout from
// ISO/IEC 14496-12. They are built here rather than round-tripped through a
// libmmt encoder on purpose -- encoding with the same library that decodes
// proves self-consistency, not that this consumer reads the wire.

function concatBytes(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function uint32(value: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, value, false);
	return b;
}

function int32(value: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setInt32(0, value, false);
	return b;
}

function uint64(value: bigint): Uint8Array {
	const b = new Uint8Array(8);
	new DataView(b.buffer).setBigUint64(0, value, false);
	return b;
}

function fourCc(value: string): Uint8Array {
	return Uint8Array.from([...value].map((c) => c.charCodeAt(0)));
}

function isoBox(type: string, ...body: Uint8Array[]): Uint8Array {
	const payload = concatBytes(...body);
	return concatBytes(uint32(8 + payload.length), fourCc(type), payload);
}

function isoFullBox(type: string, version: number, flags: number, body: Uint8Array): Uint8Array {
	return isoBox(type, Uint8Array.of(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), body);
}

/** ftyp+moov: the timescale and default sample duration the MFU timing resolves against. */
function initSegment(timescale: number, defaultSampleDuration: number): Uint8Array {
	const trackId = 1;

	const tkhdBody = new Uint8Array(80);
	new DataView(tkhdBody.buffer).setUint32(8, trackId, false);

	const mdhdBody = new Uint8Array(20);
	new DataView(mdhdBody.buffer).setUint32(8, timescale, false);

	const hdlrBody = new Uint8Array(21);
	hdlrBody.set(fourCc("vide"), 4);

	const trak = isoBox(
		"trak",
		isoFullBox("tkhd", 0, 3, tkhdBody),
		isoBox("mdia", isoFullBox("mdhd", 0, 0, mdhdBody), isoFullBox("hdlr", 0, 0, hdlrBody)),
	);

	const trexBody = new Uint8Array(20);
	const trex = new DataView(trexBody.buffer);
	trex.setUint32(0, trackId, false);
	trex.setUint32(4, 1, false);
	trex.setUint32(8, defaultSampleDuration, false);

	return concatBytes(
		isoBox("ftyp", fourCc("mpuf"), uint32(0), fourCc("isom")),
		isoBox("moov", trak, isoBox("mvex", isoFullBox("trex", 0, 0, trexBody))),
	);
}

/** moof+mdat declaring each sample's size, duration and composition offset. */
function movieFragment(opts: {
	movieFragmentSequenceNumber: number;
	decodeTime: bigint;
	sampleSizes: number[];
	/** Omitted: the trun carries no sample-duration, so trex's default applies. */
	sampleDurations?: number[];
}): Uint8Array {
	const trackId = 1;
	// data-offset | sample-duration | sample-size | sample-composition-time-offset
	const trunFlags = 0x000001 | (opts.sampleDurations ? 0x000100 : 0) | 0x000200 | 0x000800;

	const makeMoof = (dataOffset: number): Uint8Array => {
		const entries: Uint8Array[] = [];
		for (let i = 0; i < opts.sampleSizes.length; i++) {
			if (opts.sampleDurations) entries.push(uint32(opts.sampleDurations[i] as number));
			entries.push(uint32(opts.sampleSizes[i] as number));
			entries.push(int32(0));
		}
		return isoBox(
			"moof",
			isoFullBox("mfhd", 0, 0, uint32(opts.movieFragmentSequenceNumber)),
			isoBox(
				"traf",
				isoFullBox("tfhd", 0, 0x020000, uint32(trackId)),
				isoFullBox("tfdt", 1, 0, uint64(opts.decodeTime)),
				isoFullBox(
					"trun",
					1,
					trunFlags,
					concatBytes(uint32(opts.sampleSizes.length), int32(dataOffset), ...entries),
				),
			),
		);
	};

	// data_offset is measured from the start of the moof, so the box must be
	// built once to learn its own length before the real offset can be written.
	const moof = makeMoof(makeMoof(0).length + 8);
	const mediaSize = opts.sampleSizes.reduce((n, s) => n + s, 0);
	return concatBytes(moof, uint32(8 + mediaSize), fourCc("mdat"));
}

type PacketOptions = {
	packetId?: number;
	rapFlag?: boolean;
	sequenceNumber?: number;
	/** 0 = MPU metadata (ftyp+moov), 1 = movie fragment (moof), 2 = MFU. */
	fragmentType?: number;
	/** 0 = whole DU, 1 = first fragment, 2 = middle, 3 = last. */
	fi?: number;
	fragmentCounter?: number;
	mpuSeq?: number;
	sampleNumber?: number;
	sampleOffset?: number;
	payload?: Uint8Array;
	payloadLength?: number;
};

/** One MMTP packet: 12-byte header, MPU header, optional MFU DU header, payload. */
function mmtpPacket(o: PacketOptions = {}): Uint8Array {
	const packetId = o.packetId ?? 1;
	const fragmentType = o.fragmentType ?? 2;
	const fi = o.fi ?? 0;
	const timedFlag = 1;
	const payload = o.payload ?? Uint8Array.of(0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd);
	// The MFU data-unit header rides on a whole DU or a first fragment only.
	const hasDuHeader = fragmentType === 2 && fi <= 1;
	const duHeaderSize = hasDuHeader ? 14 : 0;
	const payloadLength = o.payloadLength ?? 6 + duHeaderSize + payload.length;

	const p: number[] = [];
	p.push(o.rapFlag ? 1 : 0); // FEC_type=0, RAP flag in the low bit
	p.push(0x00); // reserved(2) | packet_type(6) = MPU
	p.push((packetId >> 8) & 0xff, packetId & 0xff);
	p.push(0, 0, 0, 0); // timestamp (short NTP); the authored ISO-BMFF carries presentation time
	const seq = o.sequenceNumber ?? 0;
	p.push((seq >> 24) & 0xff, (seq >> 16) & 0xff, (seq >> 8) & 0xff, seq & 0xff);
	p.push((payloadLength >> 8) & 0xff, payloadLength & 0xff);
	p.push((fragmentType << 4) | (timedFlag << 3) | (fi << 1));
	p.push((o.fragmentCounter ?? 0) & 0xff);
	const mpu = o.mpuSeq ?? 1;
	p.push((mpu >> 24) & 0xff, (mpu >> 16) & 0xff, (mpu >> 8) & 0xff, mpu & 0xff);
	if (hasDuHeader) {
		const sn = o.sampleNumber ?? 1;
		const so = o.sampleOffset ?? 0;
		p.push(0, 0, 0, 1); // movie_fragment_sequence_number
		p.push((sn >> 24) & 0xff, (sn >> 16) & 0xff, (sn >> 8) & 0xff, sn & 0xff);
		p.push((so >> 24) & 0xff, (so >> 16) & 0xff, (so >> 8) & 0xff, so & 0xff);
		p.push(0, 0); // priority, dependency_counter
	}
	for (const b of payload) p.push(b);
	return new Uint8Array(p);
}

const TIMESCALE = 1_000_000; // microseconds, so authored ticks read directly as the frame timestamp
const SAMPLE_DURATION = Time.Micro(33_333);

function videoFormat() {
	return new Format({ type: "video", codec: "avc1.640028", packetId: 1 });
}

/** The timing chain every timed MFU resolves against: ftyp+moov, then moof. */
function feedTimingChain(
	format: Format,
	sampleSizes: number[],
	opts: { durations?: boolean; trexDefault?: number } = {},
) {
	format.decode(
		mmtpPacket({ fragmentType: 0, payload: initSegment(TIMESCALE, opts.trexDefault ?? Number(SAMPLE_DURATION)) }),
	);
	format.decode(
		mmtpPacket({
			fragmentType: 1,
			payload: movieFragment({
				movieFragmentSequenceNumber: 1,
				decodeTime: 0n,
				sampleSizes,
				sampleDurations: opts.durations === false ? undefined : sampleSizes.map(() => Number(SAMPLE_DURATION)),
			}),
		}),
	);
}

describe("MMTP container", () => {
	test("a synthetic MMTP stream decodes to frames", () => {
		const format = videoFormat();
		const sample = Uint8Array.of(0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd);
		feedTimingChain(format, [sample.length, sample.length]);

		const first = format.decode(mmtpPacket({ rapFlag: true, sampleNumber: 1, payload: sample }));
		expect(first).toHaveLength(1);
		expect(first[0]?.payload).toEqual(sample);
		expect(first[0]?.timestamp).toBe(Time.Micro(0));
		expect(first[0]?.keyframe).toBe(true);
		expect(first[0]?.duration).toBe(SAMPLE_DURATION);

		// The second sample's authored decode time is one duration later, which
		// is what makes this a stream rather than a repeated single frame.
		const second = format.decode(mmtpPacket({ sequenceNumber: 1, sampleNumber: 2, payload: sample }));
		expect(second).toHaveLength(1);
		expect(second[0]?.timestamp).toBe(SAMPLE_DURATION);

		expect(format.stats.outcomes.frame).toBe(2);
	});

	test("a sample fragmented across packets completes as one frame", () => {
		const format = videoFormat();
		const head = Uint8Array.of(0, 0, 0, 9, 0x65, 0xaa, 0xbb);
		const tail = Uint8Array.of(0xcc, 0xdd, 0xee, 0xff, 0x11, 0x22);
		const whole = new Uint8Array([...head, ...tail]);
		feedTimingChain(format, [whole.length]);

		// FI=1 opens the data unit, FI=3 closes it. Only the head carries a DU
		// header; the continuation is addressed by its fragment counter.
		expect(format.decode(mmtpPacket({ rapFlag: true, fi: 1, fragmentCounter: 1, payload: head }))).toHaveLength(0);

		const done = format.decode(
			mmtpPacket({ sequenceNumber: 1, fi: 3, fragmentCounter: 0, payload: tail, payloadLength: 6 + tail.length }),
		);
		expect(done).toHaveLength(1);
		expect(done[0]?.payload).toEqual(whole);
		expect(done[0]?.keyframe).toBe(true);
	});

	test("a packet the parser refuses is attributable to the stage that refused it", () => {
		const format = videoFormat();
		// No timing chain fed, so the MFU has nothing to resolve its sample
		// against. The point is the reason, not that it dropped: a header parse,
		// MFU extraction and a timing refusal are three different components and
		// a track that stops producing frames looks identical under all three.
		expect(format.decode(mmtpPacket({ rapFlag: true }))).toHaveLength(0);
		expect(format.lastOutcome).toBe("drop:mfu-no-resolver");
		expect(format.stats.outcomes["drop:mfu-no-resolver"]).toBe(1);

		// Every packet lands in exactly one bucket, so the tally is readable.
		const total = Object.values(format.stats.outcomes).reduce((n, v) => n + (v ?? 0), 0);
		expect(total).toBe(format.stats.fedObjects);
	});

	// `Frame.duration` is optional, and these two pin which of the two ways it
	// can be absent actually happens: a sample the trun does not time inherits
	// trex's default, and a sample nothing times is dropped rather than emitted
	// at zero. An emitted frame therefore always carries a duration -- a zero
	// one would silently read as "occupies no time" in the consumer's
	// group-reach arithmetic.
	test("a duration not authored in the trun is inherited from trex", () => {
		const format = videoFormat();
		const sample = Uint8Array.of(0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd);
		feedTimingChain(format, [sample.length], { durations: false });

		const frames = format.decode(mmtpPacket({ rapFlag: true, sampleNumber: 1, payload: sample }));
		expect(frames).toHaveLength(1);
		expect(frames[0]?.duration).toBe(SAMPLE_DURATION);
	});

	test("a sample with no resolvable duration is dropped, not emitted at zero", () => {
		const format = videoFormat();
		const sample = Uint8Array.of(0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd);
		feedTimingChain(format, [sample.length], { durations: false, trexDefault: 0 });

		expect(format.decode(mmtpPacket({ rapFlag: true, sampleNumber: 1, payload: sample }))).toHaveLength(0);
		expect(format.lastOutcome).toBe("drop:mfu-sample-timing-missing");
	});

	test("packet_id 0 is the signaling flow and is refused", () => {
		// An accepted 0 would point a media consumer at the flow carrying AL-FEC
		// signaling messages. 65_536 is past the 16-bit wire field.
		for (const packetId of [0, -1, 1.5, 65_536]) {
			expect(() => new Format({ type: "video", codec: "avc1.640028", packetId })).toThrow();
		}
		expect(() => new Format({ type: "video", codec: "avc1.640028", packetId: 1 })).not.toThrow();
	});

	// TIMESCALE above makes ticks and microseconds numerically identical, so the
	// stream test cannot tell a converted timestamp from a raw tick count. At a
	// real video timescale the two differ ~11x: 3003 ticks of 90 kHz is
	// 33366.67 us, and a consumer passing ticks through would emit 3003.
	test("timestamps and durations are microseconds, not media-timescale ticks", () => {
		const format = videoFormat();
		const sample = Uint8Array.of(0, 0, 0, 5, 0x65, 0xaa, 0xbb, 0xcc, 0xdd);
		const ticks = 3_003;
		const micros = (ticks * 1_000_000) / 90_000;
		format.decode(mmtpPacket({ fragmentType: 0, payload: initSegment(90_000, ticks) }));
		format.decode(
			mmtpPacket({
				fragmentType: 1,
				payload: movieFragment({
					movieFragmentSequenceNumber: 1,
					decodeTime: 0n,
					sampleSizes: [sample.length, sample.length],
					sampleDurations: [ticks, ticks],
				}),
			}),
		);

		const first = format.decode(mmtpPacket({ rapFlag: true, sampleNumber: 1, payload: sample }));
		const second = format.decode(mmtpPacket({ sequenceNumber: 1, sampleNumber: 2, payload: sample }));
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(first[0]?.timestamp).toBe(Time.Micro(0));
		expect(first[0]?.duration).toBeCloseTo(micros, 6);
		expect(second[0]?.timestamp).toBeCloseTo(micros, 6);
		expect(second[0]?.duration).toBeCloseTo(micros, 6);
	});

	test("flush returns what it releases, and never a partial sample", () => {
		const format = videoFormat();
		const head = Uint8Array.of(0, 0, 0, 9, 0x65, 0xaa, 0xbb);
		feedTimingChain(format, [13]);

		// FI=1 with no FI=3: the data unit never completes. Flushing must not
		// turn it into a truncated frame, and it is reported through the return
		// value rather than an internal buffer the caller cannot read.
		expect(format.decode(mmtpPacket({ rapFlag: true, fi: 1, fragmentCounter: 1, payload: head }))).toHaveLength(0);
		expect(format.flush()).toEqual([]);
		expect(format.stats.outcomes.frame).toBeUndefined();
	});

	test("a closed format refuses further use", () => {
		const format = videoFormat();
		format.close();
		format.close();
		expect(() => format.decode(mmtpPacket({ rapFlag: true }))).toThrow("closed");
		expect(() => format.flush()).toThrow("closed");
	});

	test("stats is a snapshot, not a live tally", () => {
		const format = videoFormat();
		format.decode(mmtpPacket({ rapFlag: true }));
		const before = format.stats;
		format.decode(mmtpPacket({ rapFlag: true, sequenceNumber: 1 }));
		expect(before.fedObjects).toBe(1);
		expect(before.outcomes["drop:mfu-no-resolver"]).toBe(1);
		expect(format.stats.fedObjects).toBe(2);
	});

	test("the in-band initialization segment is exposed once it arrives", () => {
		const format = videoFormat();
		expect(format.init).toBeUndefined();
		format.decode(mmtpPacket({ fragmentType: 0, payload: initSegment(TIMESCALE, SAMPLE_DURATION) }));
		expect(format.init).toBeDefined();
	});
});
