import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { IHookFunctions } from 'n8n-workflow';

import {
	checkWebhookExists,
	createWebhookEndpoint,
	deleteWebhookEndpoint,
	factuareaWebhookMethods,
} from '../src/nodes/FactuareaTrigger/webhookLifecycle';
import {
	PARAMETER_COMPANY_ID,
	STATIC_DATA_ENDPOINT_ID,
	STATIC_DATA_SECRET,
} from '../src/client/types';
import type { FactuareaHttpRequestOptions } from '../src/client/types';
import {
	ERROR_COMPANY_NOT_SELECTED,
	ERROR_ENDPOINT_NOT_ACTIVE,
	ERROR_ENDPOINT_URL_MISMATCH,
	ERROR_ENDPOINT_URL_NOT_ACCEPTED,
	ERROR_NO_EVENTS_SELECTED,
} from '../src/errors';

/**
 * The lifecycle methods are exercised through a double of `IHookFunctions`.
 *
 * The double answers only the six members these three functions touch —
 * `getCredentials`, `getNodeWebhookUrl`, `getNodeParameter`,
 * `getWorkflowStaticData`, `getWorkflow` and `helpers.httpRequest` — and is cast
 * to the full interface. Implementing the other forty members to satisfy the
 * compiler would be forty lines of nothing, and the cast is what keeps this
 * package's dependency list empty: there is no mocking library here.
 *
 * The static-data object is created once per double and handed back by every
 * call, which is what n8n does: it is the node's own persisted state, and these
 * tests are largely about what ends up in it.
 */

const ENDPOINT_ID = '019251c0-0000-7000-8000-00000000abcd';
const SECRET = 'whsec_notarealsecret';
const WEBHOOK_URL = 'https://n8n.example.com/webhook/019251c0';
const EVENTS = ['invoice.created', 'invoice.paid'];

/** The company the node's own field names, and the one the routes must carry. */
const COMPANY_ID = '019251c0-0000-7000-8000-00000000fa01';

/** A different company, typed into the credential rather than into the node. */
const CREDENTIAL_COMPANY_ID = '019251c0-0000-7000-8000-00000000fb02';

/** The base URL of the credential the double hands back. */
const BASE_URL = 'https://api.factuarea.test/v1';

/** The company-scoped root every webhook-endpoint request has to be built on. */
function endpointsRoot(companyId: string): string {
	return `${BASE_URL}/companies/${companyId}/webhook-endpoints`;
}

/** One programmed answer: what the helper resolves with, or what it throws. */
type Programmed = { readonly resolve: unknown } | { readonly reject: unknown };

interface Double {
	readonly hook: IHookFunctions;
	readonly state: Record<string, unknown>;
	readonly calls: FactuareaHttpRequestOptions[];
}

interface DoubleOptions {
	readonly state?: Record<string, unknown>;
	/** `undefined` models n8n having no public address to hand back. */
	readonly webhookUrl?: string | undefined;
	readonly events?: string[];
	/** The node's own Company ID field; `''` models it left empty. */
	readonly companyId?: string;
	/** The Default Company ID of the credential; absent models it left empty. */
	readonly credentialCompanyId?: string;
	readonly workflow?: { id?: string; name?: string };
	readonly answers?: Programmed[];
}

function hookDouble(options: DoubleOptions = {}): Double {
	const state: Record<string, unknown> = { ...options.state };
	const calls: FactuareaHttpRequestOptions[] = [];
	const queue = [...(options.answers ?? [])];

	const hook = {
		async getCredentials(): Promise<unknown> {
			return {
				apiKey: 'fk_live_notarealkey',
				baseUrl: BASE_URL,
				// Absent unless the test asks for it, which is the ordinary case:
				// a credential written before this version has no company in it.
				...('credentialCompanyId' in options
					? { companyId: options.credentialCompanyId }
					: {}),
			};
		},
		getNodeWebhookUrl(): string | undefined {
			return 'webhookUrl' in options ? options.webhookUrl : WEBHOOK_URL;
		},
		// Dispatched by NAME, not answered with one value for every parameter: the
		// lifecycle now reads two of them, and a double that returned the event
		// list for the company would hide exactly the wiring these tests pin.
		getNodeParameter(name: string): unknown {
			if (name === PARAMETER_COMPANY_ID) {
				return options.companyId ?? COMPANY_ID;
			}

			return options.events ?? EVENTS;
		},
		getWorkflowStaticData(): Record<string, unknown> {
			return state;
		},
		getWorkflow(): { id?: string; name?: string; active: boolean } {
			return { ...options.workflow, active: true };
		},
		helpers: {
			async httpRequest(request: FactuareaHttpRequestOptions): Promise<unknown> {
				calls.push(request);
				const next = queue.shift();

				if (next === undefined) {
					throw new Error('The double was called more times than it was programmed for.');
				}

				if ('reject' in next) {
					throw next.reject;
				}

				return next.resolve;
			},
		},
	} as unknown as IHookFunctions;

	return { hook, state, calls };
}

/** A full HTTP answer, the shape the helper returns under `returnFullResponse`. */
function answer(statusCode: number, body: unknown): Programmed {
	return { resolve: { statusCode, body, headers: {} } };
}

/**
 * A webhook destination as the read route returns it, trimmed to what is read.
 *
 * `status` and `url` belong to that trim because the lifecycle reads both: a
 * destination that exists, is suspended and points somewhere else is not the
 * same answer as one that is still delivering here.
 */
function endpointBody(overrides: Record<string, unknown> = {}): Programmed {
	return answer(200, {
		data: {
			id: ENDPOINT_ID,
			object: 'webhook_endpoint',
			url: WEBHOOK_URL,
			status: 'active',
			...overrides,
		},
	});
}

/**
 * The only call the double received.
 *
 * `noUncheckedIndexedAccess` makes `calls[0]` possibly undefined, and asserting
 * the count here means every test that reads a call has also pinned how many
 * requests the operation made.
 */
function onlyCall(double: Double): FactuareaHttpRequestOptions {
	assert.equal(double.calls.length, 1, 'the operation should make exactly one request');

	const call = double.calls[0];

	assert.ok(call !== undefined);

	return call;
}

describe('checkWebhookExists', () => {
	it('answers "no" without asking Factuarea when no destination is stored', async () => {
		const double = hookDouble();

		assert.equal(await checkWebhookExists.call(double.hook), false);

		// The point is not only the answer: a trigger that has never registered
		// anything has nothing to ask about, and a request here would spend a
		// round trip and a rate-limit slot on every activation.
		assert.deepEqual(double.calls, []);
	});

	it('answers "no" when the stored destination is gone from Factuarea', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [answer(404, { error: { type: 'invalid_request', code: 'not_found' } })],
		});

		assert.equal(await checkWebhookExists.call(double.hook), false);

		const call = onlyCall(double);

		assert.equal(call.method, 'GET');
		assert.equal(call.url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});

	it('answers "yes" when the stored destination still exists', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [endpointBody()],
		});

		assert.equal(await checkWebhookExists.call(double.hook), true);
	});

	it('refuses to call a suspended destination "in place"', async () => {
		// Factuarea suspends a destination after 100 permanent failures in 24
		// hours (`OnWebhookDeliveryFailedDetectDegraded`), which is what a workflow
		// that was offline for a day produces, and
		// `DeliverWebhookCommandHandler` then drops every delivery. The
		// destination still reads back perfectly: "it exists" is true and useless.
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [endpointBody({ status: 'degraded', degraded_since: '2026-09-01T09:00:00+00:00' })],
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ENDPOINT_NOT_ACTIVE,
		});
	});

	it('refuses a destination that points at an address this workflow no longer answers on', async () => {
		// The public URL of an n8n instance changes — a new domain, a new tunnel.
		// The destination keeps the address it was registered with, so Factuarea
		// keeps delivering to somewhere nothing is listening.
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [endpointBody({ url: 'https://old-tunnel.example.com/webhook/019251c0' })],
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ENDPOINT_URL_MISMATCH,
		});
	});

	it('throws instead of answering "no", so the dead destination is not orphaned', async () => {
		// The distinction this test exists for: n8n answers `false` by calling
		// `create` and NOT `delete`. Reporting a suspended destination as "not
		// registered" would leave it in Factuarea for ever — unreachable by this
		// node, counting against the account's destination limit, and a few
		// activations later the limit is the error the user would see instead.
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [endpointBody({ status: 'disabled' })],
		});

		const outcome = await checkWebhookExists.call(double.hook).then(
			(value) => ({ returned: value }),
			(error: unknown) => ({ threw: error }),
		);

		assert.ok('threw' in outcome, 'a dead destination must not be reported as "not registered"');
	});

	it('does not refuse a read whose status it cannot see', async () => {
		// `status` is part of the measured contract, so its absence means an
		// answer this node has not measured. Refusing to activate over a field
		// that cannot be read would turn one shape change at the API into every
		// workflow failing to start, which is worse than the failure the guard
		// above prevents.
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [answer(200, { data: { id: ENDPOINT_ID, url: WEBHOOK_URL } })],
		});

		assert.equal(await checkWebhookExists.call(double.hook), true);
	});
});

describe('createWebhookEndpoint', () => {
	it('registers the destination and stores its identifier and its secret', async () => {
		const double = hookDouble({
			workflow: { id: '42', name: 'Facturas a Slack' },
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		assert.equal(await createWebhookEndpoint.call(double.hook), true);

		// The secret is the whole reason this call cannot be skipped: it is
		// returned once and never again, so a create that stored only the id
		// would leave a trigger that rejects every delivery it receives.
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
		assert.equal(double.state[STATIC_DATA_SECRET], SECRET);

		const call = onlyCall(double);

		assert.equal(call.method, 'POST');
		// The company is a segment of the path and NOT a field of the body: the
		// request is addressed to a company, it does not describe one.
		assert.equal(call.url, endpointsRoot(COMPANY_ID));
		assert.deepEqual(call.body, {
			url: WEBHOOK_URL,
			enabled_events: EVENTS,
			description: 'n8n workflow 42 — Facturas a Slack',
		});
	});

	it('omits the description when n8n identifies the workflow with neither an id nor a name', async () => {
		const double = hookDouble({
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.deepEqual(onlyCall(double).body, { url: WEBHOOK_URL, enabled_events: EVENTS });
	});

	it('refuses a receiving address that is not HTTPS before making any request', async () => {
		const double = hookDouble({ webhookUrl: 'http://n8n.example.com/webhook/019251c0' });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		});

		// Failing BEFORE the request is the point: Factuarea would refuse this
		// address anyway, and the frozen message already names the cause and the
		// remedy, so the round trip buys nothing.
		assert.deepEqual(double.calls, []);
		assert.deepEqual(double.state, {});
	});

	it('refuses an empty event selection before the request goes out', async () => {
		// `required: true` on the property does not stop an activation. Without
		// this guard the empty list reaches the API, whose rule is
		// `required|array|min:1`, and the 422 that comes back reads as a generic
		// failure telling the user to check an API key that is perfectly valid.
		const double = hookDouble({ events: [] });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_NO_EVENTS_SELECTED,
		});

		assert.deepEqual(double.calls, [], 'nothing to ask Factuarea: the answer is already known');
		assert.deepEqual(double.state, {});
	});

	it('refuses to register anything when n8n has no receiving address to give', async () => {
		const double = hookDouble({ webhookUrl: undefined });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		});

		assert.deepEqual(double.calls, []);
	});

	it('propagates the frozen message when Factuarea refuses the address', async () => {
		const double = hookDouble({
			answers: [
				answer(422, {
					error: {
						type: 'invalid_request',
						code: 'invalid_url_target',
						message: 'La URL apunta a una red privada.',
						param: 'url',
					},
				}),
			],
		});

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_ENDPOINT_URL_NOT_ACCEPTED,
		});

		// Nothing is stored on failure: a stored id with no secret would make
		// `checkExists` answer "yes" for a destination this node cannot verify.
		assert.deepEqual(double.state, {});
	});
});

describe('deleteWebhookEndpoint', () => {
	it('removes the destination and forgets its identifier and its secret', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [answer(204, undefined)],
		});

		assert.equal(await deleteWebhookEndpoint.call(double.hook), true);

		// Both keys gone is what makes the next activation register a fresh
		// destination with a fresh secret, which is the documented remedy for a
		// secret rotated outside n8n.
		assert.deepEqual(double.state, {});

		const call = onlyCall(double);

		assert.equal(call.method, 'DELETE');
		assert.equal(call.url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});

	it('does nothing and asks nothing when there is no destination to remove', async () => {
		const double = hookDouble();

		assert.equal(await deleteWebhookEndpoint.call(double.hook), true);
		assert.deepEqual(double.calls, []);
	});

	it('keeps the identifier when the deletion fails, so a retry can still finish it', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [
				answer(403, { error: { type: 'invalid_request', code: 'insufficient_scope' } }),
			],
		});

		await assert.rejects(deleteWebhookEndpoint.call(double.hook));

		// Forgetting the id here would leave a live destination in Factuarea
		// that keeps delivering and that this node can no longer name.
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
	});
});

describe('the company the lifecycle works on', () => {
	it('registers and removes on the company the node names, in both directions', async () => {
		const creating = hookDouble({
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		await createWebhookEndpoint.call(creating.hook);

		assert.equal(onlyCall(creating).url, endpointsRoot(COMPANY_ID));

		const removing = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [answer(204, undefined)],
		});

		await deleteWebhookEndpoint.call(removing.hook);

		// Creation and removal on the same company: a create on one company and a
		// delete on another would leave a live destination behind on every
		// deactivation.
		assert.equal(onlyCall(removing).url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});

	it('falls back to the company typed into the credential, and only to that', async () => {
		const double = hookDouble({
			companyId: '',
			credentialCompanyId: CREDENTIAL_COMPANY_ID,
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, endpointsRoot(CREDENTIAL_COMPANY_ID));
	});

	it('prefers the node field over the credential when both are filled', async () => {
		const double = hookDouble({
			credentialCompanyId: CREDENTIAL_COMPANY_ID,
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		await createWebhookEndpoint.call(double.hook);

		// The field next to the activation switch wins: it is the one the user
		// was looking at when they activated.
		assert.equal(onlyCall(double).url, endpointsRoot(COMPANY_ID));
	});

	it('trims a pasted company instead of composing a path with a space in it', async () => {
		const double = hookDouble({
			companyId: `  ${COMPANY_ID}  `,
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, endpointsRoot(COMPANY_ID));
	});

	it('refuses to register anything when no company is named anywhere', async () => {
		const double = hookDouble({ companyId: '' });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_COMPANY_NOT_SELECTED,
		});

		// The prohibited behaviour is not only "build a wrong path": it is
		// resolving the company on the user's behalf. Nothing is asked of
		// Factuarea, so nothing can answer with a company nobody chose.
		assert.deepEqual(double.calls, []);
		assert.deepEqual(double.state, {});
	});

	it('refuses to read the stored destination when no company is named', async () => {
		const double = hookDouble({
			companyId: '',
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_COMPANY_NOT_SELECTED,
		});

		assert.deepEqual(double.calls, []);
	});

	it('refuses to remove the stored destination when no company is named, and keeps it', async () => {
		const double = hookDouble({
			companyId: '',
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
		});

		await assert.rejects(deleteWebhookEndpoint.call(double.hook), {
			message: ERROR_COMPANY_NOT_SELECTED,
		});

		// Forgetting the identifier here would orphan a live destination that
		// this node could no longer name. Keeping it means filling the field in
		// and deactivating again finishes the job.
		assert.deepEqual(double.calls, []);
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
	});

	it('builds no webhook route without a company segment', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [endpointBody(), answer(204, undefined)],
		});

		await checkWebhookExists.call(double.hook);
		await deleteWebhookEndpoint.call(double.hook);

		assert.equal(double.calls.length, 2);

		for (const call of double.calls) {
			assert.match(call.url, /\/companies\/[^/]+\/webhook-endpoints/, call.url);
			assert.doesNotMatch(call.url, /webhook_endpoints/, call.url);
		}
	});
});

describe('factuareaWebhookMethods', () => {
	it('maps n8n lifecycle names to the three implementations', () => {
		// A `create` wired to the deletion would be a node that unregisters
		// itself on activation, and nothing about the call site would look wrong.
		assert.equal(factuareaWebhookMethods.checkExists, checkWebhookExists);
		assert.equal(factuareaWebhookMethods.create, createWebhookEndpoint);
		assert.equal(factuareaWebhookMethods.delete, deleteWebhookEndpoint);
	});
});
