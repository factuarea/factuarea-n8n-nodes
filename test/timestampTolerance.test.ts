import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_TOLERANCE_SECONDS } from '../src/contract';
import { isWithinTolerance } from '../src/verify/timestampTolerance';

/**
 * The window is symmetric around `now`, so every case is expressed as an offset
 * from a fixed instant. The instant is a literal rather than `Date.now()` on
 * purpose: the function is pure precisely so the tests can state the time instead
 * of racing against it.
 */
const NOW = 1_767_225_600; // 2026-01-01T00:00:00Z, in seconds.
const TOLERANCE = DEFAULT_TOLERANCE_SECONDS; // 300 s.

/** A timestamp `offset` seconds away from `NOW`; negative is in the past. */
function at(offset: number): number {
	return NOW + offset;
}

describe('isWithinTolerance', () => {
	it('accepts a delivery comfortably inside the window', () => {
		assert.equal(isWithinTolerance(at(-42), NOW, TOLERANCE), true);
	});

	it('accepts the lower edge exactly, because both edges are inclusive', () => {
		// Exactly `TOLERANCE` seconds in the past. Rejecting it would make the
		// configured number mean one second less than it says.
		assert.equal(isWithinTolerance(at(-TOLERANCE), NOW, TOLERANCE), true);
	});

	it('accepts the upper edge exactly, because both edges are inclusive', () => {
		// Exactly `TOLERANCE` seconds in the future: the receiver's clock lagging
		// by the full tolerance is still inside the window.
		assert.equal(isWithinTolerance(at(TOLERANCE), NOW, TOLERANCE), true);
	});

	it('rejects a timestamp older than the tolerance', () => {
		// One second past the lower edge: the captured-and-replayed delivery.
		assert.equal(isWithinTolerance(at(-TOLERANCE - 1), NOW, TOLERANCE), false);
	});

	it('rejects a timestamp further into the future than the tolerance', () => {
		// One second past the upper edge. A one-sided check would accept this and
		// hand back the replay window it was supposed to close: see the module's
		// docblock on why the comparison is bidirectional.
		assert.equal(isWithinTolerance(at(TOLERANCE + 1), NOW, TOLERANCE), false);
	});

	it('rejects non-finite inputs and a negative tolerance without throwing', () => {
		// A `t=` that did not parse as a number reaches this function as NaN. The
		// answer must be a rejection, not an exception: this runs on the request
		// path, where a throw would surface as an internal error instead of the
		// "not acceptable" answer the emitter can act on.
		assert.equal(isWithinTolerance(Number.NaN, NOW, TOLERANCE), false);
		assert.equal(isWithinTolerance(at(0), Number.NaN, TOLERANCE), false);
		assert.equal(isWithinTolerance(at(0), NOW, Number.NaN), false);
		assert.equal(isWithinTolerance(Number.POSITIVE_INFINITY, NOW, TOLERANCE), false);
		assert.equal(isWithinTolerance(Number.NEGATIVE_INFINITY, NOW, TOLERANCE), false);
		assert.equal(isWithinTolerance(at(0), NOW, Number.POSITIVE_INFINITY), false);

		// A negative tolerance describes an empty window. It cannot accept even a
		// perfectly current timestamp, and it must not be read as "no limit".
		assert.equal(isWithinTolerance(at(0), NOW, -1), false);
	});
});
