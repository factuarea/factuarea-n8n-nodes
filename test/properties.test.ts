import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { INodeProperties } from 'n8n-workflow';

import {
	LISTEN_ON_DEFAULT,
	LOAD_OPTIONS_METHOD_EVENT_TYPES,
	PARAMETER_ACCOUNT_ID,
	PARAMETER_ACCOUNT_RELATIONSHIP,
	PARAMETER_COMPANY_FILTER,
	PARAMETER_COMPANY_ID,
	PARAMETER_LISTEN_ON,
} from '../src/client/types';
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

/**
 * Whether n8n would render the property for these parameter values.
 *
 * n8n resolves a missing parameter to its declared default before it evaluates
 * `displayOptions`, which is what makes a workflow saved before account mode
 * show the company field. This helper reproduces that rule for the two shapes
 * the trigger uses (`show` with a list of accepted values) so the tests state
 * the behaviour instead of the wiring.
 */
function isShown(declared: INodeProperties, values: Record<string, unknown>): boolean {
	const show = declared.displayOptions?.show;

	if (show === undefined) {
		return true;
	}

	return Object.entries(show).every(([name, accepted]) => {
		const source = factuareaTriggerProperties.find((candidate) => candidate.name === name);
		const value = name in values ? values[name] : source?.default;

		return Array.isArray(accepted) && accepted.includes(value as never);
	});
}

describe('factuareaTriggerProperties', () => {
	it('declares exactly eight properties, with the eight frozen names', () => {
		// Eight is a contract, not a coincidence: `src/client/types.ts` enumerates
		// these names as the ones the trigger reads back, so a ninth parameter
		// here is one nothing consumes, and a missing one is a read of
		// `undefined`. The order is part of it: the mode is the first decision,
		// then the target of each mode, and the editor renders them in this order.
		assert.equal(factuareaTriggerProperties.length, 8);
		assert.deepEqual(
			factuareaTriggerProperties.map((declared) => declared.name),
			[
				'listenOn',
				'companyId',
				'accountId',
				'accountRelationship',
				'companyFilter',
				'events',
				'toleranceSeconds',
				'deduplicate',
			],
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

describe('factuareaTriggerProperties — account mode (ACC-EXT-04)', () => {
	it('offers Company and Account as the listening mode, Company by default', () => {
		const listenOn = property(PARAMETER_LISTEN_ON);

		assert.equal(listenOn.name, 'listenOn');
		assert.equal(listenOn.displayName, 'Listen On');
		assert.equal(listenOn.type, 'options');
		assert.equal(listenOn.default, 'company');
		assert.equal(listenOn.default, LISTEN_ON_DEFAULT);
		assert.deepEqual(
			(listenOn.options ?? []).map((option) => ('value' in option ? [option.name, option.value] : [])),
			[
				['Company', 'company'],
				['Account', 'account'],
			],
		);
		// The mode itself is never hidden: it is the decision everything else hangs from.
		assert.equal(listenOn.displayOptions, undefined);
	});

	it('reads a workflow saved without listenOn as company mode', () => {
		// A workflow saved before account mode has no `listenOn` value at all. n8n
		// resolves it to the declared default, so the default IS the compatibility
		// guarantee: it has to be `company`, and the company field has to render.
		assert.equal(property(PARAMETER_LISTEN_ON).default, 'company');
		assert.equal(isShown(property(PARAMETER_COMPANY_ID), {}), true);
		assert.equal(isShown(property(PARAMETER_ACCOUNT_ID), {}), false);
	});

	it('shows the company field only in company mode', () => {
		const company = property(PARAMETER_COMPANY_ID);

		assert.equal(isShown(company, { listenOn: 'company' }), true);
		assert.equal(isShown(company, { listenOn: 'account' }), false);
	});

	it('shows the account, the relationship filter and the company filter only in account mode', () => {
		for (const name of [
			PARAMETER_ACCOUNT_ID,
			PARAMETER_ACCOUNT_RELATIONSHIP,
			PARAMETER_COMPANY_FILTER,
		]) {
			const declared = property(name);

			assert.equal(isShown(declared, { listenOn: 'account' }), true, `${name} in account mode`);
			assert.equal(isShown(declared, { listenOn: 'company' }), false, `${name} in company mode`);
			assert.equal(isShown(declared, {}), false, `${name} with no mode saved`);
		}
	});

	it('keeps the events, the tolerance and deduplication in both modes', () => {
		for (const name of ['events', 'toleranceSeconds', 'deduplicate']) {
			const declared = property(name);

			assert.equal(isShown(declared, { listenOn: 'company' }), true, `${name} in company mode`);
			assert.equal(isShown(declared, { listenOn: 'account' }), true, `${name} in account mode`);
		}
	});

	it('asks for the account as a text field named Account ID, never required', () => {
		const account = property(PARAMETER_ACCOUNT_ID);

		// "Account ID" is the label the catalogued "account not selected" message
		// tells the user to fill in, so renaming it makes that message lie.
		assert.equal(account.displayName, 'Account ID');
		assert.equal(account.type, 'string');
		assert.equal(account.default, '');
		// Not required: the credential may carry the account, and a required and
		// empty parameter is a node issue that blocks activation.
		assert.notEqual(account.required, true);
		assert.equal(account.typeOptions?.loadOptionsMethod, undefined);
		assert.match(account.description ?? '', /UUID/);
	});

	it('offers the relationship filter as own, managed and all, all by default', () => {
		const relationship = property(PARAMETER_ACCOUNT_RELATIONSHIP);

		assert.equal(relationship.type, 'options');
		assert.equal(relationship.default, 'all');
		assert.deepEqual(
			(relationship.options ?? []).map((option) => ('value' in option ? option.value : undefined)),
			['own', 'managed', 'all'],
		);
	});

	it('offers an optional company filter that is empty by default', () => {
		const filter = property(PARAMETER_COMPANY_FILTER);

		assert.equal(filter.type, 'string');
		assert.equal(filter.default, '');
		assert.notEqual(filter.required, true);
		// It narrows on the `company_id` of the envelope, which is a UUID and
		// never a tax id; the description has to say so.
		assert.match(filter.description ?? '', /UUID/);
	});
});
