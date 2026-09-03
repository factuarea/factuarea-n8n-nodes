/**
 * Remembers which events this trigger has already turned into a workflow item,
 * so a redelivery of the same event does not run the workflow a second time.
 *
 * Factuarea retries any delivery that does not answer with success. Measured
 * against `backend/app/Webhooks/Domain/Service/RetryScheduleCalculator.php`, the
 * emitter makes up to 8 attempts on the schedule `1m, 5m, 30m, 2h, 12h, 1d, 3d`
 * (plus jitter), so a duplicate is not hypothetical: a response this instance
 * never manages to deliver — a timeout, a proxy dropping the connection, a
 * restart between the workflow running and the reply being written — produces a
 * second delivery of an event that was already processed. A workflow with
 * effects (issuing a document, emailing a client) would perform them twice.
 *
 * The event id is the right key for this and the delivery id is not: the event
 * id is stable across retries of the same event, while the delivery id changes
 * on every attempt (`src/contract.ts`).
 *
 * ## The state object belongs to n8n, and is mutated in place
 *
 * `state` is the plain object n8n hands back from `getWorkflowStaticData('node')`
 * and persists per node. It is plain on purpose: n8n serialises it, so anything
 * that is not JSON — a `Set`, a `Map`, a class instance — would not survive the
 * round trip and the memory would silently reset to empty on the next restart.
 *
 * Both operations therefore work on an array of strings, and `markSeen` MUTATES
 * that array in place rather than returning a new state. n8n keeps the object by
 * reference and writes back whatever it holds; a `markSeen` that returned a fresh
 * object would leave the caller's persisted state untouched and the deduplication
 * would do nothing at all, without any error to explain it.
 *
 * ## Accepted limitation: deduplication is a guarantee of the ACTIVE mode
 *
 * In a manual test execution from the n8n editor, the node's static data may not
 * be persisted between runs. Firing the same event twice by hand can therefore
 * produce two items, and that is not a defect of this module: the memory it reads
 * is empty because nothing kept it. Deduplication is a guarantee of a workflow
 * running in active mode, which is the mode Factuarea actually delivers to.
 *
 * ## Frozen decision: a repeat does NOT move to the end of the window
 *
 * Entries keep their FIRST-SEEN order for as long as they are remembered, and
 * `markSeen` on an id already inside the window is a no-op — it neither appends a
 * duplicate nor promotes the entry. The alternative (least-recently-seen order,
 * promoting on every repeat) was rejected: it makes how long an id is remembered
 * depend on how many times it was retried, so the window stops being a property
 * anyone can state, and it would extend the memory only of the id that is already
 * arriving again — never of the quiet one that is actually at risk of falling out.
 * Strict first-seen order makes the window exactly "the last `capacity` distinct
 * events", which is what the accompanying documentation can honestly promise.
 */

import { DEDUPE_CAPACITY } from '../contract';

/**
 * The slice of the node's persisted static data this module owns.
 *
 * `seenEventIds` is optional so a node that has never received a delivery — whose
 * static data is `{}` — works without anybody seeding it first.
 */
export interface DeduplicationState {
	seenEventIds?: string[];
}

export interface EventDeduplicator {
	/** True when `eventId` is still inside the remembered window. Never mutates. */
	hasSeen(state: DeduplicationState, eventId: string): boolean;

	/**
	 * Records `eventId` as processed, evicting the oldest entries once the window
	 * is full. Mutates `state` in place, which is why it returns nothing.
	 */
	markSeen(state: DeduplicationState, eventId: string): void;
}

/**
 * Builds a deduplicator over a window of `capacity` event ids.
 *
 * `capacity` defaults to `DEDUPE_CAPACITY` and must be a positive integer. The
 * three values that are not are rejected instead of tolerated, because each one
 * disables the guarantee silently rather than loudly: `0` would evict every entry
 * as soon as it was written, so nothing is ever remembered; `Infinity` would never
 * evict, so the state grows for the lifetime of the n8n process — the exact
 * failure the cap exists to prevent; and `NaN` compares false against everything,
 * which also never evicts. All three leave a deduplicator that reports success
 * while protecting nothing.
 */
export function createEventDeduplicator(
	capacity: number = DEDUPE_CAPACITY,
): EventDeduplicator {
	if (!Number.isInteger(capacity) || capacity <= 0) {
		throw new RangeError(
			'The deduplication capacity must be a positive integer. Pass a whole number greater than zero, or omit the argument to use the package default.',
		);
	}

	return {
		hasSeen(state: DeduplicationState, eventId: string): boolean {
			return state.seenEventIds?.includes(eventId) ?? false;
		},

		markSeen(state: DeduplicationState, eventId: string): void {
			if (state.seenEventIds === undefined) {
				state.seenEventIds = [];
			}

			const seenEventIds = state.seenEventIds;

			if (seenEventIds.includes(eventId)) {
				return;
			}

			seenEventIds.push(eventId);

			// One splice rather than a loop of shifts: it also trims a state that
			// was persisted under a larger capacity and is read back under a
			// smaller one, which a single-entry eviction would take as many
			// deliveries to work through as the difference between the two.
			const overflow = seenEventIds.length - capacity;

			if (overflow > 0) {
				seenEventIds.splice(0, overflow);
			}
		},
	};
}
