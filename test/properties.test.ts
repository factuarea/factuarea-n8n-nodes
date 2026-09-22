import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { INodeProperties } from 'n8n-workflow';

import { LOAD_OPTIONS_METHOD_EVENT_TYPES, PARAMETER_COMPANY_ID } from '../src/client/types';
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
 *   - a fifth property, or a renamed one, is a parameter nothing reads back, and
 *     a missing one is read as `undefined`;
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
	it('declares exactly four properties, with the four frozen names', () => {
		// Four is a contract, not a coincidence: `src/client/types.ts` enumerates
		// these names as the ones the trigger reads back, so a fifth parameter
		// here is one nothing consumes, and a missing one is a read of
		// `undefined`. The order is part of it: the company is the first decision,
		// and the editor renders them in this order.
		assert.equal(factuareaTriggerProperties.length, 4);
		assert.deepEqual(
			factuareaTriggerProperties.map((declared) => declared.name),
			['companyId', 'events', 'toleranceSeconds', 'deduplicate'],
		);
	});

	it('asks for the company as a text field, under the frozen name', () => {
		const company = property(PARAMETER_COMPANY_ID);

		// Compared against the exported constant rather than a literal: the
		// lifecycle reads the parameter back with that same constant, and a
		// rename on one side alone is a value read as `undefined` while the
		// editor shows it filled in.
		assert.equal(company.name, PARAMETER_COMPANY_ID);
		assert.equal(company.type, 'string');
		assert.equal(company.default, '');

		// No `loadOptions` here on purpose: listing the companies a key can see
		// is a call on the account axis, which a company-scoped key cannot make.
		assert.equal(company.typeOptions?.loadOptionsMethod, undefined);
		assert.equal(company.options, undefined);
	});

	it('does not mark the company required, because the credential may carry it', () => {
		// `required: true` plus an empty value is a node issue in n8n, and the
		// issue blocks activation. The README, the field description and the
		// lifecycle all offer the credential's default company as the other way
		// to fill this in, so marking it required here would make that path
		// unusable. What rejects an empty company on both sides is
		// `ERROR_COMPANY_NOT_SELECTED`, which names the two fields.
		assert.notEqual(property(PARAMETER_COMPANY_ID).required, true);
	});

	it('tells the user the company is a uuid and that it is not guessed for them', () => {
		const description = property(PARAMETER_COMPANY_ID).description ?? '';

		// Both halves are the reason this field exists. A tax id in this box
		// produces a 404 that names nothing, and a user who expects the node to
		// pick a company would read an empty field as "the default one".
		assert.match(description, /UUID/);
		assert.match(description, /path/);
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
