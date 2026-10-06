import * as Epoch from "../epoch.ts";
import type { Reader, Writer } from "../stream.ts";
import { hasSetupStream, type Version } from "./version.ts";

/** Append a known epoch to a negotiated message. */
export async function encode(w: Writer, version: Version, epoch?: Epoch.Valid): Promise<void> {
	if (epoch === undefined) return;
	if (!hasSetupStream(version)) throw new Error("epoch metadata requires SETUP negotiation");
	await w.string(epoch);
}

/** Read an optional epoch from the end of a message. */
export async function decode(r: Reader, version: Version): Promise<Epoch.Valid | undefined> {
	if (await r.done()) return undefined;
	if (!hasSetupStream(version)) throw new Error("epoch metadata requires SETUP negotiation");
	return Epoch.parse(await r.string());
}
