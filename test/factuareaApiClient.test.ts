import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { DEFAULT_API_BASE_URL } from '../src/contract';
import { createFactuareaApiClient } from '../src/client/factuareaApiClient';
import {
	ERROR_ENDPOINT_GONE,
	ERROR_ENDPOINT_LIMIT_REACHED,
	ERROR_ENDPOINT_URL_NOT_ACCEPTED,
	ERROR_EVENT_CATALOG_UNAVAILABLE,
	ERROR_INSUFFICIENT_SCOPE,
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

		const created = await client(double).createWebhookEndpoint({
			url: 'https://n8n.example.com/webhook/factuarea',
			enabled_events: ['invoice.paid', 'invoice.created'],
			description: 'n8n trigger',
		});

		const call = onlyCall(double);
		assert.equal(call.method, 'POST');
		assert.equal(call.url, 'https://api.factuarea.com/v1/webhook_endpoints');
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

		const found = await client(double).getWebhookEndpoint(ENDPOINT_ID);

		const call = onlyCall(double);
		assert.equal(call.method, 'GET');
		assert.equal(call.url, `https://api.factuarea.com/v1/webhook_endpoints/${ENDPOINT_ID}`);
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);
		assert.equal(call.body, undefined, 'a read must not carry a body');
		assert.equal(found?.id, ENDPOINT_ID);
	});

	it('removes a destination with DELETE and accepts the empty 204 answer', async () => {
		const double = helperDouble(answer(204, undefined));

		await client(double).deleteWebhookEndpoint(ENDPOINT_ID);

		const call = onlyCall(double);
		assert.equal(call.method, 'DELETE');
		assert.equal(call.url, `https://api.factuarea.com/v1/webhook_endpoints/${ENDPOINT_ID}`);
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

/** RFC 4122 version 4, which is what `crypto.randomUUID()` produces. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createFactuareaApiClient — idempotency key on the writes', () => {
	it('sends a fresh key on the write that registers a destination', async () => {
		const double = helperDouble(
			answer(201, { data: endpointResource({ secret: 'whsec_0123456789abcdef0123456789abcdef' }) }),
		);

		await client(double).createWebhookEndpoint({
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

		await client(double).deleteWebhookEndpoint(ENDPOINT_ID);

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

		await api.createWebhookEndpoint(input);
		await api.createWebhookEndpoint(input);

		assert.equal(double.calls.length, 2);
		const [first, second] = double.calls;
		assert.ok(first !== undefined && second !== undefined);
		assert.notEqual(first.headers['Idempotency-Key'], second.headers['Idempotency-Key']);
	});

	it('does not put a key on the reads, which have nothing to replay', async () => {
		const readDouble = helperDouble(answer(200, { data: endpointResource() }));
		await client(readDouble).getWebhookEndpoint(ENDPOINT_ID);
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
			client(double).createWebhookEndpoint({ url: 'https://10.0.0.4/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'http://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: [] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.imagined'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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

		assert.equal(await client(double).getWebhookEndpoint(ENDPOINT_ID), null);
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

		await client(double).deleteWebhookEndpoint(ENDPOINT_ID);
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://127.0.0.1/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message === ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		);
	});

	it('reports a request that never reached Factuarea without inventing a status', async () => {
		// A refused connection carries no HTTP status. Reporting one would send
		// the user looking for an API problem that does not exist.
		const double = helperDouble({ reject: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

		await assert.rejects(
			client(double).getWebhookEndpoint(ENDPOINT_ID),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
			(error: unknown) => error instanceof Error && error.message.includes('does not recognise'),
		);
	});

	it('refuses a creation answer that is missing the data envelope', async () => {
		const double = helperDouble(answer(201, { id: ENDPOINT_ID, secret: 'whsec_x' }));

		await assert.rejects(
			client(double).createWebhookEndpoint({ url: 'https://n8n.example.com/hook', enabled_events: ['invoice.paid'] }),
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
