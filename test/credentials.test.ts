import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { INodeProperties } from 'n8n-workflow';

import { CREDENTIAL_FIELD_ACCOUNT_ID } from '../src/client/types';
import { DEFAULT_API_BASE_URL } from '../src/contract';
import { FactuareaApi } from '../src/credentials/FactuareaApi.credentials';

function propertyNamed(
	properties: INodeProperties[],
	name: string,
): INodeProperties {
	const property = properties.find((candidate) => candidate.name === name);
	assert.ok(property, `the credential declares no property named "${name}"`);

	return property;
}

describe('FactuareaApi credential', () => {
	it('is registered under the type name the node and the client look up', () => {
		const credential = new FactuareaApi();

		// `package.json` points n8n at the compiled file, but what the trigger asks
		// for at runtime is this string (`getCredentials('factuareaApi')`). The two
		// are written by different phases, so renaming it here breaks the node with
		// a "credentials not found" error and nothing else.
		assert.equal(credential.name, 'factuareaApi');
		assert.equal(credential.displayName, 'Factuarea API');
	});

	it('marks the API key as a secret and leaves the base URL visible', () => {
		const credential = new FactuareaApi();

		const apiKey = propertyNamed(credential.properties, 'apiKey');
		assert.equal(apiKey.typeOptions?.password, true);

		// The other direction matters too: masking the base URL would hide the one
		// field a user has to read and edit to point the node at another
		// environment, and it is not a secret.
		const baseUrl = propertyNamed(credential.properties, 'baseUrl');
		assert.notEqual(baseUrl.typeOptions?.password, true);
	});

	it('defaults the base URL to the frozen production value', () => {
		const credential = new FactuareaApi();

		const baseUrl = propertyNamed(credential.properties, 'baseUrl');
		assert.equal(baseUrl.default, DEFAULT_API_BASE_URL);
		assert.equal(baseUrl.default, 'https://api.factuarea.com/v1');
	});

	it('stops the base URL at the version segment and never swallows the company', () => {
		const credential = new FactuareaApi();

		const baseUrl = propertyNamed(credential.properties, 'baseUrl');
		const declared = String(baseUrl.default);

		// The webhook routes carry `companies/{company}` in their path, and the
		// tempting shortcut is to paste it into this field once. It would break
		// the two calls that hang from this base with no prefix at all: the event
		// catalogue and the credential test below. So the default ends at the
		// version, and nothing after it.
		assert.equal(declared.endsWith('/v1'), true, declared);
		assert.doesNotMatch(declared, /companies/);
		assert.doesNotMatch(declared, /\{company\}/);
	});

	it('carries a company of its own, typed rather than inferred', () => {
		const credential = new FactuareaApi();

		const company = propertyNamed(credential.properties, 'companyId');

		// It backs the node's own Company ID field for an account that works with
		// a single company. It is NOT required: a workflow that names its company
		// in the node needs nothing here, and a credential written before the
		// company axis keeps working as long as the node names one.
		assert.equal(company.type, 'string');
		assert.equal(company.default, '');
		assert.notEqual(company.required, true);
		assert.notEqual(company.typeOptions?.password, true);
	});

	it('carries an optional Default Account ID, empty by default, typed rather than inferred', () => {
		const credential = new FactuareaApi();

		const account = propertyNamed(credential.properties, CREDENTIAL_FIELD_ACCOUNT_ID);

		// Backs the Account ID field of the node in account mode, exactly as the
		// company field backs the Company ID one. The label is the one the
		// catalogued "account not selected" message tells the user to fill in.
		assert.equal(account.displayName, 'Default Account ID');
		assert.equal(account.type, 'string');
		assert.equal(account.default, '');
		assert.notEqual(account.required, true);
		assert.notEqual(account.typeOptions?.password, true);

		// It is typed by the integrator and used only by account mode; the
		// description has to say both, because an empty field is legal.
		const description = account.description ?? '';
		assert.match(description, /never inferred/i);
		assert.match(description, /account mode/i);
	});

	it('keeps the company field and the account field apart', () => {
		const credential = new FactuareaApi();

		const names = credential.properties.map((declared) => declared.name);
		assert.deepEqual(names, ['apiKey', 'baseUrl', 'companyId', CREDENTIAL_FIELD_ACCOUNT_ID]);
	});

	it('keeps the base URL on the version segment, with neither an account nor a company', () => {
		const credential = new FactuareaApi();

		const baseUrl = propertyNamed(credential.properties, 'baseUrl');
		const declared = String(baseUrl.default);

		// Account webhook routes carry `accounts/{account}` in their path. Pasting
		// it into the base URL would break the catalogue and the credential test,
		// which hang from the root with no prefix at all.
		assert.equal(declared.endsWith('/v1'), true, declared);
		assert.doesNotMatch(declared, /accounts/);
		assert.doesNotMatch(declared, /\{account\}/);
		assert.doesNotMatch(String(credential.test.request.url), /accounts/);
	});

	it('authenticates every request with a bearer header built from the key', () => {
		const credential = new FactuareaApi();

		assert.deepEqual(credential.authenticate, {
			type: 'generic',
			properties: {
				headers: {
					Authorization: '=Bearer {{$credentials.apiKey}}',
				},
			},
		});
	});

	it('tests the credential against the read-only event catalogue', () => {
		const credential = new FactuareaApi();

		// A read route: pressing "Test" creates no webhook destination, consumes no
		// write quota, and exercises the `events:read` scope the event picker needs.
		assert.equal(credential.test.request.method, 'GET');
		assert.equal(
			credential.test.request.url,
			'={{$credentials.baseUrl}}/event-catalog',
		);

		// And it stays on the ROOT. Prefixing the one call a user presses to
		// check their key would report every valid credential as broken.
		assert.doesNotMatch(credential.test.request.url, /companies/);
	});
});
