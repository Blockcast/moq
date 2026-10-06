import { expect, spyOn, test } from "bun:test";
import * as Epoch from "./epoch.ts";

test("mint uses UUIDv7 and orders successive identities with a fixed wall clock", () => {
	// UUIDv7 keeps monotonic process state, including mints in other test files.
	const timestamp = Epoch.time(Epoch.mint()).getTime() + 1;
	const now = spyOn(Date, "now").mockReturnValue(timestamp);
	try {
		const epoch = Epoch.mint();
		expect(Epoch.parse(epoch)).toBe(epoch);
		expect(Epoch.time(epoch).getTime()).toBe(timestamp);
		expect(Epoch.mint() > epoch).toBe(true);
	} finally {
		now.mockRestore();
	}
});
