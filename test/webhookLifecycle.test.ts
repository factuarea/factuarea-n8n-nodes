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
	PARAMETER_ACCOUNT_ID,
	PARAMETER_ACCOUNT_RELATIONSHIP,
	PARAMETER_COMPANY_ID,
	PARAMETER_LISTEN_ON,
	STATIC_DATA_ACCOUNT_ID,
	STATIC_DATA_COMPANY_ID,
	STATIC_DATA_ENDPOINT_ID,
	STATIC_DATA_LISTEN_ON,
	STATIC_DATA_SECRET,
} from '../src/client/types';
import type { FactuareaHttpRequestOptions } from '../src/client/types';
import {
	ERROR_ACCOUNT_CAPABILITY_REQUIRED,
	ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY,
	ERROR_ACCOUNT_ENDPOINT_LIMIT_REACHED,
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_ACCOUNT_NOT_SELECTED,
	ERROR_ACCOUNT_WEBHOOKS_ADDON_REQUIRED,
	ERROR_COMPANY_NOT_SELECTED,
	ERROR_LIVE_CREDENTIAL_REQUIRED,
	ERROR_ENDPOINT_NOT_ACTIVE,
	ERROR_INSUFFICIENT_SCOPE,
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

/** The account the node's own field names in account mode. */
const ACCOUNT_ID = '019251c0-0000-7000-8000-00000000ac01';

/** A different account, typed into the credential or left in the static data. */
const CREDENTIAL_ACCOUNT_ID = '019251c0-0000-7000-8000-00000000ac02';
const OTHER_ACCOUNT_ID = '019251c0-0000-7000-8000-00000000ac03';

/** The base URL of the credential the double hands back. */
const BASE_URL = 'https://api.factuarea.test/v1';

/** The company-scoped root every webhook-endpoint request has to be built on. */
function endpointsRoot(companyId: string): string {
	return `${BASE_URL}/companies/${companyId}/webhook-endpoints`;
}

/** The account-scoped root every account webhook request has to be built on. */
function accountWebhooksRoot(accountId: string): string {
	return `${BASE_URL}/accounts/${accountId}/webhooks`;
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
	/** The `listenOn` parameter; absent models a workflow saved before account mode. */
	readonly listenOn?: string;
	/** The node's own Account ID field; `''` models it left empty. */
	readonly accountId?: string;
	/** The Default Account ID of the credential; absent models it left empty. */
	readonly credentialAccountId?: string;
	/** The relationship filter; absent models it never touched (the default, `all`). */
	readonly relationship?: string;
	/** The API key of the credential; defaults to a live-looking one. */
	readonly apiKey?: string;
	/**
	 * Simulates n8n discarding the parameters hidden by `displayOptions`
	 * (`node-helpers.js` removes them on save): the Company ID is ABSENT while the
	 * node is in account mode, and the Account ID while it is in company mode.
	 */
	readonly dropHiddenParameters?: boolean;
}

function hookDouble(options: DoubleOptions = {}): Double {
	const state: Record<string, unknown> = { ...options.state };
	const calls: FactuareaHttpRequestOptions[] = [];
	const queue = [...(options.answers ?? [])];

	const hook = {
		async getCredentials(): Promise<unknown> {
			return {
				apiKey: options.apiKey ?? 'fk_live_notarealkey',
				baseUrl: BASE_URL,
				// Absent unless the test asks for it, which is the ordinary case:
				// a credential written before this version has no company in it.
				...('credentialCompanyId' in options
					? { companyId: options.credentialCompanyId }
					: {}),
				...('credentialAccountId' in options
					? { accountId: options.credentialAccountId }
					: {}),
			};
		},
		getNodeWebhookUrl(): string | undefined {
			return 'webhookUrl' in options ? options.webhookUrl : WEBHOOK_URL;
		},
		// Dispatched by NAME, not answered with one value for every parameter: the
		// lifecycle now reads two of them, and a double that returned the event
		// list for the company would hide exactly the wiring these tests pin.
		getNodeParameter(name: string, fallback?: unknown): unknown {
			if (name === PARAMETER_COMPANY_ID) {
				if (options.dropHiddenParameters === true && options.listenOn === 'account') {
					return fallback;
				}

				return options.companyId ?? COMPANY_ID;
			}

			// The three account-mode parameters answer only when the test sets them,
			// and otherwise behave like a parameter n8n has no value for: the
			// fallback. A workflow saved before account mode reads `listenOn` as its
			// default, which is why the company cases above stay untouched.
			if (name === PARAMETER_LISTEN_ON) {
				return options.listenOn ?? fallback;
			}

			if (name === PARAMETER_ACCOUNT_ID) {
				if (options.dropHiddenParameters === true && options.listenOn !== 'account') {
					return fallback;
				}

				return options.accountId ?? ACCOUNT_ID;
			}

			if (name === PARAMETER_ACCOUNT_RELATIONSHIP) {
				return options.relationship ?? fallback;
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

/**
 * ACCOUNT MODE (change `account-tenancy-sibling-repos`, design D9).
 *
 * The same three methods, addressed to `/v1/accounts/{account}/webhooks`. The
 * company cases above are untouched: this block only adds.
 */

/** The creation answer of an account endpoint: the keys the client requires. */
function accountCreated(overrides: Record<string, unknown> = {}): Programmed {
	return answer(201, {
		data: {
			id: ENDPOINT_ID,
			object: 'account_webhook',
			secret: SECRET,
			status: 'active',
			disabled_reason: null,
			...overrides,
		},
	});
}

/** An account endpoint as the read route returns it. */
function accountEndpointBody(overrides: Record<string, unknown> = {}): Programmed {
	return answer(200, {
		data: {
			id: ENDPOINT_ID,
			object: 'account_webhook',
			url: WEBHOOK_URL,
			status: 'active',
			disabled_reason: null,
			...overrides,
		},
	});
}

/** The state an account creation leaves behind. */
function accountState(accountId: string = ACCOUNT_ID): Record<string, unknown> {
	return {
		[STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID,
		[STATIC_DATA_SECRET]: SECRET,
		[STATIC_DATA_LISTEN_ON]: 'account',
		[STATIC_DATA_ACCOUNT_ID]: accountId,
	};
}

/** The error body the public API sends with a rejection. */
function rejection(statusCode: number, code: string): Programmed {
	return answer(statusCode, { error: { type: 'invalid_request', code } });
}

describe('account mode: createWebhookEndpoint', () => {
	it('registers an account endpoint with the n8n address, the events and the filter, and stores the secret, the mode and the account', async () => {
		const double = hookDouble({
			listenOn: 'account',
			relationship: 'managed',
			workflow: { id: '42', name: 'Tax id intake' },
			answers: [accountCreated()],
		});

		assert.equal(await createWebhookEndpoint.call(double.hook), true);

		const call = onlyCall(double);

		assert.equal(call.method, 'POST');
		assert.equal(call.url, accountWebhooksRoot(ACCOUNT_ID));
		assert.deepEqual(call.body, {
			url: WEBHOOK_URL,
			enabled_events: EVENTS,
			account_relationship: 'managed',
			description: 'n8n workflow 42 — Tax id intake',
		});

		// The secret is returned once. The mode and the account are stored next to
		// it so the check and the deletion address the endpoint that was created.
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
		assert.equal(double.state[STATIC_DATA_SECRET], SECRET);
		assert.equal(double.state[STATIC_DATA_LISTEN_ON], 'account');
		assert.equal(double.state[STATIC_DATA_ACCOUNT_ID], ACCOUNT_ID);
	});

	it('sends the relationship `all` when the filter was never touched', async () => {
		const double = hookDouble({ listenOn: 'account', answers: [accountCreated()] });

		await createWebhookEndpoint.call(double.hook);

		assert.deepEqual(onlyCall(double).body, {
			url: WEBHOOK_URL,
			enabled_events: EVENTS,
			account_relationship: 'all',
		});
	});

	it('uses the account of the credential when the node field is empty', async () => {
		const double = hookDouble({
			listenOn: 'account',
			accountId: '',
			credentialAccountId: CREDENTIAL_ACCOUNT_ID,
			answers: [accountCreated()],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, accountWebhooksRoot(CREDENTIAL_ACCOUNT_ID));
		assert.equal(double.state[STATIC_DATA_ACCOUNT_ID], CREDENTIAL_ACCOUNT_ID);
	});

	it('prefers the node field over the credential when both are filled', async () => {
		const double = hookDouble({
			listenOn: 'account',
			credentialAccountId: CREDENTIAL_ACCOUNT_ID,
			answers: [accountCreated()],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, accountWebhooksRoot(ACCOUNT_ID));
	});

	it('trims a pasted account instead of composing a path with a space in it', async () => {
		const double = hookDouble({
			listenOn: 'account',
			accountId: `  ${ACCOUNT_ID}  `,
			answers: [accountCreated()],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, accountWebhooksRoot(ACCOUNT_ID));
	});

	it('never writes a company route in account mode', async () => {
		const double = hookDouble({ listenOn: 'account', answers: [accountCreated()] });

		await createWebhookEndpoint.call(double.hook);

		assert.doesNotMatch(onlyCall(double).url, /\/companies\//);
	});

	it('keeps the company behaviour for a workflow with no listenOn, and stores no mode', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_LISTEN_ON]: 'account', [STATIC_DATA_ACCOUNT_ID]: OTHER_ACCOUNT_ID },
			answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, endpointsRoot(COMPANY_ID));
		// A company endpoint stores neither key, and a stale account pair of an
		// earlier endpoint must not survive to redirect the next check.
		assert.equal(STATIC_DATA_LISTEN_ON in double.state, false);
		assert.equal(STATIC_DATA_ACCOUNT_ID in double.state, false);
	});

	it('refuses an empty event selection before any request in account mode too', async () => {
		const double = hookDouble({ listenOn: 'account', events: [] });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_NO_EVENTS_SELECTED,
		});

		assert.deepEqual(double.calls, []);
		assert.deepEqual(double.state, {});
	});
});

describe('account mode: checkWebhookExists', () => {
	it('answers "no" without asking when no endpoint is stored', async () => {
		const double = hookDouble({ listenOn: 'account' });

		assert.equal(await checkWebhookExists.call(double.hook), false);
		assert.deepEqual(double.calls, []);
	});

	it('asks only for the endpoint this node stored, on the stored account', async () => {
		const double = hookDouble({
			listenOn: 'account',
			// The node now names ANOTHER account: the check must ignore it.
			accountId: OTHER_ACCOUNT_ID,
			state: accountState(ACCOUNT_ID),
			answers: [accountEndpointBody()],
		});

		assert.equal(await checkWebhookExists.call(double.hook), true);

		const call = onlyCall(double);

		assert.equal(call.method, 'GET');
		assert.equal(call.url, `${accountWebhooksRoot(ACCOUNT_ID)}/${ENDPOINT_ID}`);
	});

	it('answers "no" when the stored account endpoint is gone (the read rejects as gone)', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [rejection(404, 'not_found')],
		});

		assert.equal(await checkWebhookExists.call(double.hook), false);
		assert.equal(double.calls.length, 1);
	});

	it('does not treat any other read failure as "gone"', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [rejection(403, 'forbidden_action')],
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ACCOUNT_CAPABILITY_REQUIRED,
		});
	});

	it('throws the creator-lost-capability message for a disabled endpoint', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [
				accountEndpointBody({ status: 'disabled', disabled_reason: 'creator_lost_capability' }),
			],
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY,
		});
	});

	it('throws the generic inactive message for a disabled endpoint with another reason', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [accountEndpointBody({ status: 'disabled', disabled_reason: null })],
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ENDPOINT_NOT_ACTIVE,
		});
	});

	it('refuses an endpoint that points at an address this workflow no longer answers on', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [accountEndpointBody({ url: 'https://old-tunnel.example.com/webhook/019251c0' })],
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ENDPOINT_URL_MISMATCH,
		});
	});

	it('checks by the STORED mode even when the node now says company', async () => {
		const double = hookDouble({
			listenOn: 'company',
			state: accountState(),
			answers: [accountEndpointBody()],
		});

		assert.equal(await checkWebhookExists.call(double.hook), true);
		assert.equal(onlyCall(double).url, `${accountWebhooksRoot(ACCOUNT_ID)}/${ENDPOINT_ID}`);
	});
});

describe('account mode: deleteWebhookEndpoint', () => {
	it('deletes on the account that was stored, even when the node names another', async () => {
		const double = hookDouble({
			listenOn: 'account',
			accountId: OTHER_ACCOUNT_ID,
			state: accountState(ACCOUNT_ID),
			answers: [answer(204, undefined)],
		});

		assert.equal(await deleteWebhookEndpoint.call(double.hook), true);

		const call = onlyCall(double);

		assert.equal(call.method, 'DELETE');
		assert.equal(call.url, `${accountWebhooksRoot(ACCOUNT_ID)}/${ENDPOINT_ID}`);
		// All four keys go, so the next activation starts from nothing.
		assert.deepEqual(double.state, {});
	});

	it('counts a 404 as deleted and forgets the endpoint', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [rejection(404, 'webhook_endpoint_not_found')],
		});

		assert.equal(await deleteWebhookEndpoint.call(double.hook), true);
		assert.deepEqual(double.state, {});
	});

	it('does NOT count a 404 account_not_found as deleted and keeps the static data', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [rejection(404, 'account_not_found')],
		});

		await assert.rejects(deleteWebhookEndpoint.call(double.hook), {
			message: ERROR_ACCOUNT_NOT_FOUND,
		});
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
		assert.equal(double.state[STATIC_DATA_SECRET], SECRET);
	});

	it('does nothing and asks nothing when there is no endpoint to remove', async () => {
		const double = hookDouble({ listenOn: 'account' });

		assert.equal(await deleteWebhookEndpoint.call(double.hook), true);
		assert.deepEqual(double.calls, []);
	});

	it('keeps the stored keys when the deletion fails, so a retry can finish it', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: accountState(),
			answers: [rejection(403, 'forbidden_action')],
		});

		await assert.rejects(deleteWebhookEndpoint.call(double.hook), {
			message: ERROR_ACCOUNT_CAPABILITY_REQUIRED,
		});

		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
		assert.equal(double.state[STATIC_DATA_ACCOUNT_ID], ACCOUNT_ID);
	});

	it('still removes a company endpoint by company when the node is switched to account', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [answer(204, undefined)],
		});

		await deleteWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});
});

describe('account mode: a test key (fact_test_) is refused before any request', () => {
	const TEST_KEY = 'fact_test_notarealkey';

	it('fails create with the live-key message, sends nothing and stores nothing', async () => {
		const double = hookDouble({ listenOn: 'account', apiKey: TEST_KEY });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_LIVE_CREDENTIAL_REQUIRED,
		});

		assert.deepEqual(double.calls, []);
		assert.deepEqual(double.state, {});
	});

	it('fails delete with the live-key message, sends nothing and keeps the stored keys', async () => {
		const double = hookDouble({ listenOn: 'account', apiKey: TEST_KEY, state: accountState() });

		await assert.rejects(deleteWebhookEndpoint.call(double.hook), {
			message: ERROR_LIVE_CREDENTIAL_REQUIRED,
		});

		assert.deepEqual(double.calls, []);
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
	});

	it('does not apply in company mode: the request goes out', async () => {
		const double = hookDouble({ apiKey: TEST_KEY, answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })] });

		await createWebhookEndpoint.call(double.hook);

		assert.equal(double.calls.length, 1);
	});

	it('translates a REST 403 module_not_available_in_sandbox from a live-looking key', async () => {
		const double = hookDouble({
			listenOn: 'account',
			answers: [rejection(403, 'module_not_available_in_sandbox')],
		});

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_LIVE_CREDENTIAL_REQUIRED,
		});
	});

	it('keeps a REST 403 insufficient_scope as the missing-scope message', async () => {
		const double = hookDouble({
			listenOn: 'account',
			answers: [rejection(403, 'insufficient_scope')],
		});

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_INSUFFICIENT_SCOPE,
		});
	});
});

describe('account mode: no account named anywhere', () => {
	it('fails create with the account-not-selected message and sends nothing', async () => {
		const double = hookDouble({ listenOn: 'account', accountId: '' });

		await assert.rejects(createWebhookEndpoint.call(double.hook), {
			message: ERROR_ACCOUNT_NOT_SELECTED,
		});

		assert.deepEqual(double.calls, []);
		assert.deepEqual(double.state, {});
	});

	it('fails check with the same message and sends nothing', async () => {
		// The stored mode is account but the stored account is missing: the node
		// and the credential are consulted, and both are empty.
		const double = hookDouble({
			listenOn: 'account',
			accountId: '',
			state: {
				[STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID,
				[STATIC_DATA_SECRET]: SECRET,
				[STATIC_DATA_LISTEN_ON]: 'account',
			},
		});

		await assert.rejects(checkWebhookExists.call(double.hook), {
			message: ERROR_ACCOUNT_NOT_SELECTED,
		});

		assert.deepEqual(double.calls, []);
	});

	it('fails delete with the same message, sends nothing and keeps the endpoint', async () => {
		const double = hookDouble({
			listenOn: 'account',
			accountId: '',
			state: {
				[STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID,
				[STATIC_DATA_SECRET]: SECRET,
				[STATIC_DATA_LISTEN_ON]: 'account',
			},
		});

		await assert.rejects(deleteWebhookEndpoint.call(double.hook), {
			message: ERROR_ACCOUNT_NOT_SELECTED,
		});

		assert.deepEqual(double.calls, []);
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
	});
});

describe('account mode: rejections have their own message', () => {
	const cases: ReadonlyArray<readonly [string, number, string, string]> = [
		['403 live_credential_required', 403, 'live_credential_required', ERROR_LIVE_CREDENTIAL_REQUIRED],
		['403 forbidden_action', 403, 'forbidden_action', ERROR_ACCOUNT_CAPABILITY_REQUIRED],
		['402 addon_required', 402, 'addon_required', ERROR_ACCOUNT_WEBHOOKS_ADDON_REQUIRED],
		[
			'422 account_webhook_endpoint_limit_reached',
			422,
			'account_webhook_endpoint_limit_reached',
			ERROR_ACCOUNT_ENDPOINT_LIMIT_REACHED,
		],
	];

	for (const [label, status, code, message] of cases) {
		it(`translates ${label} on activation and stores nothing`, async () => {
			const double = hookDouble({
				listenOn: 'account',
				answers: [rejection(status, code)],
			});

			await assert.rejects(createWebhookEndpoint.call(double.hook), { message });

			assert.deepEqual(double.state, {});
		});
	}
});

describe('account mode: the trigger never adopts an endpoint it did not create', () => {
	it('registers a fresh endpoint when nothing is stored, without listing or reading any', async () => {
		const double = hookDouble({ listenOn: 'account', answers: [accountCreated()] });

		// n8n asks first: with no stored id the answer is "no" and nothing is
		// requested, so no existing endpoint can be picked up by URL or id.
		assert.equal(await checkWebhookExists.call(double.hook), false);
		assert.deepEqual(double.calls, []);

		await createWebhookEndpoint.call(double.hook);

		const call = onlyCall(double);

		assert.equal(call.method, 'POST');
		assert.equal(double.state[STATIC_DATA_ENDPOINT_ID], ENDPOINT_ID);
	});
});

/**
 * A company endpoint whose node was later switched to account mode.
 *
 * n8n drops the parameters a `displayOptions` rule hides, so after the switch the
 * node no longer has a Company ID. The company is therefore stored at creation
 * and preferred by the check and the deletion.
 */
describe('company endpoint stored with its company', () => {
	const storedCompanyState = (): Record<string, unknown> => ({
		[STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID,
		[STATIC_DATA_SECRET]: SECRET,
		[STATIC_DATA_COMPANY_ID]: COMPANY_ID,
	});

	it('stores the company on creation in company mode', async () => {
		const double = hookDouble({ answers: [answer(201, { data: { id: ENDPOINT_ID, secret: SECRET } })] });

		await createWebhookEndpoint.call(double.hook);

		assert.equal(double.state[STATIC_DATA_COMPANY_ID], COMPANY_ID);
	});

	it('forgets a stale stored company on creation in account mode', async () => {
		const double = hookDouble({
			listenOn: 'account',
			state: { [STATIC_DATA_COMPANY_ID]: OTHER_ACCOUNT_ID },
			answers: [accountCreated()],
		});

		await createWebhookEndpoint.call(double.hook);

		assert.ok(!(STATIC_DATA_COMPANY_ID in double.state));
	});

	it('deletes on the stored company when the hidden Company ID parameter is gone', async () => {
		const double = hookDouble({
			listenOn: 'account',
			dropHiddenParameters: true,
			state: storedCompanyState(),
			answers: [answer(204, undefined)],
		});

		assert.equal(await deleteWebhookEndpoint.call(double.hook), true);

		const call = onlyCall(double);

		assert.equal(call.method, 'DELETE');
		assert.equal(call.url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
		assert.deepEqual(double.state, {});
	});

	it('checks on the stored company when the hidden Company ID parameter is gone', async () => {
		const double = hookDouble({
			listenOn: 'account',
			dropHiddenParameters: true,
			state: storedCompanyState(),
			answers: [endpointBody()],
		});

		assert.equal(await checkWebhookExists.call(double.hook), true);
		assert.equal(onlyCall(double).url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});

	it('prefers the stored company over the node and the credential', async () => {
		const double = hookDouble({
			companyId: CREDENTIAL_COMPANY_ID,
			state: storedCompanyState(),
			answers: [answer(204, undefined)],
		});

		await deleteWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});

	it('still works for an endpoint stored before the key existed (parameter fallback)', async () => {
		const double = hookDouble({
			state: { [STATIC_DATA_ENDPOINT_ID]: ENDPOINT_ID, [STATIC_DATA_SECRET]: SECRET },
			answers: [answer(204, undefined)],
		});

		await deleteWebhookEndpoint.call(double.hook);

		assert.equal(onlyCall(double).url, `${endpointsRoot(COMPANY_ID)}/${ENDPOINT_ID}`);
	});
});
