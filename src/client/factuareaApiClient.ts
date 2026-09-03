/**
 * The client for the four Factuarea public API v1 operations this node performs.
 *
 * It owns no transport of its own. n8n injects `this.helpers.httpRequest` and
 * that function arrives here as `FactuareaHttpRequester`, which is why the
 * package declares no runtime dependency and why the tests can hand it a double
 * without a mocking library.
 *
 * ## Every failure is translated, and never echoed
 *
 * The API answers a failure with `{ error: { type, code, subcode?, message,
 * param? } }`, and `message` is written in Spanish for an audience that is not
 * this node's. Worse, an error body can carry account data. So the raw body
 * NEVER reaches a thrown message: it is read for its `code`, `subcode` and
 * `param`, and then discarded. What surfaces is one of the frozen English
 * messages of `src/errors.ts`, or — when nothing in the catalogue fits — a
 * message composed here that names the OPERATION and the HTTP status and
 * nothing else.
 *
 * The discriminating values were measured 2026-09-02 against the monorepo, and
 * they are the reason two different 422s produce two different messages:
 *
 *   - `invalid_url_target` (422, `param=url`) — `WebhookUrlTargetRejectedException`,
 *     thrown by `WebhookUrl::create()` when `EgressHostPolicy` refuses the host
 *     (loopback, private, CGNAT, ULA, link-local, …). Measured at
 *     `backend/config/public_api_error_codes.php:704` and
 *     `backend/app/Webhooks/Domain/Exception/WebhookUrlTargetRejectedException.php:91,101`.
 *   - `invalid_param_value` (422) with `param=url` — the plain validation
 *     failure of `CreateWebhookEndpointRequest`, whose `url` rule is
 *     `regex:/^https:\/\//i`. The renderer turns any `ValidationException` into
 *     this code with the first failing field as `param`
 *     (`ExceptionRenderer.php:376-383`).
 *   - `business_rule_violation` (422) with `subcode=max_webhook_endpoints_reached`
 *     — `MaxWebhookEndpointsExceededException`. The subcode is what identifies
 *     it; the code is the generic one that fourteen other 422s of that bounded
 *     context also use.
 *
 * The first two mean "this address will never work", the third means "free a
 * slot". Collapsing them into one message would send the user to the wrong fix,
 * which is why the client reads the envelope instead of only the status.
 *
 * The catalogue also declares a top-level `max_webhook_endpoints_exceeded`
 * (422), which no exception emits today. It is accepted here as an alternative
 * spelling of the same condition so that a future emitter switching to it does
 * not silently degrade the message to the generic fallback.
 *
 * ## Response envelopes, measured
 *
 *   `POST /v1/webhook_endpoints`         201 `{ data: { …, secret } }`
 *   `GET  /v1/webhook_endpoints/{id}`    200 `{ data: { … } }`, 404 when gone
 *   `DELETE /v1/webhook_endpoints/{id}`  204 no content
 *   `GET  /v1/event-catalog`             200 `{ data: [ { name, category, description, status } ] }`
 *
 * The `data` envelope is required, not guessed: reading a response that lacks it
 * as if it were the resource would hand the rest of the node an object with no
 * `id` and no `secret`, and the trigger would then reject every delivery with
 * nothing to explain it.
 */

import { randomUUID } from 'node:crypto';

import {
	ERROR_ENDPOINT_GONE,
	ERROR_ENDPOINT_LIMIT_REACHED,
	ERROR_ENDPOINT_URL_NOT_ACCEPTED,
	ERROR_EVENT_CATALOG_UNAVAILABLE,
	ERROR_INSUFFICIENT_SCOPE,
	ERROR_NO_EVENTS_SELECTED,
} from '../errors';
import type {
	CreateWebhookEndpointInput,
	EventCatalogEntryV1,
	FactuareaApiClient,
	FactuareaApiClientOptions,
	FactuareaHttpRequestOptions,
	FactuareaHttpRequester,
	WebhookEndpointV1,
	WebhookEndpointWithSecretV1,
} from './types';

/** Error code the API emits when the egress policy refuses the target host. */
const CODE_INVALID_URL_TARGET = 'invalid_url_target';

/** Error code the API emits for any failed field validation. */
const CODE_INVALID_PARAM_VALUE = 'invalid_param_value';

/** Alternative top-level spelling of the destination-limit condition. */
const CODE_MAX_ENDPOINTS = 'max_webhook_endpoints_exceeded';

/** Subcode that identifies the destination-limit condition today. */
const SUBCODE_MAX_ENDPOINTS_REACHED = 'max_webhook_endpoints_reached';

/** The field the two URL rejections point at. */
const PARAM_URL = 'url';

/**
 * The field an EMPTY event selection points at.
 *
 * The rule is `required|array|min:1` on `enabled_events`, and the renderer sets
 * `param` to the first failing key (`ExceptionRenderer.php:376-383`,
 * `array_key_first`). So this exact spelling is the empty list and nothing else:
 * an element the catalogue refuses fails as `enabled_events.0`, keeps its own
 * cause, and correctly falls through to the composed message.
 *
 * `webhookLifecycle.ts` refuses an empty selection before the request goes out,
 * which is where the user gets told fastest. This branch is what keeps the
 * CLIENT honest on its own: it is a separate module with its own callers and its
 * own tests, and translating this answer into "check your API key" would send
 * whoever gets here looking at a credential that is perfectly fine.
 */
const PARAM_ENABLED_EVENTS = 'enabled_events';

/** The operations, used only to name what failed in a composed message. */
type OperationKey = 'create' | 'read' | 'delete';

/** What the client learned about one HTTP exchange, whatever shape it took. */
interface ApiOutcome {
	statusCode: number;
	body: unknown;
}

/** The three discriminating fields of the v1 error envelope. */
interface ApiErrorEnvelope {
	code: string | null;
	subcode: string | null;
	param: string | null;
}

/** Narrows to a plain object; arrays and `null` are not records here. */
function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The value as a non-empty string, or `null`. */
function asText(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * The value as an HTTP status code.
 *
 * Accepts a number or a numeric string, because `NodeApiError` carries its
 * status in `httpCode: string | null` while a raw transport error carries it in
 * `statusCode: number`. Anything outside the HTTP range is rejected, which is
 * what keeps a transport error's `code` (`ECONNREFUSED`) from being mistaken for
 * a status.
 */
function asStatusCode(value: unknown): number | null {
	const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;

	return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

/** The first readable status among the keys a failure can carry it in. */
function readStatus(source: Record<string, unknown> | null): number | null {
	if (source === null) {
		return null;
	}

	return (
		asStatusCode(source['statusCode']) ?? asStatusCode(source['httpCode']) ?? asStatusCode(source['status'])
	);
}

/** Parses a JSON string, returning `null` rather than throwing on garbage. */
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The body as a structured value: a JSON string is parsed, anything else kept. */
function structuredBody(body: unknown): unknown {
	return typeof body === 'string' ? parseJson(body) : body;
}

/**
 * Reads the discriminating fields of the error envelope.
 *
 * Deliberately total: a body that is missing, unparseable or shaped differently
 * yields three `null`s and the caller falls through to the composed message. A
 * client that threw while working out why a request failed would replace a
 * useful message with a useless one.
 */
function errorEnvelopeOf(body: unknown): ApiErrorEnvelope {
	const error = asRecord(asRecord(structuredBody(body))?.['error']);

	return {
		code: asText(error?.['code']),
		subcode: asText(error?.['subcode']),
		param: asText(error?.['param']),
	};
}

/** The `data` member of a v1 response envelope, or `undefined` when absent. */
function dataOf(body: unknown): unknown {
	const record = asRecord(structuredBody(body));

	return record === null ? undefined : record['data'];
}

function isSuccess(statusCode: number): boolean {
	return statusCode >= 200 && statusCode <= 299;
}

/** What the failed operation was trying to do, in the user's terms. */
const OPERATION_SUBJECT: Record<OperationKey, string> = {
	create: 'register a webhook destination for this workflow',
	read: 'check whether the webhook destination this trigger registered still exists',
	delete: 'remove the webhook destination this trigger registered',
};

/**
 * The message for a failure the frozen catalogue has no entry for.
 *
 * It is composed here rather than added to `src/errors.ts` because it is not a
 * distinct CAUSE: it is the honest admission that the cause is unknown. It names
 * the operation and the status, and carries no fragment of the response.
 */
function composedFailure(operation: OperationKey, statusCode: number): string {
	return (
		`Factuarea could not ${OPERATION_SUBJECT[operation]}: the API answered with HTTP ${statusCode}. ` +
		'Check that the API key in this credential is still valid and that Factuarea is reachable, ' +
		'then activate this workflow again.'
	);
}

/**
 * The message for a request that never got an HTTP answer at all.
 *
 * The CREATE gets a different one, and the difference is not politeness. "The
 * request did not reach Factuarea" is what a refused connection or a DNS failure
 * means, and for a read or a delete it is the whole story. For the creation it
 * is a claim this client cannot make: a read timeout fires after the request was
 * sent, so Factuarea may already have registered the destination and answered
 * into a socket nobody was listening on. The id is then not stored, `checkExists`
 * knows nothing about it, and every retried activation registers ANOTHER one —
 * silently, until the account hits its destination limit and the trigger fails
 * with a message about a limit the user never knowingly approached.
 *
 * So the creation says the outcome is UNKNOWN and points at the one screen where
 * it can be seen. Claiming a certainty the client does not have is what turned
 * this from a transient failure into an invisible one.
 */
function composedTransportFailure(operation: OperationKey): string {
	if (operation === 'create') {
		return (
			'Factuarea did not answer the request to register a webhook destination for this workflow, ' +
			'so it is unknown whether the destination was registered: the answer can be lost after ' +
			'Factuarea has already created it, and each attempt that ends this way can leave one behind. ' +
			'Open Settings, Developers, Webhooks in Factuarea and delete any destination pointing at this ' +
			"workflow's URL, check that this n8n instance can make outbound HTTPS requests to the API base " +
			'URL in this credential, then activate this workflow again.'
		);
	}

	return (
		`Factuarea could not ${OPERATION_SUBJECT[operation]}: the request did not reach Factuarea. ` +
		'Check that this n8n instance can make outbound HTTPS requests to the API base URL in this ' +
		'credential, then activate this workflow again.'
	);
}

/** The message for an answer whose shape the node cannot use. */
function composedMalformedResponse(operation: OperationKey): string {
	return (
		`Factuarea answered the request to ${OPERATION_SUBJECT[operation]} in a shape this trigger ` +
		'does not recognise, so it cannot continue. Check that the API base URL in this credential ' +
		'points at the Factuarea public API and not at a proxy that rewrites responses, then activate ' +
		'this workflow again.'
	);
}

/**
 * Turns a failed exchange into the message the user will read.
 *
 * The status alone decides 403 and 404 — every 403 this node can provoke is a
 * missing scope, and every 404 on a destination route is a destination that is
 * gone. The two 422s are the only case that needs the envelope, because they
 * share a status and have opposite remedies.
 *
 * `getWebhookEndpoint` and `deleteWebhookEndpoint` answer 404 themselves, before
 * reaching this function, because for them "it is gone" is a normal lifecycle
 * answer rather than a failure. The rule stays here so that no destination
 * operation can ever report a 404 as an unexplained status.
 */
function translateEndpointFailure(outcome: ApiOutcome, operation: OperationKey): Error {
	if (outcome.statusCode === 403) {
		return new Error(ERROR_INSUFFICIENT_SCOPE);
	}

	if (outcome.statusCode === 404) {
		return new Error(ERROR_ENDPOINT_GONE);
	}

	if (outcome.statusCode === 422) {
		const envelope = errorEnvelopeOf(outcome.body);

		if (envelope.subcode === SUBCODE_MAX_ENDPOINTS_REACHED || envelope.code === CODE_MAX_ENDPOINTS) {
			return new Error(ERROR_ENDPOINT_LIMIT_REACHED);
		}

		if (
			envelope.code === CODE_INVALID_URL_TARGET ||
			(envelope.code === CODE_INVALID_PARAM_VALUE && envelope.param === PARAM_URL)
		) {
			return new Error(ERROR_ENDPOINT_URL_NOT_ACCEPTED);
		}

		if (envelope.code === CODE_INVALID_PARAM_VALUE && envelope.param === PARAM_ENABLED_EVENTS) {
			return new Error(ERROR_NO_EVENTS_SELECTED);
		}
	}

	return new Error(composedFailure(operation, outcome.statusCode));
}

/**
 * Reads an outcome out of whatever the helper threw.
 *
 * `ignoreHttpStatusErrors` asks the helper not to throw on a 4xx, and the real
 * one obeys. This exists because not every caller of this code path is the real
 * one: an older helper, a helper wrapped by another node, and a test double all
 * may throw instead, and a client that only understood the happy shape would
 * turn every API rejection into an unexplained crash.
 *
 * Returns `null` when the failure carries no status at all — a DNS failure, a
 * refused connection, a timeout — which the caller reports as a transport
 * failure rather than inventing a status for it.
 */
function outcomeFromThrown(error: unknown): ApiOutcome | null {
	const thrown = asRecord(error);
	const response = asRecord(thrown?.['response']);
	const cause = asRecord(thrown?.['cause']);
	const statusCode = readStatus(thrown) ?? readStatus(response) ?? readStatus(cause);

	if (statusCode === null) {
		return null;
	}

	const body =
		response?.['body'] ?? response?.['data'] ?? thrown?.['body'] ?? cause?.['body'] ?? thrown?.['cause'];

	return { statusCode, body };
}

/**
 * Performs one exchange and reports its status, never throwing on a 4xx.
 *
 * A helper that honours `returnFullResponse` hands back `{ statusCode, body }`;
 * one that ignores it hands back the parsed body, which is treated as a 200
 * because a helper that ignored the flag would also have thrown on anything
 * else. The two are told apart by an actual HTTP status being present, not by
 * the presence of a key some payload could also have.
 */
async function exchange(
	request: FactuareaHttpRequester,
	options: FactuareaHttpRequestOptions,
): Promise<ApiOutcome | null> {
	let raw: unknown;

	try {
		raw = await request(options);
	} catch (error) {
		return outcomeFromThrown(error);
	}

	const full = asRecord(raw);

	if (full !== null) {
		const statusCode = asStatusCode(full['statusCode']);

		if (statusCode !== null) {
			return { statusCode, body: full['body'] };
		}
	}

	return { statusCode: 200, body: raw };
}

/** Strips trailing slashes so a credential ending in `/` still composes cleanly. */
function normaliseBaseUrl(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, '');
}

export function createFactuareaApiClient(
	request: FactuareaHttpRequester,
	options: FactuareaApiClientOptions,
): FactuareaApiClient {
	const baseUrl = normaliseBaseUrl(options.baseUrl);

	/**
	 * `Authorization: Bearer` and not `X-API-Key`: the API accepts both and
	 * prefers this one (`AuthenticateApiKey.php:236-244`).
	 */
	const readHeaders: Record<string, string> = {
		Authorization: `Bearer ${options.apiKey}`,
		Accept: 'application/json',
	};

	/**
	 * Headers for one write, carrying an idempotency key THAT IS NEW ON EVERY
	 * INVOCATION — which is why this is a function and not a constant.
	 *
	 * Today the key is inert. `backend/config/public_api.php` leaves
	 * `idempotency.required_from` null for both `test` and `live`, so there is no
	 * cutoff date and nothing is demanded; and `doc-write`, the family both of
	 * this node's writes belong to (`V1WriteFamilyMap.php:437-438`), is
	 * deliberately kept out of `idempotency.required_families`.
	 *
	 * It is sent anyway because of the OTHER, INDEPENDENT signal:
	 * `OpenApiOperationScopeRegistry.php:544` declares
	 * `public-api.v1.webhook_endpoints.delete` with `'irreversible' => true`, and
	 * an operation the published registry calls irreversible is ELEVATED into
	 * requiring a key by its identifier, whatever its family. The day a cutoff
	 * date is configured, a DELETE without this header answers 422
	 * `idempotency_key_required` — and the failure would land on DEACTIVATING a
	 * workflow, the one moment a user cannot work around it. Sending a fresh
	 * UUID costs nothing now and removes that cliff entirely.
	 *
	 * A NEW key per invocation, never a stored one: the key exists to make a
	 * retried request safe, not to make two deliberate calls collapse into one.
	 * Reusing it across activations would replay the first answer and hand back a
	 * destination — and a secret — that no longer exists.
	 *
	 * GET requests get none. A read has nothing to replay.
	 */
	function writeHeaders(): Record<string, string> {
		return {
			...readHeaders,
			'Idempotency-Key': randomUUID(),
		};
	}

	return {
		async createWebhookEndpoint(
			input: CreateWebhookEndpointInput,
		): Promise<WebhookEndpointWithSecretV1> {
			const outcome = await exchange(request, {
				method: 'POST',
				url: `${baseUrl}/webhook_endpoints`,
				headers: { ...writeHeaders(), 'Content-Type': 'application/json' },
				body: input,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});

			if (outcome === null) {
				throw new Error(composedTransportFailure('create'));
			}

			if (!isSuccess(outcome.statusCode)) {
				throw translateEndpointFailure(outcome, 'create');
			}

			const data = asRecord(dataOf(outcome.body));

			// The secret is returned exactly once, by this call and nothing else.
			// Accepting a response without it would persist an empty secret and
			// leave a trigger that rejects every delivery it receives, with no
			// way to recover short of re-activating. Failing here is the only
			// honest option, and it is why `id` and `secret` are checked rather
			// than assumed.
			if (data === null || asText(data['id']) === null || asText(data['secret']) === null) {
				throw new Error(composedMalformedResponse('create'));
			}

			return data as unknown as WebhookEndpointWithSecretV1;
		},

		async getWebhookEndpoint(id: string): Promise<WebhookEndpointV1 | null> {
			const outcome = await exchange(request, {
				method: 'GET',
				url: `${baseUrl}/webhook_endpoints/${encodeURIComponent(id)}`,
				headers: readHeaders,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});

			if (outcome === null) {
				throw new Error(composedTransportFailure('read'));
			}

			// "It is gone" is a normal lifecycle answer, not a failure: the
			// trigger reacts to it by registering a new destination.
			if (outcome.statusCode === 404) {
				return null;
			}

			if (!isSuccess(outcome.statusCode)) {
				throw translateEndpointFailure(outcome, 'read');
			}

			const data = asRecord(dataOf(outcome.body));

			if (data === null || asText(data['id']) === null) {
				throw new Error(composedMalformedResponse('read'));
			}

			return data as unknown as WebhookEndpointV1;
		},

		async deleteWebhookEndpoint(id: string): Promise<void> {
			const outcome = await exchange(request, {
				method: 'DELETE',
				url: `${baseUrl}/webhook_endpoints/${encodeURIComponent(id)}`,
				headers: writeHeaders(),
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});

			if (outcome === null) {
				throw new Error(composedTransportFailure('delete'));
			}

			// Already gone is success: deactivating a workflow twice, or
			// deactivating one whose destination was removed from the Factuarea
			// dashboard, is not something the user should have to see an error
			// about. The end state is the one that was asked for.
			if (outcome.statusCode === 404 || isSuccess(outcome.statusCode)) {
				return;
			}

			throw translateEndpointFailure(outcome, 'delete');
		},

		async listEventCatalog(): Promise<EventCatalogEntryV1[]> {
			const outcome = await exchange(request, {
				method: 'GET',
				url: `${baseUrl}/event-catalog`,
				headers: readHeaders,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
			});

			// A missing scope is the one catalogue failure worth naming
			// precisely: `ERROR_INSUFFICIENT_SCOPE` names `events:read` and where
			// to grant it, which "the list could not be loaded" does not. Every
			// other failure — including a body this node cannot read — becomes
			// `ERROR_EVENT_CATALOG_UNAVAILABLE`, because the one thing that must
			// never happen is falling back to a hand-written list of event names
			// that the API would then refuse to subscribe to.
			if (outcome === null) {
				throw new Error(ERROR_EVENT_CATALOG_UNAVAILABLE);
			}

			if (outcome.statusCode === 403) {
				throw new Error(ERROR_INSUFFICIENT_SCOPE);
			}

			if (!isSuccess(outcome.statusCode)) {
				throw new Error(ERROR_EVENT_CATALOG_UNAVAILABLE);
			}

			const data = dataOf(outcome.body);

			if (!Array.isArray(data)) {
				throw new Error(ERROR_EVENT_CATALOG_UNAVAILABLE);
			}

			// Only `available` entries reach the picker. An entry the catalogue
			// marks `coming_soon` is announced but not emitted yet, and
			// subscribing to it is rejected with 422 by the creation call — an
			// error the user would have no way of understanding, since the node
			// itself offered the option.
			return data.filter((entry: unknown): entry is EventCatalogEntryV1 => {
				const record = asRecord(entry);

				return (
					record !== null &&
					asText(record['name']) !== null &&
					record['status'] === 'available'
				);
			});
		},
	};
}
