import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_API_BASE_URL } from '../src/contract';
import {
	createFactuareaApiClient,
	describeInactiveAccountEndpoint,
} from '../src/client/factuareaApiClient';
import {
	ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY,
	ERROR_ACCOUNT_ENDPOINT_LIMIT_REACHED,
	ERROR_ACCOUNT_NOT_SELECTED,
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_ACCOUNT_WEBHOOKS_ADDON_REQUIRED,
	ERROR_ACCOUNT_CAPABILITY_REQUIRED,
	ERROR_ENDPOINT_GONE,
	ERROR_ENDPOINT_LIMIT_REACHED,
	ERROR_ENDPOINT_URL_NOT_ACCEPTED,
	ERROR_EVENT_CATALOG_UNAVAILABLE,
	ERROR_INSUFFICIENT_SCOPE,
	ERROR_LIVE_CREDENTIAL_REQUIRED,
	ERROR_NO_EVENTS_SELECTED,
} from '../src/errors';
import type {
	FactuareaHttpRequestOptions,
	FactuareaHttpRequester,
} from '../src/client/types';

/**
 * The client is exercised through a double of the HTTP helper n8n injects.
 *
 * That is the whole reason the helper is a constructor argument instead of an
 * import: the double is a plain function, so these tests need no mocking
 * library and the package keeps its empty dependency list.
 */

const API_KEY = 'fk_live_thisisnotarealkey';
const ENDPOINT_ID = '019251c0-0000-7000-8000-00000000abcd';

/**
 * The company whose destinations the three endpoint operations address.
 *
 * A uuid, because that is what the `{company}` segment of the public API
 * matches (`whereUuid('company')`). A tax id here would be the mistake the node
 * exists to make impossible.
 */
const COMPANY_ID = '019251c0-0000-7000-8000-00000000fa01';

/** One programmed answer: either what the helper resolves with, or what it throws. */
type Programmed = { readonly resolve: unknown } | { readonly reject: unknown };

interface Double {
	readonly request: FactuareaHttpRequester;
	readonly calls: FactuareaHttpRequestOptions[];
}

/** A helper double that records every call and answers from a queue, in order. */
function helperDouble(...programmed: Programmed[]): Double {
	const calls: FactuareaHttpRequestOptions[] = [];
	const queue = [...programmed];

	const request: FactuareaHttpRequester = async (options) => {
		calls.push(options);
		const next = queue.shift();

		if (next === undefined) {
			throw new Error('The double was called more times than it was programmed for.');
		}

		if ('reject' in next) {
			throw next.reject;
		}

		return next.resolve;
	};

	return { request, calls };
}

/** A full HTTP answer, the shape the helper returns under `returnFullResponse`. */
function answer(statusCode: number, body: unknown): Programmed {
	return { resolve: { statusCode, body, headers: {} } };
}

/** The v1 error envelope, as the API renders it. */
function errorBody(
	statusCode: number,
	error: { type: string; code: string; subcode?: string; message: string; param?: string },
): Programmed {
	return answer(statusCode, { error });
}

/**
 * The only call the double received.
 *
 * `noUncheckedIndexedAccess` makes `calls[0]` possibly undefined, and asserting
 * the count here means every test that reads a call has also pinned how many
 * requests the operation made.
 */
function onlyCall(double: Double): FactuareaHttpRequestOptions {
	assert.equal(double.calls.length, 1, 'the operation should perform exactly one request');
	const [call] = double.calls;
	assert.ok(call !== undefined);

	return call;
}

function client(double: Double, baseUrl: string = DEFAULT_API_BASE_URL) {
	return createFactuareaApiClient(double.request, { baseUrl, apiKey: API_KEY });
}

/** A destination as the v1 API renders it, with all eighteen keys. */
function endpointResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: ENDPOINT_ID,
		object: 'webhook_endpoint',
		url: 'https://n8n.example.com/webhook/factuarea',
		description: 'n8n trigger',
		enabled_events: ['invoice.paid'],
		status: 'active',
		ip_allowlist: null,
		delivery_success_rate_24h: null,
		last_delivery_at: null,
		last_failure_at: null,
		previous_secret_valid_until: null,
		created_at: '2026-09-02T10:00:00+00:00',
		updated_at: '2026-09-02T10:00:00+00:00',
		api_version: null,
		metadata: {},
		custom_headers: {},
		timeout_seconds: 10,
		degraded_since: null,
		...overrides,
	};
}

describe('createFactuareaApiClient — request shape', () => {
	it('registers a destination with POST, the bearer key and the chosen events', async () => {
		const double = helperDouble(
			answer(201, { data: endpointResource({ secret: 'whsec_0123456789abcdef0123456789abcdef' }) }),
		);

		const created = await client(double).createWebhookEndpoint(COMPANY_ID, {
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid', 'invoice.created'],
			description: 'n8n trigger',
		});

		const call = onlyCall(double);
		assert.equal(call.method, 'POST');
		assert.equal(
			call.url,
			`https://api.factuarea.com/v1/companies/${COMPANY_ID}/webhook-endpoints`,
		);
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);
		assert.equal(call.headers['Content-Type'], 'application/json');
		assert.equal(call.json, true);
		assert.deepEqual(call.body, {
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid', 'invoice.created'],
			description: 'n8n trigger',
		});

		// The secret comes back exactly once, from this call and no other.
		assert.equal(created.secret, 'whsec_0123456789abcdef0123456789abcdef');
		assert.equal(created.id, ENDPOINT_ID);
	});

	it('does not double the version segment when the base URL ends in a slash', async () => {
		const double = helperDouble(answer(200, { data: [] }));

		await client(double, 'https://api.factuarea.com/v1/').listEventCatalog();

		// A credential pasted with a trailing slash is the ordinary case, and
		// `//event-catalog` is a 404 the user could not diagnose.
		assert.equal(onlyCall(double).url, 'https://api.factuarea.com/v1/event-catalog');
	});

	it('reads a destination with GET on its own path', async () => {
		const double = helperDouble(answer(200, { data: endpointResource() }));

		const found = await client(double).getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);

		const call = onlyCall(double);
		assert.equal(call.method, 'GET');
		assert.equal(
			call.url,
			`https://api.factuarea.com/v1/companies/${COMPANY_ID}/webhook-endpoints/${ENDPOINT_ID}`,
		);
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);
		assert.equal(call.body, undefined, 'a read must not carry a body');
		assert.equal(found?.id, ENDPOINT_ID);
	});

	it('removes a destination with DELETE and accepts the empty 204 answer', async () => {
		const double = helperDouble(answer(204, undefined));

		await client(double).deleteWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);

		const call = onlyCall(double);
		assert.equal(call.method, 'DELETE');
		assert.equal(
			call.url,
			`https://api.factuarea.com/v1/companies/${COMPANY_ID}/webhook-endpoints/${ENDPOINT_ID}`,
		);
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);
	});

	it('reads the event catalogue with GET and keeps only the available entries', async () => {
		const double = helperDouble(
			answer(200, {
				data: [
					{ name: 'invoice.paid', category: 'invoice', description: 'Factura cobrada', status: 'available' },
					{ name: 'order.received', category: 'order', description: 'Pedido recibido', status: 'coming_soon' },
					{ name: 'quote.accepted', category: 'quote', description: 'Presupuesto aceptado', status: 'available' },
				],
			}),
		);

		const entries = await client(double).listEventCatalog();

		const call = onlyCall(double);
		assert.equal(call.method, 'GET');
		assert.equal(call.url, 'https://api.factuarea.com/v1/event-catalog');
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);

		// An entry the catalogue announces but does not emit yet is rejected with
		// 422 by the creation call, so offering it would produce an error the
		// user could not act on.
		assert.deepEqual(
			entries.map((entry) => entry.name),
			['invoice.paid', 'quote.accepted'],
		);
	});
});

describe('createFactuareaApiClient — the company axis of the three endpoint calls', () => {
	/**
	 * The three paths, written out in full rather than composed.
	 *
	 * Composing them from the same helper the client uses would pin nothing: the
	 * point of this test is that the STRING the published API answers to is the
	 * one this package builds, so the expectation is a literal, spelled with the
	 * company segment in front and the resource in a HYPHEN. The underscore form
	 * this replaces now answers 404.
	 */
	const CREATE_PATH =
		'https://api.factuarea.com/v1/companies/019251c0-0000-7000-8000-00000000fa01/webhook-endpoints';
	const ONE_ENDPOINT_PATH = `${CREATE_PATH}/019251c0-0000-7000-8000-00000000abcd`;

	it('registers on the frozen company path', async () => {
		const double = helperDouble(answer(201, { data: endpointResource({ secret: 'whsec_a' }) }));

		await client(double).createWebhookEndpoint(COMPANY_ID, {
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid'],
		});

		assert.equal(onlyCall(double).url, CREATE_PATH);
	});

	it('reads on the frozen company path', async () => {
		const double = helperDouble(answer(200, { data: endpointResource() }));

		await client(double).getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);

		assert.equal(onlyCall(double).url, ONE_ENDPOINT_PATH);
	});

	it('removes on the frozen company path', async () => {
		const double = helperDouble(answer(204, undefined));

		await client(double).deleteWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);

		assert.equal(onlyCall(double).url, ONE_ENDPOINT_PATH);
	});

	it('leaves no underscore form of the resource anywhere in the three paths', async () => {
		const double = helperDouble(
			answer(201, { data: endpointResource({ secret: 'whsec_a' }) }),
			answer(200, { data: endpointResource() }),
			answer(204, undefined),
		);
		const api = client(double);

		await api.createWebhookEndpoint(COMPANY_ID, {
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid'],
		});
		await api.getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);
		await api.deleteWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);

		assert.equal(double.calls.length, 3);

		for (const call of double.calls) {
			// Both halves matter. The first is the route that no longer exists;
			// the second is the company segment, whose absence is what made the
			// old route work and what makes the new one 404.
			assert.doesNotMatch(call.url, /webhook_endpoints/, call.url);
			assert.match(call.url, /\/companies\/019251c0-0000-7000-8000-00000000fa01\//, call.url);
		}
	});

	it('escapes the company so a pasted value cannot compose another route', async () => {
		const double = helperDouble(answer(200, { data: endpointResource() }));

		await client(double).getWebhookEndpoint('../accounts/somebody-else', ENDPOINT_ID);

		// A uuid never needs escaping; a pasted mistake does, and a path that
		// climbed out of the company segment would be answered by a route the
		// user never meant to call.
		assert.equal(
			onlyCall(double).url,
			`https://api.factuarea.com/v1/companies/..%2Faccounts%2Fsomebody-else/webhook-endpoints/${ENDPOINT_ID}`,
		);
	});

	it('keeps the event catalogue on the root, with no company segment and no company argument', async () => {
		const double = helperDouble(answer(200, { data: [] }));

		// The signature itself is the guarantee: there is nowhere to pass a
		// company, so no caller can prefix this route by accident.
		await client(double).listEventCatalog();

		const call = onlyCall(double);
		assert.equal(call.url, 'https://api.factuarea.com/v1/event-catalog');
		assert.doesNotMatch(call.url, /companies/, call.url);
	});
});

/** RFC 4122 version 4, which is what `crypto.randomUUID()` produces. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createFactuareaApiClient — idempotency key on the writes', () => {
	it('sends a fresh key on the write that registers a destination', async () => {
		const double = helperDouble(
			answer(201, { data: endpointResource({ secret: 'whsec_0123456789abcdef0123456789abcdef' }) }),
		);

		await client(double).createWebhookEndpoint(COMPANY_ID, {
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid'],
		});

		const key = onlyCall(double).headers['Idempotency-Key'];
		assert.ok(key !== undefined, 'the creation write must carry an idempotency key');
		assert.match(key, UUID_V4);
	});

	it('sends a fresh key on the write that removes a destination', async () => {
		// This is the one that matters. `OpenApiOperationScopeRegistry` declares
		// the delete `irreversible: true`, and an irreversible operation is
		// elevated into requiring a key by its identifier regardless of its
		// family. Once a cutoff date is configured, a DELETE without this header
		// answers 422 and DEACTIVATING a workflow starts failing.
		const double = helperDouble(answer(204, undefined));

		await client(double).deleteWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);

		const key = onlyCall(double).headers['Idempotency-Key'];
		assert.ok(key !== undefined, 'the removal write must carry an idempotency key');
		assert.match(key, UUID_V4);
	});

	it('never reuses a key between two invocations', async () => {
		// The key makes a RETRY safe; it must not make two deliberate calls
		// collapse into one. A stored key would replay the first answer and hand
		// back a destination, and a secret, that no longer exists.
		const double = helperDouble(
			answer(201, { data: endpointResource({ secret: 'whsec_first' }) }),
			answer(201, { data: endpointResource({ secret: 'whsec_second' }) }),
		);
		const api = client(double);
		const input = { url: 'https://n8n.example.com/webhook/factuarea', enabled_events: ['invoice.paid'] };

		await api.createWebhookEndpoint(COMPANY_ID, input);
		await api.createWebhookEndpoint(COMPANY_ID, input);

		assert.equal(double.calls.length, 2);
		const [first, second] = double.calls;
		assert.ok(first !== undefined && second !== undefined);
		assert.notEqual(first.headers['Idempotency-Key'], second.headers['Idempotency-Key']);
	});

	it('does not put a key on the reads, which have nothing to replay', async () => {
		const readDouble = helperDouble(answer(200, { data: endpointResource() }));
		await client(readDouble).getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);
		assert.equal(onlyCall(readDouble).headers['Idempotency-Key'], undefined);

		const catalogueDouble = helperDouble(answer(200, { data: [] }));
		await client(catalogueDouble).listEventCatalog();
		assert.equal(onlyCall(catalogueDouble).headers['Idempotency-Key'], undefined);
	});
});

describe('createFactuareaApiClient — failure translation', () => {
	it('translates the egress rejection of a private address into the URL message', async () => {
		// Measured: `WebhookUrlTargetRejectedException` emits `invalid_url_target`
		// with `param=url` when `EgressHostPolicy` refuses the host.
		const double = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'invalid_url_target',
				message: 'El destino de la URL no está permitido.',
				param: 'url',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://10.0.0.4/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		);
	});

	it('translates the plain URL validation failure into the same URL message', async () => {
		// The other measured shape of the same user-visible problem: the
		// `regex:/^https:\/\//i` rule of the FormRequest, rendered by
		// `ExceptionRenderer` as `invalid_param_value` with the failing field.
		const double = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'invalid_param_value',
				message: "El campo 'url' debe ser una URL HTTPS.",
				param: 'url',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'http://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		);
	});

	it('translates the destination limit into the limit message, told apart by its subcode', async () => {
		// Same status and same generic code as fourteen other 422s of the
		// bounded context: the subcode is the only thing that identifies it, and
		// reading only the status would send the user to fix their URL.
		const double = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'business_rule_violation',
				subcode: 'max_webhook_endpoints_reached',
				message: 'Has alcanzado el máximo de 10 endpoints del tier pro. Mejora tu plan para añadir más.',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_ENDPOINT_LIMIT_REACHED,
		);
	});

	it('does not confuse a different 422 of the same generic code with the limit', async () => {
		// `business_rule_violation` without the limit subcode is some other rule
		// entirely; claiming the account is full would be a lie.
		const double = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'business_rule_violation',
				subcode: 'webhook_endpoint_degraded',
				message: 'El endpoint está degradado.',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) =>
				error instanceof Error &&
				error.message !== ERROR_ENDPOINT_LIMIT_REACHED &&
				error.message !== ERROR_ENDPOINT_URL_NOT_ACCEPTED &&
				error.message.includes('HTTP 422'),
		);
	});

	it('translates an empty event selection into the message about the Events field', async () => {
		// `enabled_events` is `required|array|min:1`, and the renderer sets `param`
		// to the first failing key. Without this branch the answer falls through to
		// the composed message, which tells the user to check an API key that is
		// perfectly valid while the field to fix sits in the editor.
		const double = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'invalid_param_value',
				message: "El campo 'enabled_events' es obligatorio.",
				param: 'enabled_events',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: [] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_NO_EVENTS_SELECTED,
		);
	});

	it('does not read a rejected event NAME as an empty selection', async () => {
		// An element the catalogue refuses fails as `enabled_events.0`, not as
		// `enabled_events`. Telling that user to select an event they already
		// selected would be the wrong instruction, so it keeps the composed
		// message and its status.
		const double = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'invalid_param_value',
				message: 'El evento seleccionado no es suscribible.',
				param: 'enabled_events.0',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.imagined'] }),
			(error: unknown) =>
				error instanceof Error &&
				error.message !== ERROR_NO_EVENTS_SELECTED &&
				error.message.includes('HTTP 422'),
		);
	});

	it('translates a 403 into the missing-permission message', async () => {
		const double = helperDouble(
			errorBody(403, {
				type: 'authorization_error',
				code: 'insufficient_scope',
				message: 'La API key no tiene el scope webhooks:write.',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_INSUFFICIENT_SCOPE,
		);
	});

	it('translates a 403 on the catalogue into the missing-permission message too', async () => {
		// The catalogue needs `events:read`, and `ERROR_INSUFFICIENT_SCOPE` names
		// it and where to grant it. "The list could not be loaded" would not.
		const double = helperDouble(
			errorBody(403, {
				type: 'authorization_error',
				code: 'insufficient_scope',
				message: 'La API key no tiene el scope events:read.',
			}),
		);

		await assert.rejects(
			client(double).listEventCatalog(),
			(error: unknown) => error instanceof Error && error.message === ERROR_INSUFFICIENT_SCOPE,
		);
	});

	it('translates a 404 on a destination operation into the gone message', async () => {
		const double = helperDouble(
			errorBody(404, {
				type: 'not_found_error',
				code: 'webhook_endpoint_not_found',
				message: 'El endpoint no existe.',
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_ENDPOINT_GONE,
		);
	});

	it('answers a missing destination with null instead of an error on read', async () => {
		// "It no longer exists" is a lifecycle answer, not a failure: the trigger
		// reacts to it by registering a new destination.
		const double = helperDouble(
			errorBody(404, {
				type: 'not_found_error',
				code: 'webhook_endpoint_not_found',
				message: 'El endpoint no existe.',
			}),
		);

		assert.equal(await client(double).getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID), null);
	});

	it('treats a missing destination as a successful removal', async () => {
		// Deactivating a workflow twice, or one whose destination was deleted
		// from the dashboard, reaches the end state that was asked for.
		const double = helperDouble(
			errorBody(404, {
				type: 'not_found_error',
				code: 'webhook_endpoint_not_found',
				message: 'El endpoint no existe.',
			}),
		);

		await client(double).deleteWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);
		assert.equal(double.calls.length, 1);
	});

	it('reports a failed catalogue read instead of falling back to a fixed list', async () => {
		const double = helperDouble(answer(500, { error: { type: 'api_error', code: 'internal_error', message: 'Error.' } }));

		await assert.rejects(
			client(double).listEventCatalog(),
			(error: unknown) => error instanceof Error && error.message === ERROR_EVENT_CATALOG_UNAVAILABLE,
		);
	});
});

describe('createFactuareaApiClient — nothing of the response reaches the message', () => {
	it('keeps the API message and the account data of an unmapped failure out of the error', async () => {
		// A response body can carry account data, and a workflow error is stored,
		// screenshotted and pasted into support tickets. The status is reported;
		// the body is read for its code and then discarded.
		const double = helperDouble(
			answer(409, {
				error: {
					type: 'invalid_request_error',
					code: 'resource_conflict',
					message: 'El cliente Ferretería Núñez S.L. (B12345678) ya tiene un endpoint.',
					param: 'url',
				},
			}),
		);

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes('HTTP 409'), 'the status is worth reporting');
				assert.ok(!error.message.includes('Ferretería'), 'the account name must not leak');
				assert.ok(!error.message.includes('B12345678'), 'the tax id must not leak');
				assert.ok(!error.message.includes('resource_conflict'), 'the raw code is not user-facing');

				return true;
			},
		);
	});

	it('never puts the API key into a message', async () => {
		const double = helperDouble(answer(500, { error: { code: 'internal_error', message: 'Error.' } }));

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && !error.message.includes(API_KEY),
		);
	});
});

describe('createFactuareaApiClient — helpers that throw instead of reporting the status', () => {
	it('translates a thrown NodeApiError-shaped failure by its httpCode', async () => {
		// `ignoreHttpStatusErrors` asks the helper not to throw, and the real one
		// obeys — but an older helper, or one wrapped by another node, throws a
		// `NodeApiError` whose status lives in `httpCode` as a string. Reading
		// only the happy shape would turn every rejection into a crash with no
		// message the user could act on.
		const thrown = Object.assign(new Error('Forbidden'), {
			httpCode: '403',
			response: {
				body: { error: { type: 'authorization_error', code: 'insufficient_scope', message: 'Sin scope.' } },
			},
		});
		const double = helperDouble({ reject: thrown });

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_INSUFFICIENT_SCOPE,
		);
	});

	it('translates a thrown failure whose envelope arrives in the cause', async () => {
		const thrown = Object.assign(new Error('Unprocessable Entity'), {
			statusCode: 422,
			cause: { error: { type: 'invalid_request_error', code: 'invalid_url_target', message: 'No permitido.', param: 'url' } },
		});
		const double = helperDouble({ reject: thrown });

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://127.0.0.1/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		);
	});

	it('reports a request that never reached Factuarea without inventing a status', async () => {
		// A refused connection carries no HTTP status. Reporting one would send
		// the user looking for an API problem that does not exist.
		const double = helperDouble({ reject: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

		await assert.rejects(
			client(double).getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID),
			(error: unknown) =>
				error instanceof Error &&
				error.message.includes('did not reach Factuarea') &&
				// No status, not even a made-up one. The bare word `HTTP` is not
				// the thing being ruled out — the message legitimately mentions
				// outbound HTTPS requests — so the check is for a status number.
				!/HTTP\s\d{3}/.test(error.message),
		);
	});

	it('does not claim the destination was not registered when the creation got no answer', async () => {
		// A read timeout fires AFTER the request was sent, so Factuarea may have
		// registered the destination and answered into a socket nobody was
		// listening on. The id is not stored, `checkExists` knows nothing about
		// it, and every retried activation leaves another one behind until the
		// account hits its limit — a failure whose message would then be about a
		// limit the user never knowingly approached.
		const double = helperDouble({ reject: Object.assign(new Error('socket hang up'), { code: 'ETIMEDOUT' }) });

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) =>
				error instanceof Error &&
				// The claim it must NOT make.
				!error.message.includes('did not reach Factuarea') &&
				error.message.includes('unknown whether the destination was registered') &&
				// And the screen on which the unknown can be resolved by hand.
				error.message.includes('Webhooks') &&
				!/HTTP\s\d{3}/.test(error.message),
		);
	});
});

describe('createFactuareaApiClient — answers the node cannot use', () => {
	it('refuses a creation answer with no secret rather than persisting an empty one', async () => {
		// The secret is returned exactly once. Accepting an answer without it
		// would leave a trigger that rejects every delivery and cannot explain
		// why, recoverable only by re-activating the workflow.
		const double = helperDouble(answer(201, { data: endpointResource() }));

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message.includes('does not recognise'),
		);
	});

	it('refuses a creation answer that is missing the data envelope', async () => {
		const double = helperDouble(answer(201, { id: ENDPOINT_ID, secret: 'whsec_x' }));

		await assert.rejects(
			client(double).createWebhookEndpoint(COMPANY_ID, { url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message.includes('does not recognise'),
		);
	});

	it('reports a catalogue answer that is not a list', async () => {
		const double = helperDouble(answer(200, { data: { name: 'invoice.paid' } }));

		await assert.rejects(
			client(double).listEventCatalog(),
			(error: unknown) => error instanceof Error && error.message === ERROR_EVENT_CATALOG_UNAVAILABLE,
		);
	});
});

describe('createFactuareaApiClient — account webhook endpoints', () => {
	const ACCOUNT_ID = '019251c0-0000-7000-8000-00000000ac01';
	const ACCOUNT_PATH = `https://api.factuarea.com/v1/accounts/${ACCOUNT_ID}/webhooks`;
	const ONE_ACCOUNT_ENDPOINT_PATH = `${ACCOUNT_PATH}/${ENDPOINT_ID}`;

	/** An account endpoint as the v1 API renders it (`AccountWebhook`). */
	function accountEndpointResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			id: ENDPOINT_ID,
			object: 'account_webhook',
			environment: 'live',
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['account.member_added'],
			account_relationship: 'all',
			status: 'active',
			disabled_reason: null,
			api_version: null,
			description: null,
			created_at: '2026-10-04T10:00:00Z',
			updated_at: '2026-10-04T10:00:00Z',
			...overrides,
		};
	}

	const BODY = {
		url: 'https://n8n.example.com/webhook/factuarea',
		enabled_events: ['account.member_added', 'invoice.paid'],
		account_relationship: 'all' as const,
		description: 'n8n trigger',
	};

	it('creates with POST on the account path, the body as given and a fresh idempotency key', async () => {
		const double = helperDouble(
			answer(201, { data: accountEndpointResource({ secret: 'whsec_account' }) }),
		);

		const created = await client(double).createAccountWebhookEndpoint(ACCOUNT_ID, BODY);
		const call = onlyCall(double);

		assert.equal(call.method, 'POST');
		assert.equal(call.url, ACCOUNT_PATH);
		assert.deepEqual(call.body, BODY);
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);
		assert.match(call.headers['Idempotency-Key'] ?? '', /^[0-9a-f-]{36}$/);
		assert.equal(created.secret, 'whsec_account');
		assert.equal(created.object, 'account_webhook');
	});

	it('escapes the account segment', async () => {
		const double = helperDouble(answer(201, { data: accountEndpointResource({ secret: 'whsec_a' }) }));

		await client(double).createAccountWebhookEndpoint('a/b c?', BODY);

		assert.equal(onlyCall(double).url, 'https://api.factuarea.com/v1/accounts/a%2Fb%20c%3F/webhooks');
	});

	it('reads and deletes on the one-endpoint account path', async () => {
		const reading = helperDouble(answer(200, { data: accountEndpointResource() }));
		const read = await client(reading).getAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID);

		assert.equal(onlyCall(reading).method, 'GET');
		assert.equal(onlyCall(reading).url, ONE_ACCOUNT_ENDPOINT_PATH);
		assert.equal(read.status, 'active');

		const deleting = helperDouble(answer(204, ''));
		await client(deleting).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID);

		assert.equal(onlyCall(deleting).method, 'DELETE');
		assert.equal(onlyCall(deleting).url, ONE_ACCOUNT_ENDPOINT_PATH);
		assert.ok(onlyCall(deleting).headers['Idempotency-Key'], 'the irreversible delete needs a key');
	});

	it('does not let the credential base absorb the account', async () => {
		const double = helperDouble(answer(200, { data: accountEndpointResource() }));

		await client(double, `https://api.factuarea.com/v1/`).getAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID);

		const url = onlyCall(double).url;

		assert.equal(url, ONE_ACCOUNT_ENDPOINT_PATH);
		assert.equal(url.split(`/accounts/`).length, 2, 'the account appears exactly once');
		assert.ok(!url.includes('/companies/'));
	});

	it('refuses an empty account before sending anything', async () => {
		const double = helperDouble();
		const apiClient = client(double);

		await assert.rejects(() => apiClient.createAccountWebhookEndpoint('', BODY), {
			message: ERROR_ACCOUNT_NOT_SELECTED,
		});
		await assert.rejects(() => apiClient.getAccountWebhookEndpoint('  ', ENDPOINT_ID), {
			message: ERROR_ACCOUNT_NOT_SELECTED,
		});
		await assert.rejects(() => apiClient.deleteAccountWebhookEndpoint('', ENDPOINT_ID), {
			message: ERROR_ACCOUNT_NOT_SELECTED,
		});
		assert.equal(double.calls.length, 0);
	});

	it('maps the 403 of a test key to its code', async () => {
		const double = helperDouble(
			errorBody(403, {
				type: 'authentication_error',
				code: 'live_credential_required',
				message: 'x',
			}),
		);

		await assert.rejects(() => client(double).createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_LIVE_CREDENTIAL_REQUIRED,
		});
	});

	it('maps the 403 of an issuer without capability to its code', async () => {
		const double = helperDouble(
			errorBody(403, { type: 'permission_error', code: 'forbidden_action', message: 'x' }),
		);

		await assert.rejects(() => client(double).createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_ACCOUNT_CAPABILITY_REQUIRED,
		});
	});

	it('keeps a plain 403 as the missing-scope message', async () => {
		const double = helperDouble(
			errorBody(403, { type: 'permission_error', code: 'insufficient_scope', message: 'x' }),
		);

		await assert.rejects(() => client(double).createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_INSUFFICIENT_SCOPE,
		});
	});

	it('maps the 403 module_not_available_in_sandbox of a REST account route to the live-key message', async () => {
		const sandbox = () =>
			errorBody(403, {
				type: 'permission_error',
				code: 'module_not_available_in_sandbox',
				message: 'x',
			});

		await assert.rejects(
			() => client(helperDouble(sandbox())).createAccountWebhookEndpoint(ACCOUNT_ID, BODY),
			{ message: ERROR_LIVE_CREDENTIAL_REQUIRED },
		);
		await assert.rejects(
			() => client(helperDouble(sandbox())).getAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID),
			{ message: ERROR_LIVE_CREDENTIAL_REQUIRED },
		);
		await assert.rejects(
			() => client(helperDouble(sandbox())).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID),
			{ message: ERROR_LIVE_CREDENTIAL_REQUIRED },
		);
	});

	it('leaves module_not_available_in_sandbox on a company route as the missing-scope message', async () => {
		const double = helperDouble(
			errorBody(403, { type: 'permission_error', code: 'module_not_available_in_sandbox', message: 'x' }),
		);

		await assert.rejects(() => client(double).createWebhookEndpoint(COMPANY_ID, BODY), {
			message: ERROR_INSUFFICIENT_SCOPE,
		});
	});

	it('refuses a fact_test_ key before any request when it creates or deletes an account endpoint', async () => {
		const double = helperDouble();
		const testClient = createFactuareaApiClient(double.request, {
			baseUrl: DEFAULT_API_BASE_URL,
			apiKey: 'fact_test_thisisnotarealkey',
		});

		await assert.rejects(() => testClient.createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_LIVE_CREDENTIAL_REQUIRED,
		});
		await assert.rejects(() => testClient.deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID), {
			message: ERROR_LIVE_CREDENTIAL_REQUIRED,
		});
		assert.equal(double.calls.length, 0);
	});

	it('does not block a fact_test_ key on the account read, nor on the company routes', async () => {
		const read = helperDouble(answer(200, { data: { id: ENDPOINT_ID, status: 'active' } }));
		const testOptions = { baseUrl: DEFAULT_API_BASE_URL, apiKey: 'fact_test_thisisnotarealkey' };

		await createFactuareaApiClient(read.request, testOptions).getAccountWebhookEndpoint(
			ACCOUNT_ID,
			ENDPOINT_ID,
		);
		assert.equal(read.calls.length, 1);

		const company = helperDouble(answer(204, undefined));

		await createFactuareaApiClient(company.request, testOptions).deleteWebhookEndpoint(
			COMPANY_ID,
			ENDPOINT_ID,
		);
		assert.equal(company.calls.length, 1);
	});

	describe('404 account_not_found versus a missing endpoint', () => {
		const accountNotFound = () =>
			errorBody(404, {
				type: 'not_found_error',
				code: 'account_not_found',
				message: 'x',
				param: 'account',
			});
		const endpointNotFound = () =>
			errorBody(404, {
				type: 'not_found_error',
				code: 'webhook_endpoint_not_found',
				message: 'x',
			});

		it('create and read throw the account message for account_not_found', async () => {
			await assert.rejects(
				() => client(helperDouble(accountNotFound())).createAccountWebhookEndpoint(ACCOUNT_ID, BODY),
				{ message: ERROR_ACCOUNT_NOT_FOUND },
			);
			await assert.rejects(
				() => client(helperDouble(accountNotFound())).getAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID),
				{ message: ERROR_ACCOUNT_NOT_FOUND },
			);
		});

		it('read keeps the gone message for a missing endpoint', async () => {
			await assert.rejects(
				() => client(helperDouble(endpointNotFound())).getAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID),
				{ message: ERROR_ENDPOINT_GONE },
			);
		});

		it('delete resolves only for webhook_endpoint_not_found and throws for account_not_found', async () => {
			await client(helperDouble(endpointNotFound())).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID);

			await assert.rejects(
				() => client(helperDouble(accountNotFound())).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID),
				{ message: ERROR_ACCOUNT_NOT_FOUND },
			);
		});
	});

	it('maps 402 addon_required and the 422 account limit', async () => {
		const addon = helperDouble(
			errorBody(402, {
				type: 'payment_required',
				code: 'addon_required',
				subcode: 'account_webhooks_addon_required',
				message: 'x',
			}),
		);

		await assert.rejects(() => client(addon).createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_ACCOUNT_WEBHOOKS_ADDON_REQUIRED,
		});

		const limit = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'account_webhook_endpoint_limit_reached',
				message: 'x',
			}),
		);

		await assert.rejects(() => client(limit).createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_ACCOUNT_ENDPOINT_LIMIT_REACHED,
		});
	});

	it('still translates the url and events 422s of the company calls on the account route', async () => {
		const events = helperDouble(
			errorBody(422, {
				type: 'invalid_request_error',
				code: 'invalid_param_value',
				param: 'enabled_events',
				message: 'x',
			}),
		);

		await assert.rejects(() => client(events).createAccountWebhookEndpoint(ACCOUNT_ID, BODY), {
			message: ERROR_NO_EVENTS_SELECTED,
		});
	});

	it('reads a 404 as a gone endpoint, and a webhook_endpoint_not_found delete 404 as success', async () => {
		const reading = helperDouble(answer(404, { error: { code: 'resource_not_found' } }));

		await assert.rejects(() => client(reading).getAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID), {
			message: ERROR_ENDPOINT_GONE,
		});

		const deleting = helperDouble(answer(404, { error: { code: 'webhook_endpoint_not_found' } }));

		await client(deleting).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID);

		// An uncatalogued 404 is not proof that the endpoint is gone.
		const unknown = helperDouble(answer(404, { error: { code: 'resource_not_found' } }));

		await assert.rejects(() => client(unknown).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID));
	});

	it('reports a failed delete instead of swallowing it', async () => {
		const double = helperDouble(answer(500, { error: { code: 'internal' } }));

		await assert.rejects(
			() => client(double).deleteAccountWebhookEndpoint(ACCOUNT_ID, ENDPOINT_ID),
			/HTTP 500/,
		);
	});

	it('refuses a creation answer without id or secret', async () => {
		const double = helperDouble(answer(201, { data: accountEndpointResource({ secret: null }) }));

		await assert.rejects(
			() => client(double).createAccountWebhookEndpoint(ACCOUNT_ID, BODY),
			/shape this trigger does not recognise/,
		);
	});

	it('explains an endpoint that exists but is disabled', () => {
		const lost = accountEndpointResource({
			status: 'disabled',
			disabled_reason: 'creator_lost_capability',
		}) as unknown as Parameters<typeof describeInactiveAccountEndpoint>[0];
		const other = accountEndpointResource({ status: 'disabled' }) as unknown as Parameters<
			typeof describeInactiveAccountEndpoint
		>[0];

		assert.equal(describeInactiveAccountEndpoint(lost), ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY);
		assert.notEqual(describeInactiveAccountEndpoint(other), ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY);
	});

	it('leaves the company operations and the root catalogue where they were', async () => {
		const create = helperDouble(answer(201, { data: endpointResource({ secret: 'whsec_a' }) }));
		await client(create).createWebhookEndpoint(COMPANY_ID, {
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid'],
		});
		assert.equal(
			onlyCall(create).url,
			`https://api.factuarea.com/v1/companies/${COMPANY_ID}/webhook-endpoints`,
		);

		const read = helperDouble(answer(200, { data: endpointResource() }));
		await client(read).getWebhookEndpoint(COMPANY_ID, ENDPOINT_ID);
		assert.equal(
			onlyCall(read).url,
			`https://api.factuarea.com/v1/companies/${COMPANY_ID}/webhook-endpoints/${ENDPOINT_ID}`,
		);

		const catalogue = helperDouble(answer(200, { data: [] }));
		await client(catalogue).listEventCatalog();
		assert.equal(onlyCall(catalogue).url, 'https://api.factuarea.com/v1/event-catalog');

		const forbidden = helperDouble(errorBody(403, { type: 'x', code: 'live_credential_required', message: 'x' }));
		await assert.rejects(() => client(forbidden).createWebhookEndpoint(COMPANY_ID, BODY), {
			message: ERROR_INSUFFICIENT_SCOPE,
		});
	});
});
