import { expect, test } from "bun:test";
import { infoDefaults } from "../track.ts";
import { fromWire, toWire } from "./priority.ts";

test("IETF subscriber priority is lower first", () => {
	expect(fromWire(0)).toBe(0xff);
	expect(fromWire(0xff)).toBe(0);
	expect(toWire(0xff)).toBe(0);
	expect(toWire(0)).toBe(0xff);

	for (let priority = 0; priority < 0xff; priority++) {
		expect(fromWire(priority)).toBeGreaterThan(fromWire(priority + 1));
	}
});

test("subscriber priority round trips", () => {
	for (let priority = 0; priority <= 0xff; priority++) {
		expect(fromWire(toWire(priority))).toBe(priority);
	}
});

test("an unset track priority is the draft's usual publisher priority", () => {
	expect(toWire(infoDefaults().priority)).toBe(128);
});

// draft-ramadan-moq-fec section 10 bands, on the IETF wire's lower-first scale:
// Source Media is 64..=191 and AL-FEC repair is 192..=255, ascending by repair
// layer. The model ranks higher-first, so a repair priority that is COPIED here
// rather than converted inverts both orderings at once: repair preempts the
// source it repairs, and the highest repair layer outranks layer 0.
test("converted repair bands yield to source and order by layer", () => {
	// Both endpoints of the repair band.
	expect(fromWire(192)).toBe(63);
	expect(fromWire(255)).toBe(0);
	// Both endpoints of the source media band.
	expect(fromWire(64)).toBe(191);
	expect(fromWire(191)).toBe(64);

	// The adjacent boundary is the tightest case: the LEAST urgent source must
	// still preempt the MOST urgent repair, or the bands overlap.
	expect(fromWire(191)).toBeGreaterThan(fromWire(192));

	// Repair layers ascend on the wire, so they must descend in the model.
	expect(fromWire(240)).toBeGreaterThan(fromWire(241));
	expect(fromWire(128)).toBeGreaterThan(fromWire(240));
});
