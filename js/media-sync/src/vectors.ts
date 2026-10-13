/**
 * Shared clock, pacing, and retirement vectors for {@link MediaSync} and the wrappers that adapt its units.
 *
 * @module
 */

/** Clock anchoring and `now()` per kind, in millisecond and microsecond timestamp units. */
export const MEDIA_SYNC_CLOCK_VECTORS = [
	{
		name: "millisecond clock",
		timestampScale: 1,
		anchorClock: 1_000,
		anchorTimestamp: 900,
		readClock: 1_030,
		buffer: { video: 20, audio: 40 },
		expected: { reference: 100, timestamp: 900, videoNow: 910, audioNow: 890 },
	},
	{
		name: "microsecond media timestamps",
		timestampScale: 1_000,
		anchorClock: 1_000,
		anchorTimestamp: 900_000,
		readClock: 1_030,
		buffer: { video: 20, audio: 40 },
		expected: { reference: 100, timestamp: 900_000, videoNow: 910_000, audioNow: 890_000 },
	},
] as const;

/** A paced delivery is held while early and committed once due. */
export const MEDIA_SYNC_PACING_VECTORS = [
	{
		name: "paced video delivery",
		kind: "video",
		anchorClockMs: 1_000,
		anchorTimestampMs: 900,
		deliveryTimestampMs: 1_000,
		earlyClockMs: 1_030,
		dueClockMs: 1_051,
		bufferMs: 20,
	},
	{
		name: "paced audio delivery",
		kind: "audio",
		anchorClockMs: 2_000,
		anchorTimestampMs: 1_900,
		deliveryTimestampMs: 2_000,
		earlyClockMs: 2_030,
		dueClockMs: 2_051,
		bufferMs: 20,
	},
] as const;

/** Cancel and reset retire in-flight and queued deliveries, and allow timestamp reuse afterwards. */
export const MEDIA_SYNC_DELIVERY_VECTORS = [
	{
		name: "audio cancellation retirement",
		kind: "audio",
		retire: "cancel",
		firstTimestampMs: 7,
		queuedTimestampMs: 8,
		reusedTimestampMs: 7,
	},
	{
		name: "audio reset retirement",
		kind: "audio",
		retire: "reset",
		firstTimestampMs: 17,
		queuedTimestampMs: 18,
		reusedTimestampMs: 17,
	},
	{
		name: "video cancellation retirement",
		kind: "video",
		retire: "cancel",
		firstTimestampMs: 27,
		queuedTimestampMs: 28,
		reusedTimestampMs: 27,
	},
	{
		name: "video reset retirement",
		kind: "video",
		retire: "reset",
		firstTimestampMs: 37,
		queuedTimestampMs: 38,
		reusedTimestampMs: 37,
	},
] as const;
