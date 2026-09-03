import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { INodeProperties } from 'n8n-workflow';

import { LOAD_OPTIONS_METHOD_EVENT_TYPES } from '../src/client/types';
import {
	DEFAULT_TOLERANCE_SECONDS,
	MAX_TOLERANCE_SECONDS,
	MIN_TOLERANCE_SECONDS,
} from '../src/contract';
import { factuareaTriggerProperties } from '../src/nodes/FactuareaTrigger/properties';

/**
 * What these assertions protect is the SHAPE the editor and the node class read,
 * not the wording. n8n never type-checks a node description at runtime: it reads
 * the object, and every one of the failures below surfaces as a working-looking
 * node that quietly does the wrong thing.
 *
 *   - a fourth property, or a renamed one, is a parameter the node class reads
 *     back as `undefined`;
 *   - a missing or misspelled `loadOptionsMethod` is an event picker that opens
 *     empty, with no error anywhere;
 *   - a tolerance without bounds accepts 0 (rejects every delivery) or a value
 *     large enough to disable the replay check entirely;
 *   - an empty description is a parameter the user has to guess at, and this
 *     package's whole reason for being in English is that people read it.
 */

/** The property with that `name`, asserted to exist so callers get a value. */
function property(name: string): INodeProperties {
	const found = factuareaTriggerProperties.find((candidate) => candidate.name === name);
	assert.ok(found, `no property is declared with the name "${name}"`);
	return found;
}

describe('factuareaTriggerProperties', () => {
	it('declares exactly three properties, with the three frozen names', () => {
		// Three is a contract, not a coincidence: `src/client/types.ts` enumerates
		// these names as the ones the trigger reads back, so a fourth parameter
		// here is one nothing consumes, and a missing one is a read of `undefined`.
		assert.equal(factuareaTriggerProperties.length, 3);
		assert.deepEqual(
			factuareaTriggerProperties.map((declared) => declared.name),
			['events', 'toleranceSeconds', 'deduplicate'],
		);
	});

	it('offers the events as a multi-select filled by the frozen load-options method', () => {
		const events = property('events');

		assert.equal(events.type, 'multiOptions');
		assert.deepEqual(events.default, []);
		assert.equal(events.required, true);

		// Compared against the exported constant rather than a literal on purpose:
		// the node class registers the method under that same constant, so the two
		// sides cannot drift into a typo that produces an empty picker.
		assert.equal(events.typeOptions?.loadOptionsMethod, LOAD_OPTIONS_METHOD_EVENT_TYPES);

		// No hard-coded option list. Offering a frozen list would let the user pick
		// an event the API rejects with 422, and would need a release to grow.
		assert.equal(events.options, undefined);
	});

	it('bounds the tolerance at both ends and defaults to the documented window', () => {
		const tolerance = property('toleranceSeconds');

		assert.equal(tolerance.type, 'number');
		assert.equal(tolerance.default, DEFAULT_TOLERANCE_SECONDS);
		assert.equal(tolerance.typeOptions?.minValue, MIN_TOLERANCE_SECONDS);
		assert.equal(tolerance.typeOptions?.maxValue, MAX_TOLERANCE_SECONDS);

		// The bounds have to be a real interval containing the default, or the
		// editor would refuse the value the node ships with.
		assert.ok(MIN_TOLERANCE_SECONDS < MAX_TOLERANCE_SECONDS);
		assert.ok(DEFAULT_TOLERANCE_SECONDS >= MIN_TOLERANCE_SECONDS);
		assert.ok(DEFAULT_TOLERANCE_SECONDS <= MAX_TOLERANCE_SECONDS);
	});

	it('turns deduplication on by default', () => {
		const deduplicate = property('deduplicate');

		assert.equal(deduplicate.type, 'boolean');
		// On by default because the emitter retries: a node that ships with this
		// off would repeat every effect of the workflow on the first timeout.
		assert.equal(deduplicate.default, true);
	});

	it('gives every property a non-empty description', () => {
		for (const declared of factuareaTriggerProperties) {
			assert.equal(
				typeof declared.description,
				'string',
				`property "${declared.name}" has no description`,
			);
			assert.ok(
				(declared.description ?? '').trim().length > 0,
				`property "${declared.name}" has an empty description`,
			);
		}
	});
});
