import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import type { IDataObject, INodeExecutionData, IWebhookFunctions } from 'n8n-workflow';

import { LOAD_OPTIONS_METHOD_EVENT_TYPES, STATIC_DATA_SECRET } from '../src/client/types';
import { DEFAULT_TOLERANCE_SECONDS, DELIVERY_HEADER_LOOKUP } from '../src/contract';
import {
	ERROR_RAW_BODY_UNAVAILABLE,
	ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE,
} from '../src/errors';
import { FactuareaTrigger } from '../src/nodes/FactuareaTrigger/FactuareaTrigger.node';
import { factuareaTriggerProperties } from '../src/nodes/FactuareaTrigger/properties';

/**
 * The trigger is exercised through a double of `IWebhookFunctions`.
 *
 * The double answers only the eight members `webhook()` touches — `logger`,
 * `getRequestObject`, `getHeaderData`, `getBodyData`, `getResponseObject`,
 * `getNodeParameter`, `getWorkflowStaticData` and `helpers.returnJsonArray` —
 * and is cast to the full interface. Implementing the rest to satisfy the
 * compiler would be dozens of lines of nothing, and the cast is what keeps this
 * package free of a mocking library, and therefore of a dependency.
 *
 * Two things the double models rather than stubs, because the tests are about
 * them:
 *
 *   - The RESPONSE OBJECT records every status code the node writes itself. A
 *     status is how this node states 401 and 200, since `IWebhookResponseData`
 *     has no field for one, so "which code did it send" is only observable here.
 *   - The STATIC DATA object is created once per double and handed back by every
 *     call, exactly as n8n does with a node's persisted state. That is what makes
 *     a second `webhook()` call on the same double a genuine redelivery instead
 *     of a fresh node.
 *
 * Bodies are signed here with `node:crypto`, using the same material as the
 * emitter (`<timestamp>.<rawBody>`), so no fixture can drift away from what the
 * verifier computes.
 */

const SECRET = 'whsec_thisisnotarealsecret_testfixture';
const EVENT_ID = '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0e';
const OTHER_EVENT_ID = '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d1a';
const DELIVERY_ID = '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d10';
/** A second ATTEMPT of the same event: the delivery id changes, the event id does not. */
const OTHER_DELIVERY_ID = '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d11';

/** The eight top-level keys Factuarea publishes, as `src/contract.ts` freezes them. */
function eventBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: EVENT_ID,
		type: 'invoice.paid',
		api_version: '2026-01-01',
		created: 1767225600,
		livemode: true,
		test: false,
		correlation_id: null,
		data: { invoice: { id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0f' } },
		...overrides,
	};
}

/** The current instant in seconds, the unit the emitter stamps deliveries in. */
function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** A `Factuarea-Signature` value built the way the emitter builds it. */
function sign(rawBody: string, timestamp: number, secret: string = SECRET): string {
	const digest = createHmac('sha256', secret)
		.update(`${timestamp}.${rawBody}`, 'utf8')
		.digest('hex');

	return `t=${timestamp},v1=${digest}`;
}

/** The two members of the response object this node uses, chained as express chains. */
interface ResponseDouble {
	status(code: number): ResponseDouble;
	end(): ResponseDouble;
}

interface DoubleOptions {
	/** Bytes on the wire. Defaults to `JSON.stringify(body)`. */
	readonly rawBody?: string;
	/** Models a runtime that did not hand the raw bytes over at all. */
	readonly omitRawBody?: boolean;
	readonly body?: Record<string, unknown>;
	readonly header?: string;
	readonly deliveryId?: string;
	readonly secret?: string;
	readonly toleranceSeconds?: number;
	readonly deduplicate?: boolean;
}

interface Double {
	readonly context: IWebhookFunctions;
	readonly state: Record<string, unknown>;
	/** Status codes the node wrote itself, in order. Empty when n8n answers. */
	readonly statuses: number[];
	/** One entry per `end()`, so a status written without being sent is visible. */
	readonly ends: number[];
	/**
	 * Everything the node wrote to the n8n log at warning level, in order.
	 *
	 * Recorded rather than swallowed because a refusal answers an EMPTY 401 on
	 * purpose: the log is the only surface on which the node can say WHY it
	 * refused, so "did it say anything, and what" is observable nowhere else.
	 */
	readonly warnings: string[];
}

function webhookDouble(options: DoubleOptions = {}): Double {
	const body = options.body ?? eventBody();
	const rawBody = options.rawBody ?? JSON.stringify(body);
	const state: Record<string, unknown> = {
		[STATIC_DATA_SECRET]: options.secret ?? SECRET,
	};
	const statuses: number[] = [];
	const ends: number[] = [];
	const warnings: string[] = [];

	const response: ResponseDouble = {
		status(code: number): ResponseDouble {
			statuses.push(code);
			return response;
		},
		end(): ResponseDouble {
			ends.push(statuses.length);
			return response;
		},
	};

	const headers: Record<string, string> = {};

	if (options.header !== undefined) {
		headers[DELIVERY_HEADER_LOOKUP.signature] = options.header;
	}

	if (options.deliveryId !== undefined) {
		headers[DELIVERY_HEADER_LOOKUP.deliveryId] = options.deliveryId;
	}

	const context = {
		logger: {
			warn(message: string): void {
				warnings.push(message);
			},
		},
		getRequestObject(): unknown {
			return options.omitRawBody === true ? {} : { rawBody: Buffer.from(rawBody, 'utf8') };
		},
		getHeaderData(): Record<string, string> {
			return headers;
		},
		getBodyData(): Record<string, unknown> {
			return body;
		},
		getResponseObject(): ResponseDouble {
			return response;
		},
		getNodeParameter(name: string, fallback: unknown): unknown {
			if (name === 'toleranceSeconds') {
				return options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
			}

			if (name === 'deduplicate') {
				return options.deduplicate ?? true;
			}

			return fallback;
		},
		getWorkflowStaticData(): Record<string, unknown> {
			return state;
		},
		helpers: {
			returnJsonArray(jsonData: IDataObject | IDataObject[]): INodeExecutionData[] {
				const entries = Array.isArray(jsonData) ? jsonData : [jsonData];

				return entries.map((json) => ({ json }));
			},
		},
	} as unknown as IWebhookFunctions;

	return { context, state, statuses, ends, warnings };
}

/** Runs the trigger's request handler against a double. */
async function deliver(double: Double): ReturnType<FactuareaTrigger['webhook']> {
	return new FactuareaTrigger().webhook.call(double.context);
}

/**
 * The items of the single output branch.
 *
 * Asserting the branch count here means every test that reads an item has also
 * pinned that the node produced exactly one output branch.
 */
function itemsOf(result: Awaited<ReturnType<FactuareaTrigger['webhook']>>): INodeExecutionData[] {
	const branches = result.workflowData;

	assert.ok(branches !== undefined, 'the delivery should have produced workflow data');
	assert.equal(branches.length, 1, 'the trigger has exactly one output branch');

	const items = branches[0];

	assert.ok(items !== undefined);

	return items;
}

/** Asserts the node refused the delivery itself, with the given code and no item. */
function assertRefusedWith(
	double: Double,
	result: Awaited<ReturnType<FactuareaTrigger['webhook']>>,
	code: number,
): void {
	assert.deepEqual(double.statuses, [code], 'the node should write exactly this status');
	assert.equal(double.ends.length, 1, 'the response should be closed exactly once');
	assert.equal(result.noWebhookResponse, true, 'n8n must not send a second response');
	assert.equal(result.workflowData, undefined, 'no item may reach the workflow');
}

describe('FactuareaTrigger — accepted delivery', () => {
	it('produces one item carrying the event body and the delivery id', async () => {
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds()),
			deliveryId: DELIVERY_ID,
		});

		const result = await deliver(double);
		const items = itemsOf(result);

		assert.equal(items.length, 1);

		const json = items[0]?.json;

		assert.ok(json !== undefined);
		// The whole item, pinned at once: every key of the event body survives
		// unrenamed and unflattened, and exactly one field is added.
		assert.deepEqual(json, { ...body, delivery_id: DELIVERY_ID });
		// The added key's NAME is frozen — it is documented literally in the
		// README and workflows are built on it — so it is asserted as a literal
		// here too, not only through the object comparison above.
		assert.equal(json['delivery_id'], DELIVERY_ID);

		assert.deepEqual(double.statuses, [], 'an accepted delivery is answered by n8n');
	});

	it('adds delivery_id as null rather than dropping the key when the header is absent', async () => {
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({ body, rawBody, header: sign(rawBody, nowSeconds()) });

		const json = itemsOf(await deliver(double))[0]?.json;

		assert.ok(json !== undefined);
		assert.ok('delivery_id' in json, 'the key must always be present');
		assert.equal(json['delivery_id'], null);
	});

	it('produces an item for each of two distinct events', async () => {
		const first = eventBody();
		const firstRaw = JSON.stringify(first);
		const firstDouble = webhookDouble({
			body: first,
			rawBody: firstRaw,
			header: sign(firstRaw, nowSeconds()),
		});

		const second = eventBody({ id: OTHER_EVENT_ID });
		const secondRaw = JSON.stringify(second);
		const secondDouble = webhookDouble({
			body: second,
			rawBody: secondRaw,
			header: sign(secondRaw, nowSeconds()),
		});

		assert.equal(itemsOf(await deliver(firstDouble)).length, 1);
		assert.equal(itemsOf(await deliver(secondDouble)).length, 1);
	});
});

describe('FactuareaTrigger — refused delivery', () => {
	it('answers 401 and produces no item when the body was altered after signing', async () => {
		// Signed over the original bytes, delivered with different ones: exactly
		// what a body modified in transit looks like.
		const signedRaw = JSON.stringify(eventBody());
		const tampered = eventBody({ type: 'invoice.voided' });
		const double = webhookDouble({
			body: tampered,
			rawBody: JSON.stringify(tampered),
			header: sign(signedRaw, nowSeconds()),
			deliveryId: DELIVERY_ID,
		});

		assertRefusedWith(double, await deliver(double), 401);
	});

	it('answers 401 when the timestamp is older than the tolerance, signature notwithstanding', async () => {
		// The signature is CORRECT for the timestamp it carries. Only the age of
		// that timestamp makes this a replay, which is the whole reason the
		// tolerance check exists and runs before the HMAC.
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const stale = nowSeconds() - (DEFAULT_TOLERANCE_SECONDS + 60);
		const double = webhookDouble({ body, rawBody, header: sign(rawBody, stale) });

		assertRefusedWith(double, await deliver(double), 401);
	});

	it('answers 401 when the timestamp is further in the future than the tolerance', async () => {
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const ahead = nowSeconds() + (DEFAULT_TOLERANCE_SECONDS + 60);
		const double = webhookDouble({ body, rawBody, header: sign(rawBody, ahead) });

		assertRefusedWith(double, await deliver(double), 401);
	});

	it('answers 401 when the signature header is absent', async () => {
		const double = webhookDouble();

		assertRefusedWith(double, await deliver(double), 401);
	});

	it('answers 401 when the node holds no secret', async () => {
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds()),
			secret: '',
		});

		assertRefusedWith(double, await deliver(double), 401);
	});
});

describe('FactuareaTrigger — what a refusal says, and to whom', () => {
	it('logs the rotation message when a recent delivery matches no candidate', async () => {
		// Signed with a DIFFERENT secret and stamped NOW: the timestamp passes the
		// tolerance check and the digest matches nothing, which is the shape of a
		// secret rotated outside n8n and the one refusal the node can explain.
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds(), 'whsec_arotatedsecretthenodeneversaw'),
		});

		assertRefusedWith(double, await deliver(double), 401);

		// EXACTLY the catalogued message, not a paraphrase: it is the one place
		// the user is told that the remedy is to re-activate the workflow, and a
		// message that drifts from the catalogue drifts away from the three
		// docblocks and the limitation page that quote it.
		assert.deepEqual(double.warnings, [ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE]);
	});

	it('says nothing at all when the signature header cannot be read', async () => {
		// A header that does not parse is a probe, a proxy or a hand-made request,
		// never a rotation. Logging it would let anyone fill the instance log by
		// POSTing garbage at a URL that is public by construction.
		const double = webhookDouble({ header: 'this-is-not-a-signature-header' });

		assertRefusedWith(double, await deliver(double), 401);
		assert.deepEqual(double.warnings, []);
	});

	it('says nothing on the wire beyond the status, whatever it logs', async () => {
		// The refusal answers an EMPTY body on purpose: an unauthenticated caller
		// must not learn which check refused, or each rejection becomes a free
		// oracle. The log entry above is for the workflow's owner, and the two
		// audiences must not be confused.
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds(), 'whsec_arotatedsecretthenodeneversaw'),
		});

		const result = await deliver(double);

		assert.equal(result.noWebhookResponse, true);
		assert.equal(result.workflowData, undefined);
		assert.equal(result.webhookResponse, undefined, 'no body may reach the caller');
	});
});

describe('FactuareaTrigger — the order of the checks, pinned', () => {
	it('does not remember the id of a delivery it refused', async () => {
		// Deduplication runs AFTER verification, and this is what that buys. An
		// unsigned request carrying the id of an event someone wants suppressed
		// must not reach the memory: if it did, the genuine delivery of that event
		// would arrive later, be found there and be dropped with a 200 — a denial
		// of service needing no secret, no signature and leaving no trace.
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const poisoned = webhookDouble({ body, rawBody, header: sign(rawBody, nowSeconds(), 'whsec_wrong') });

		assertRefusedWith(poisoned, await deliver(poisoned), 401);

		// The legitimate delivery of the SAME event, on a node whose memory the
		// refusal above shared, still produces its item.
		const legitimate = webhookDouble({ body, rawBody, header: sign(rawBody, nowSeconds()) });

		Object.assign(legitimate.state, poisoned.state);

		assert.equal(itemsOf(await deliver(legitimate)).length, 1);
	});

	it('keys the memory on the body id and never on the delivery header', async () => {
		// `Factuarea-Event-Id` carries the same value as `id` but is NOT part of
		// the signed material, so keying on it would let anyone who cannot forge a
		// body still steer which events get suppressed. Two deliveries of the same
		// event with DIFFERENT delivery headers are still one event.
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds()),
			deliveryId: DELIVERY_ID,
		});

		assert.equal(itemsOf(await deliver(double)).length, 1);

		const second = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds()),
			deliveryId: OTHER_DELIVERY_ID,
		});

		Object.assign(second.state, double.state);

		const repeat = await deliver(second);

		assert.deepEqual(second.statuses, [200], 'a different delivery of the same event is a repeat');
		assert.equal(repeat.workflowData, undefined);
	});
});

describe('FactuareaTrigger — repeated delivery', () => {
	it('answers 200 and produces no item the second time the same event arrives', async () => {
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		// One double, called twice: it hands back the same static data object both
		// times, which is what makes the second call a real redelivery.
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds()),
			deliveryId: DELIVERY_ID,
		});

		assert.equal(itemsOf(await deliver(double)).length, 1, 'the first delivery is accepted');

		const repeat = await deliver(double);

		assert.deepEqual(double.statuses, [200], 'a repeat is acknowledged, never refused');
		assert.equal(double.ends.length, 1);
		assert.equal(repeat.noWebhookResponse, true);
		assert.equal(repeat.workflowData, undefined, 'the workflow must not run twice');
	});

	it('produces a second item when deduplication is turned off', async () => {
		const body = eventBody();
		const rawBody = JSON.stringify(body);
		const double = webhookDouble({
			body,
			rawBody,
			header: sign(rawBody, nowSeconds()),
			deduplicate: false,
		});

		assert.equal(itemsOf(await deliver(double)).length, 1);
		assert.equal(itemsOf(await deliver(double)).length, 1);
		assert.deepEqual(double.statuses, [], 'neither delivery is intercepted');
	});
});

describe('FactuareaTrigger — raw body unavailable', () => {
	it('fails with the catalogued message instead of reserialising the parsed body', async () => {
		const double = webhookDouble({ omitRawBody: true, header: 'irrelevant' });

		await assert.rejects(
			async () => deliver(double),
			(error: unknown) =>
				error instanceof Error && error.message === ERROR_RAW_BODY_UNAVAILABLE,
		);

		// Thrown, not answered: this is an internal failure, and it has to reach
		// the emitter as a 5xx it will retry rather than as a 4xx it will not.
		assert.deepEqual(double.statuses, []);
	});
});

describe('FactuareaTrigger — description and wiring', () => {
	const { description } = new FactuareaTrigger();

	it('declares itself a trigger with no input and one main output', () => {
		assert.equal(description.name, 'factuareaTrigger');
		assert.equal(description.displayName, 'Factuarea Trigger');
		assert.equal(description.version, 1);
		assert.equal(description.icon, 'file:factuarea.svg');
		assert.deepEqual(description.group, ['trigger']);
		assert.deepEqual(description.inputs, []);
		assert.deepEqual(description.outputs, ['main']);
		assert.ok(typeof description.subtitle === 'string' && description.subtitle.includes('events'));
	});

	it('requires the Factuarea credential', () => {
		assert.deepEqual(description.credentials, [{ name: 'factuareaApi', required: true }]);
	});

	it('declares one POST webhook that asks for the raw body', () => {
		assert.equal(description.webhooks?.length, 1);

		const webhook = description.webhooks?.[0];

		assert.ok(webhook !== undefined);
		assert.equal(webhook.name, 'default');
		assert.equal(webhook.httpMethod, 'POST');
		assert.equal(webhook.responseMode, 'onReceived');
		assert.equal(webhook.path, 'factuarea');
		// Without this flag there are no bytes to verify, and the node would have
		// nothing to do but reject every delivery.
		assert.equal(webhook['rawBody'], true);
	});

	it('exposes the properties of the properties module, unmodified', () => {
		assert.equal(description.properties, factuareaTriggerProperties);
	});

	it('registers the load-options method under the frozen name', () => {
		// The picker is filled by name, so a typo on either side of this string
		// produces an empty event list and no error at all.
		const node = new FactuareaTrigger();

		assert.equal(
			typeof node.methods.loadOptions[LOAD_OPTIONS_METHOD_EVENT_TYPES],
			'function',
		);
	});

	it('registers the three lifecycle methods under the default webhook', () => {
		const { webhookMethods } = new FactuareaTrigger();

		assert.equal(typeof webhookMethods.default.checkExists, 'function');
		assert.equal(typeof webhookMethods.default.create, 'function');
		assert.equal(typeof webhookMethods.default.delete, 'function');
	});
});
