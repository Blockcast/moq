import { expect, test } from "bun:test";
import { Producer } from "./broadcast.ts";
import { BroadcastCache } from "./consume.ts";
import * as Epoch from "./epoch.ts";
import * as Path from "./path.ts";

// An unknown request must not join a known identity, regardless of arrival order.
test.each([true, false])("cache keeps known and unknown epochs separate (known first: %s)", (knownFirst) => {
	const epoch = Epoch.mint();
	const path = Path.from("live");
	const cache = new BroadcastCache();
	const known = new Producer(epoch);
	const unknown = new Producer();
	for (const source of knownFirst ? [known, unknown] : [unknown, known]) {
		cache.insert(path, source.consume(), source.epoch);
	}
	const a = cache.get(path, epoch);
	const b = cache.get(path);
	expect(a?.epoch).toBe(epoch);
	expect(b?.epoch).toBeUndefined();
	cache.evict(path, epoch);
	expect(cache.get(path, epoch)).toBeUndefined();
	const remaining = cache.get(path);
	expect(remaining).toBeDefined();
	a?.close();
	b?.close();
	remaining?.close();
	known.close();
	unknown.close();
});
