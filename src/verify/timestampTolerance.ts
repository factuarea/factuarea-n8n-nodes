/**
 * Replay tolerance: does a delivery's declared timestamp sit close enough to the
 * current instant to be accepted?
 *
 * The check is intentionally separate from signature verification and runs BEFORE
 * it. A captured delivery is replayed with its original signature intact, so the
 * signature says nothing about whether it is a replay; the timestamp is the only
 * thing that does. Running it first also discards replays without spending any
 * cryptographic work on them.
 *
 * ## Why the comparison is BIDIRECTIONAL
 *
 * The obvious form of this check — "reject anything older than the tolerance" —
 * is only half a check, and the missing half is the one that fails in the field.
 *
 * A one-sided check accepts any timestamp in the future, however far. That is not
 * a theoretical hole: it is the very replay window the check exists to close,
 * reopened by the receiver's own clock. If the receiver's clock runs ahead of the
 * emitter's by more than the tolerance, every legitimate delivery already looks
 * "old" and is rejected — while a delivery stamped far in the future stays valid
 * for as long as the skew lasts. An attacker who can influence the stamp, or who
 * simply captured a delivery from a host whose clock was ahead, gets a token that
 * remains replayable long after the window should have closed.
 *
 * CLOCK SKEW IS THIS CHECK'S REAL FAILURE MODE. Not a forged timestamp — the
 * timestamp is inside the signed material, so changing it invalidates the
 * signature. What actually goes wrong is that two machines disagree about what
 * time it is: a container without NTP, a virtual machine resumed from a snapshot,
 * a host that just corrected itself by minutes. Both directions of that
 * disagreement have to be bounded, which is why the decision is made on the
 * ABSOLUTE difference and the window is symmetric around `now`.
 *
 * ## Units, purity and edges
 *
 * All three arguments are in SECONDS, never milliseconds — the emitter's `t=` is
 * a Unix timestamp in seconds, and mixing the two units silently widens the
 * window by a factor of a thousand or narrows it to nothing. `now` is injected
 * rather than read from the clock so the function stays pure: the tests state the
 * instant instead of racing against it.
 *
 * Both edges are INCLUSIVE (`<=`). A delivery exactly `toleranceSeconds` away is
 * accepted. The alternative would make the configured number mean "one second
 * less than what it says", and there is nothing to gain from rejecting the edge.
 *
 * The function NEVER throws. Non-finite inputs (`NaN`, `±Infinity`, produced by a
 * header that did not parse as a number) and a negative tolerance are rejected as
 * `false` rather than raising: this runs on the request path, where an exception
 * would surface as an internal error instead of the "signature is not acceptable"
 * answer the emitter can act on. `NaN` deserves the explicit guard because every
 * comparison against it is already `false` — the guard is there so the intent is
 * written down rather than inferred from IEEE-754 behaviour.
 */

/**
 * Is a delivery whose declared timestamp is `timestamp` acceptable at `now`?
 *
 * @param timestamp        Unix timestamp in SECONDS, read from the `t=` pair of
 *                         the signature header — never from the local clock.
 * @param now              Current instant in SECONDS, injected by the caller.
 * @param toleranceSeconds Half-width of the accepted window, in SECONDS. Applied
 *                         in both directions; see the note above.
 * @returns `true` when `|now - timestamp| <= toleranceSeconds`, `false` otherwise
 *          and for any non-finite input or negative tolerance.
 */
export function isWithinTolerance(
	timestamp: number,
	now: number,
	toleranceSeconds: number,
): boolean {
	if (
		!Number.isFinite(timestamp) ||
		!Number.isFinite(now) ||
		!Number.isFinite(toleranceSeconds)
	) {
		return false;
	}

	if (toleranceSeconds < 0) {
		return false;
	}

	return Math.abs(now - timestamp) <= toleranceSeconds;
}
