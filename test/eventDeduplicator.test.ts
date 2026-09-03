import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEDUPE_CAPACITY } from '../src/contract';
import {
	createEventDeduplicator,
	type DeduplicationState,
} from '../src/dedupe/eventDeduplicator';

describe('createEventDeduplicator', () => {
	it('reports an unknown event id as not yet seen', () => {
		const deduplicator = createEventDeduplicator();
		const state: DeduplicationState = {};

		strictEqual(deduplicator.hasSeen(state, '0199a1b2-c3d4-7000-8000-000000000001'), false);
	});

	it('reports the same event id as seen once it has been marked', () => {
		const deduplicator = createEventDeduplicator();
		const state: DeduplicationState = {};
		const eventId = '0199a1b2-c3d4-7000-8000-000000000001';

		deduplicator.markSeen(state, eventId);

		ok(deduplicator.hasSeen(state, eventId));
	});

	it('does not let two distinct event ids interfere with each other', () => {
		const deduplicator = createEventDeduplicator();
		const state: DeduplicationState = {};
		const first = '0199a1b2-c3d4-7000-8000-000000000001';
		const second = '0199a1b2-c3d4-7000-8000-000000000002';

		deduplicator.markSeen(state, first);

		ok(deduplicator.hasSeen(state, first));
		strictEqual(deduplicator.hasSeen(state, second), false);

		deduplicator.markSeen(state, second);

		ok(deduplicator.hasSeen(state, first));
		ok(deduplicator.hasSeen(state, second));
	});

	it('evicts the oldest entry and keeps the newest once the capacity is exceeded', () => {
		const deduplicator = createEventDeduplicator(3);
		const state: DeduplicationState = {};

		deduplicator.markSeen(state, 'oldest');
		deduplicator.markSeen(state, 'second');
		deduplicator.markSeen(state, 'third');
		deduplicator.markSeen(state, 'newest');

		strictEqual(deduplicator.hasSeen(state, 'oldest'), false);
		ok(deduplicator.hasSeen(state, 'second'));
		ok(deduplicator.hasSeen(state, 'third'));
		ok(deduplicator.hasSeen(state, 'newest'));
		deepStrictEqual(state.seenEventIds, ['second', 'third', 'newest']);
	});

	it('mutates the state object in place, because n8n persists it by reference', () => {
		const deduplicator = createEventDeduplicator();
		const state: DeduplicationState = {};

		deduplicator.markSeen(state, 'event-1');

		deepStrictEqual(state.seenEventIds, ['event-1']);
	});

	it('neither duplicates nor promotes an event id that is already remembered', () => {
		const deduplicator = createEventDeduplicator(3);
		const state: DeduplicationState = {};

		deduplicator.markSeen(state, 'first');
		deduplicator.markSeen(state, 'second');
		deduplicator.markSeen(state, 'first');

		// First-seen order is kept, so the repeat did not buy 'first' a longer stay.
		deepStrictEqual(state.seenEventIds, ['first', 'second']);
	});

	it('reads a state that already carries remembered ids without discarding them', () => {
		const deduplicator = createEventDeduplicator(3);
		const state: DeduplicationState = { seenEventIds: ['restored'] };

		ok(deduplicator.hasSeen(state, 'restored'));

		deduplicator.markSeen(state, 'fresh');

		deepStrictEqual(state.seenEventIds, ['restored', 'fresh']);
	});

	it('remembers up to the package default capacity when none is given', () => {
		const deduplicator = createEventDeduplicator();
		const state: DeduplicationState = {};

		for (let index = 0; index < DEDUPE_CAPACITY; index += 1) {
			deduplicator.markSeen(state, `event-${index}`);
		}

		ok(deduplicator.hasSeen(state, 'event-0'));
		strictEqual(state.seenEventIds?.length, DEDUPE_CAPACITY);

		deduplicator.markSeen(state, 'one-too-many');

		strictEqual(deduplicator.hasSeen(state, 'event-0'), false);
		ok(deduplicator.hasSeen(state, 'one-too-many'));
		strictEqual(state.seenEventIds?.length, DEDUPE_CAPACITY);
	});

	it('rejects a capacity that would silently disable the guarantee', () => {
		for (const capacity of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			throws(() => createEventDeduplicator(capacity), RangeError);
		}
	});
});
