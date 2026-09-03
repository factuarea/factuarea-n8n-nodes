import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { INodeProperties } from 'n8n-workflow';

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
	});
});
