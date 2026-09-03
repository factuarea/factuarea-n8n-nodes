/**
 * The three lifecycle methods n8n calls when a workflow carrying this trigger is
 * activated and deactivated.
 *
 * n8n registers them under `webhookMethods.default` as `checkExists`, `create`
 * and `delete`, and calls them in that order: it asks whether the subscription
 * is already in place, creates it when it is not, and removes it on
 * deactivation. Each one answers `true` for "the end state you asked for is the
 * one that now holds"; a failure is thrown, never reported as `false`.
 *
 * The two keys they read and write in the node's own static data are frozen in
 * `src/client/types.ts`, because the request handler reads what this file
 * writes and the two are written by different phases:
 *
 *     'webhookEndpointId'  uuid of the destination this trigger owns
 *     'webhookSecret'      the plaintext signing secret
 *
 * ## THIS TRIGGER OWNS ITS DESTINATION AND NEVER ADOPTS AN EXISTING ONE
 *
 * There is deliberately no way to point this trigger at a webhook destination
 * that already exists in Factuarea — not by pasting its id, not by matching it
 * on its URL, not by picking it from a list. Adopting one is prohibited, and the
 * reason is a property of the API rather than a preference:
 *
 *   **The plaintext secret is returned exactly once, by the creation call.**
 *   `GET /v1/webhook_endpoints/{id}` returns eighteen keys and `secret` is not
 *   among them, and there is no other route that hands it back.
 *
 * A trigger holding a destination it did not create therefore has no secret to
 * verify with. Every delivery would arrive correctly signed, fail verification,
 * and be answered with a rejection — 100% of them, permanently. And because the
 * emitter treats a 4xx as a permanent failure with no retry, the events would
 * not merely be delayed, they would be lost. Worse, the trigger could not
 * explain itself: from inside the verification the shape of "I hold the wrong
 * secret" is identical to "someone is forging deliveries", so the only honest
 * message it could produce is the one it produces today
 * (`ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE`), which points at a rotation the
 * user never performed.
 *
 * The same fact governs `checkExists`: the question it answers is not "does a
 * destination for this URL exist in Factuarea" but "does the destination THIS
 * NODE created still exist". A destination created by another workflow, by the
 * dashboard or by the CLI is invisible to it on purpose.
 *
 * ## Where the events, the URL and the credential come from
 *
 * The receiving address is n8n's (`getNodeWebhookUrl`) — it is the only party
 * that knows the public address this instance answers on. The event list is the
 * `events` parameter of `src/nodes/FactuareaTrigger/properties.ts`. The API key
 * and base URL are the `factuareaApi` credential of
 * `src/credentials/FactuareaApi.credentials.ts`.
 */

import type {
	IHookFunctions,
	IHttpRequestOptions,
	IWorkflowMetadata,
	WebhookSetupMethodNames,
} from 'n8n-workflow';

import { createFactuareaApiClient } from '../../client/factuareaApiClient';
import type {
	FactuareaApiClient,
	FactuareaHttpRequestOptions,
	FactuareaHttpRequester,
} from '../../client/types';
import { STATIC_DATA_ENDPOINT_ID, STATIC_DATA_SECRET } from '../../client/types';
import { DEFAULT_API_BASE_URL } from '../../contract';
import {
	ERROR_ENDPOINT_NOT_ACTIVE,
	ERROR_ENDPOINT_URL_MISMATCH,
	ERROR_ENDPOINT_URL_NOT_ACCEPTED,
	ERROR_NO_EVENTS_SELECTED,
} from '../../errors';

/**
 * Name of the credential type this node requires.
 *
 * It is the `name` of `src/credentials/FactuareaApi.credentials.ts`. n8n looks
 * the credential up by this string, so a mismatch produces a trigger that cannot
 * authenticate rather than a compile error.
 */
const CREDENTIAL_NAME = 'factuareaApi';

/**
 * The webhook whose URL this trigger registers.
 *
 * `default` is the name the node description gives its single webhook; n8n has
 * no URL to hand back under any other name.
 */
const WEBHOOK_NAME = 'default';

/** Name of the node parameter holding the subscribed event names. */
const PARAMETER_EVENTS = 'events';

/**
 * The scheme Factuarea accepts, matched the way the API matches it.
 *
 * `CreateWebhookEndpointRequest` validates `url` with `regex:/^https:\/\//i`, so
 * the check here is case-insensitive too. A stricter local check would reject an
 * address the API would have accepted, and a looser one would send a request
 * that is certain to fail.
 */
const HTTPS_SCHEME = /^https:\/\//i;

/**
 * The one status in which Factuarea actually delivers.
 *
 * `WebhookEndpointResource` renders `status` on every read, and
 * `DeliverWebhookCommandHandler` drops a delivery whose endpoint is not active.
 * The other two observed values, `disabled` and `degraded`, are not spelled out
 * here because the question is never "which failure is it" but "is this
 * destination still delivering": enumerating the bad values would silently bless
 * a value added later.
 */
const STATUS_ACTIVE = 'active';

/** The shape of the credential this node reads. */
interface FactuareaCredential {
	apiKey?: unknown;
	baseUrl?: unknown;
}

/** The value as a non-empty string, or `null`. */
function asText(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/** The parameter value as a list of event names, ignoring anything else. */
function asEventNames(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: [];
}

/**
 * Adapts the HTTP helper n8n injects to the requester the API client expects.
 *
 * The client takes its transport as an argument precisely so that this package
 * declares no runtime dependency and the client's own tests can hand it a plain
 * function. What crosses here is a narrowing, not a translation: every field of
 * `FactuareaHttpRequestOptions` has the same name and meaning in
 * `IHttpRequestOptions`, and the object is rebuilt field by field rather than
 * cast so that a field added on either side has to be looked at.
 *
 * `body` is the one field that needs a cast: the client declares it `unknown`
 * because it is whatever the operation sends, while n8n enumerates the shapes
 * its helper accepts. The only body this node ever sends is the plain object of
 * `CreateWebhookEndpointInput`.
 */
function requesterFor(context: IHookFunctions): FactuareaHttpRequester {
	return async (options: FactuareaHttpRequestOptions): Promise<unknown> =>
		context.helpers.httpRequest({
			method: options.method,
			url: options.url,
			headers: options.headers,
			body: options.body as IHttpRequestOptions['body'],
			json: options.json,
			returnFullResponse: options.returnFullResponse,
			ignoreHttpStatusErrors: options.ignoreHttpStatusErrors,
		});
}

/**
 * Builds the API client for this invocation from the node's credential.
 *
 * The base URL falls back to the production default when the credential carries
 * a blank one. The credential declares that default and marks the field
 * required, so a blank value means someone cleared it — and a request composed
 * against an empty base would fail as an unreachable host, which reads as
 * "Factuarea is down" instead of "this credential has no address in it".
 */
async function clientFor(context: IHookFunctions): Promise<FactuareaApiClient> {
	const credential = await context.getCredentials<FactuareaCredential>(CREDENTIAL_NAME);

	return createFactuareaApiClient(requesterFor(context), {
		apiKey: asText(credential.apiKey) ?? '',
		baseUrl: asText(credential.baseUrl) ?? DEFAULT_API_BASE_URL,
	});
}

/**
 * A label for the destination, so the Factuarea dashboard shows which workflow
 * owns it instead of a list of identical URLs.
 *
 * Optional in every direction: n8n does not promise an id or a name, and the
 * API does not require a description. Nothing here fails when they are missing.
 */
function describeWorkflow(workflow: IWorkflowMetadata): string | undefined {
	const id = asText(workflow.id);
	const name = asText(workflow.name);

	if (id !== null && name !== null) {
		return `n8n workflow ${id} — ${name}`;
	}

	if (id !== null) {
		return `n8n workflow ${id}`;
	}

	if (name !== null) {
		return `n8n workflow: ${name}`;
	}

	return undefined;
}

/**
 * Is the destination this trigger registered still there AND still working?
 *
 * Two ways of answering "no", and both mean the same thing to n8n — create one:
 *
 *   1. No identifier in the node's static data. The trigger has never registered
 *      a destination, or the last deactivation cleared it.
 *   2. An identifier that the API answers `404` for. The destination was deleted
 *      from the Factuarea dashboard, through the API, or by another tool. The
 *      client reports that as `null` rather than throwing, because "it is gone"
 *      is a normal lifecycle answer.
 *
 * The stale pair is deliberately left in the static data in case 2. `create`
 * runs next and overwrites both keys together, so clearing them here would only
 * widen the window in which the node holds an id and no secret; and if `create`
 * fails, the workflow does not activate and nothing reads them.
 *
 * ## EXISTENCE IS NOT THE WHOLE QUESTION, AND ANSWERING `false` IS NOT THE FIX
 *
 * A destination reads back perfectly and still delivers nothing in two measured
 * cases, so both are checked and both THROW:
 *
 *   - Its `status` is not `active`. `DeliverWebhookCommandHandler` drops the
 *     delivery of an endpoint that is not active, and
 *     `OnWebhookDeliveryFailedDetectDegraded` moves one to `degraded` after 100
 *     permanent failures in 24 hours — exactly what a workflow that was offline
 *     for a day produces. A trigger that only asked "does it exist" would
 *     activate, report success and receive nothing, for ever.
 *   - Its `url` is not the address this workflow answers on now. The public URL
 *     of an n8n instance changes; the destination keeps the old one.
 *
 * They THROW rather than answering `false` because `false` means "not
 * registered", and n8n reacts to it by calling `create` WITHOUT calling
 * `delete`: the suspended or misaddressed destination would stay in Factuarea
 * for ever, unreachable by this node, counting against the account's limit, and
 * a few activations later the limit is what the user would hit instead. An error
 * names the cause and asks for the deactivate/activate cycle, which deletes the
 * old destination and registers a new one — the same two calls, in the order
 * that leaves nothing behind.
 *
 * A read whose `status` is absent is NOT treated as a fault. The field is part
 * of the measured contract, so its absence means the answer came from something
 * this node has not measured, and refusing to activate over a field that cannot
 * be read would turn one shape change at the API into every workflow failing to
 * start. The failure this guard prevents is bad; that one is worse.
 */
export async function checkWebhookExists(this: IHookFunctions): Promise<boolean> {
	const state = this.getWorkflowStaticData('node');
	const endpointId = asText(state[STATIC_DATA_ENDPOINT_ID]);

	if (endpointId === null) {
		return false;
	}

	const client = await clientFor(this);
	const endpoint = await client.getWebhookEndpoint(endpointId);

	if (endpoint === null) {
		return false;
	}

	const status = asText(endpoint.status);

	if (status !== null && status !== STATUS_ACTIVE) {
		throw new Error(ERROR_ENDPOINT_NOT_ACTIVE);
	}

	// Compared only when n8n has an address to compare against. `undefined` here
	// is not a mismatch — it is n8n declining to say — and `create` already
	// refuses that case with the catalogued URL message, so guessing at it here
	// would replace a precise failure with a wrong one.
	const url = this.getNodeWebhookUrl(WEBHOOK_NAME);

	if (url !== undefined && endpoint.url !== url) {
		throw new Error(ERROR_ENDPOINT_URL_MISMATCH);
	}

	return true;
}

/**
 * Registers a destination for this workflow and persists what it returns.
 *
 * The URL is checked against the scheme BEFORE the request goes out. Factuarea
 * refuses a non-HTTPS destination, so sending it would spend a round trip to be
 * told what is already known here — and the frozen message this throws is the
 * one the API's own rejection would have produced, so the user reads the same
 * cause and the same remedy either way. `getNodeWebhookUrl` returning
 * `undefined` is treated the same: there is no address to register at all, which
 * is the same dead end for the same reason.
 *
 * An EMPTY event selection is refused here for the same reason and with a
 * message of its own. `required: true` on the `events` property does not stop an
 * activation — measured, n8n activates a workflow whose multi-select is empty —
 * so without this guard the empty list reaches the API, whose rule for
 * `enabled_events` is `required|array|min:1`. The answer is a 422
 * `invalid_param_value`, and the client can translate that into the address
 * message (`param=url`) or into the generic one, which tells the user to check
 * an API key that is perfectly fine. The field to fix is in the editor, two
 * inches above the activation switch.
 *
 * Both values the creation returns are stored, and the secret is the one that
 * matters: this call is the ONLY place it is ever available. Losing it means
 * losing the ability to verify every delivery this destination will ever send.
 */
export async function createWebhookEndpoint(this: IHookFunctions): Promise<boolean> {
	const url = this.getNodeWebhookUrl(WEBHOOK_NAME);

	if (url === undefined || !HTTPS_SCHEME.test(url)) {
		throw new Error(ERROR_ENDPOINT_URL_NOT_ACCEPTED);
	}

	const events = asEventNames(this.getNodeParameter(PARAMETER_EVENTS));

	if (events.length === 0) {
		throw new Error(ERROR_NO_EVENTS_SELECTED);
	}

	const description = describeWorkflow(this.getWorkflow());
	const client = await clientFor(this);

	const endpoint = await client.createWebhookEndpoint({
		url,
		enabled_events: events,
		...(description === undefined ? {} : { description }),
	});

	const state = this.getWorkflowStaticData('node');

	state[STATIC_DATA_ENDPOINT_ID] = endpoint.id;
	state[STATIC_DATA_SECRET] = endpoint.secret;

	return true;
}

/**
 * Removes the destination and forgets it, so a later activation registers a new
 * one with a new secret.
 *
 * The static data is cleared only AFTER the deletion succeeds. Clearing it first
 * would, on a failed deletion, leave a live destination in Factuarea that keeps
 * delivering to a workflow which no longer knows its identifier — orphaned,
 * invisible to the node, and removable only by hand from the dashboard. Keeping
 * the identifier means a second deactivation can finish the job.
 *
 * A destination that is already gone is not a failure: the client resolves on
 * `404` because the end state is the one that was asked for.
 */
export async function deleteWebhookEndpoint(this: IHookFunctions): Promise<boolean> {
	const state = this.getWorkflowStaticData('node');
	const endpointId = asText(state[STATIC_DATA_ENDPOINT_ID]);

	if (endpointId !== null) {
		const client = await clientFor(this);

		await client.deleteWebhookEndpoint(endpointId);
	}

	delete state[STATIC_DATA_ENDPOINT_ID];
	delete state[STATIC_DATA_SECRET];

	return true;
}

/**
 * The three methods keyed by the names n8n calls them under.
 *
 * The node class assigns this straight to `webhookMethods.default`. It is
 * exported as one object rather than wired up there field by field so that the
 * mapping from n8n's names to this file's lives next to the implementations: a
 * `create` pointing at the deletion would be a working node that unregisters
 * itself on activation, and nothing about it would look wrong at the call site.
 */
export const factuareaWebhookMethods: Record<
	WebhookSetupMethodNames,
	(this: IHookFunctions) => Promise<boolean>
> = {
	checkExists: checkWebhookExists,
	create: createWebhookEndpoint,
	delete: deleteWebhookEndpoint,
};
