/**
 * Per-frame container formats (timestamp plus codec bitstream): the legacy varint
 * container, CMAF (fMP4), LOC, and MMTP, with consumers and producers to read/write
 * them. MMTP is the one format whose frames are not 1:1 with MoQ frames -- see
 * {@link Mmtp.Format}.
 *
 * @module
 */

export * as Loc from "@moq/loc";
export * as Cmaf from "./cmaf";
export { Consumer, type ConsumerProps } from "./consumer";
export type { Format } from "./format";
export * as Legacy from "./legacy";
export * as Mmtp from "./mmtp";
export { type TrackInfoOptions, trackInfo } from "./track";
export * from "./types";
