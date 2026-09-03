/**
 * The Factuarea trigger: the single node this package publishes.
 *
 * It registers a webhook destination in Factuarea when the workflow is
 * activated, verifies every delivery that arrives at it, and turns the ones it
 * can prove came from Factuarea — unmodified, recently, and for the first time —
 * into a workflow item.
 *
 * ## Why this node is PROGRAMMATIC and not declarative
 *
 * n8n's declarative style describes outgoing HTTP calls. It has no way to
 * express receiving one, and no way to run code when a workflow is activated or
 * deactivated. This trigger has to do all three: register its destination on
 * activation, remove it on deactivation, and verify what arrives in between.
 * n8n's own verification requires the programmatic style for trigger nodes.
 *
 * ## What this file owns, and what it deliberately does not
 *
 * Everything here is WIRING and ORDER. The parameters come from `properties.ts`,
 * the event picker from `loadEventOptions.ts`, the activation and deactivation
 * from `webhookLifecycle.ts`, and the three security decisions from
 * `src/verify/` and `src/dedupe/`. This file decides which of them runs, in what
 * order, and what each outcome answers on the wire — and nothing else. That is
 * why the order below carries the longest comment in the package: it is the one
 * decision no other module can state, because no other module can see two steps
 * at once.
 */

import type { IncomingHttpHeaders } from 'node:http';

import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	WebhookSetupMethodNames,
} from 'n8n-workflow';

import { LOAD_OPTIONS_METHOD_EVENT_TYPES, STATIC_DATA_SECRET } from '../../client/types';
import { DEFAULT_TOLERANCE_SECONDS, DELIVERY_HEADER_LOOKUP } from '../../contract';
import { createEventDeduplicator } from '../../dedupe/eventDeduplicator';
import type { DeduplicationState } from '../../dedupe/eventDeduplicator';
import {
	ERROR_RAW_BODY_UNAVAILABLE,
	ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE,
} from '../../errors';
import { parseSignatureHeader } from '../../verify/parseSignatureHeader';
import { isWithinTolerance } from '../../verify/timestampTolerance';
import { verifySignature } from '../../verify/verifySignature';
import { loadEventOptions } from './loadEventOptions';
import { factuareaTriggerProperties } from './properties';
import { factuareaWebhookMethods } from './webhookLifecycle';

/** Credential type this node authenticates with; the `name` of `FactuareaApi`. */
const CREDENTIAL_NAME = 'factuareaApi';

/** The node's single webhook. `webhookLifecycle.ts` asks n8n for this URL. */
const WEBHOOK_NAME = 'default';

/** Parameter names, frozen in `src/client/types.ts` alongside `properties.ts`. */
const PARAMETER_TOLERANCE = 'toleranceSeconds';
const PARAMETER_DEDUPLICATE = 'deduplicate';

/**
 * The two status codes this node sends itself.
 *
 * Both are chosen by how the EMITTER reads them, not by what they mean in the
 * abstract. Factuarea marks a 4xx response as a permanent failure and stops
 * retrying, and retries a 5xx with exponential back-off:
 *
 *   401  a delivery this node refuses — bad header, stale timestamp, signature
 *        that does not match. None of those becomes true on a second attempt, so
 *        a permanent failure is exactly the right answer: retrying would burn
 *        the emitter's schedule on a delivery that can never be accepted.
 *   200  a duplicate this node drops. Success on purpose: answering an already
 *        processed event with an error would make the emitter retry it, over and
 *        over, for an event the workflow already handled.
 *
 * An internal failure — the raw body missing, the API unreachable — is THROWN
 * rather than answered here, so it surfaces as a 5xx and the emitter retries it.
 * That is the one class of failure where a later attempt can genuinely succeed.
 */
const STATUS_UNAUTHORISED = 401;
const STATUS_DUPLICATE_ACCEPTED = 200;

/**
 * The single member of the incoming request this node reads.
 *
 * `n8n-workflow` augments `http.IncomingMessage` with a NON-optional
 * `rawBody: Buffer`, and `@types/express` is not a dependency of this package,
 * so `getRequestObject()` resolves to `any` here: the compiler would accept
 * `request.rawbody`, or any other typo, without a word. Narrowing through this
 * type and an explicit runtime check is what replaces the guarantee the types
 * appear to give and do not — the declaration promises bytes unconditionally,
 * the runtime only supplies them when the request actually carried them.
 */
interface RawBodyCarrier {
	rawBody?: unknown;
}

/**
 * One header value, or `undefined`.
 *
 * Node joins repeated headers into a single comma-separated string for
 * everything except `set-cookie`, so the array branch is defensive rather than
 * expected. It takes the first entry: a second `Factuarea-Signature` is an
 * injected one, and joining them would build a header nobody sent.
 */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
	const value = headers[name];

	if (typeof value === 'string') {
		return value;
	}

	return Array.isArray(value) ? value[0] : undefined;
}

/**
 * The bytes exactly as they arrived, or a loud failure.
 *
 * A value that is not a Buffer is treated as absent ON PURPOSE, rather than
 * coerced into a string. The measured contract is a Buffer; anything else means
 * this node is running in a shape nobody has measured, and guessing at it is how
 * a verifier ends up hashing bytes that are not the ones that were signed.
 *
 * Reconstructing the body by re-serialising the parsed object is prohibited —
 * see `src/contract.ts`. It changes separators and escaping, so every legitimate
 * delivery would fail verification and the node would reject 100% of traffic
 * with nothing in the message to explain why.
 *
 * The Buffer is handed on AS a Buffer. `verifySignature` accepts either and
 * hashes a buffer byte for byte, so decoding here and letting it encode again
 * would put a UTF-8 round trip between the bytes that were signed and the bytes
 * that get hashed — exact for this emitter's output and for nothing else. There
 * is nothing to gain from taking that dependency when the bytes are in hand.
 */
function rawBodyOf(context: IWebhookFunctions): Buffer {
	const request = context.getRequestObject() as unknown as RawBodyCarrier;
	const rawBody = request.rawBody;

	if (!Buffer.isBuffer(rawBody)) {
		throw new Error(ERROR_RAW_BODY_UNAVAILABLE);
	}

	return rawBody;
}

/**
 * The configured tolerance, in seconds.
 *
 * A value that is not a finite number means the parameter is absent or an
 * expression did not resolve. Falling back to the declared default is better
 * than forwarding the garbage: `isWithinTolerance` would reject every delivery,
 * and the symptom would be indistinguishable from a wrong secret.
 */
function toleranceSecondsOf(context: IWebhookFunctions): number {
	const value = context.getNodeParameter(PARAMETER_TOLERANCE, DEFAULT_TOLERANCE_SECONDS);

	return typeof value === 'number' && Number.isFinite(value)
		? value
		: DEFAULT_TOLERANCE_SECONDS;
}

/**
 * Whether repeated events are dropped.
 *
 * Defaults to enabled, which is the safe direction: dropping a repeat can at
 * worst skip work already done, while processing one runs a workflow's effects a
 * second time.
 */
function deduplicationEnabled(context: IWebhookFunctions): boolean {
	const value = context.getNodeParameter(PARAMETER_DEDUPLICATE, true);

	return typeof value === 'boolean' ? value : true;
}

/**
 * The signing secret this node stored when it created its destination.
 *
 * An empty string when there is none — the destination was never created, or the
 * static data was lost. `verifySignature` rejects an empty secret with an
 * explicit guard, so this path ends in a 401 rather than in a comparison against
 * an HMAC keyed with nothing.
 */
function storedSecret(context: IWebhookFunctions): string {
	const stored = context.getWorkflowStaticData('node')[STATIC_DATA_SECRET];

	return typeof stored === 'string' ? stored : '';
}

/**
 * Refuse a delivery: HTTP 401, empty body, no item.
 *
 * `IWebhookResponseData` carries NO status field — measured, it is exactly
 * `{ workflowData?, webhookResponse?, noWebhookResponse? }` — so a node that
 * needs to state its own code has to write the response itself and tell n8n not
 * to send one. That is what `noWebhookResponse: true` means, and it is the same
 * mechanism n8n's own Webhook node uses to answer a failed authentication.
 *
 * The body is EMPTY deliberately, and so is the silence about WHICH check
 * refused: `src/errors.ts` prohibits handing anyone the expected signature or
 * anything derived from the secret, and an unauthenticated caller is precisely
 * who must learn nothing. Telling a forger that the timestamp was accepted but
 * the digest was not turns each rejection into a free oracle.
 */
function refuseDelivery(context: IWebhookFunctions): IWebhookResponseData {
	context.getResponseObject().status(STATUS_UNAUTHORISED).end();

	return { noWebhookResponse: true };
}

/**
 * Accept and drop a repeat: HTTP 200, empty body, no item.
 *
 * Same mechanism as the refusal above, opposite meaning. The emitter reads the
 * 200 as delivered and stops retrying, which is the whole point: an error here
 * would buy more copies of an event that has already been handled.
 */
function acknowledgeDuplicate(context: IWebhookFunctions): IWebhookResponseData {
	context.getResponseObject().status(STATUS_DUPLICATE_ACCEPTED).end();

	return { noWebhookResponse: true };
}

export class FactuareaTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Factuarea Trigger',
		name: 'factuareaTrigger',
		icon: 'file:factuarea.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '=Events: {{ $parameter["events"].join(", ") }}',
		description: 'Starts the workflow when Factuarea delivers a signed webhook event',
		defaults: {
			name: 'Factuarea Trigger',
		},
		// A trigger has no input: nothing in the workflow runs before it.
		inputs: [],
		outputs: ['main'],
		credentials: [
			{
				name: CREDENTIAL_NAME,
				required: true,
			},
		],
		webhooks: [
			{
				name: WEBHOOK_NAME,
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'factuarea',
				// Asks n8n to keep the bytes of the request as they arrived, which
				// is the only thing this node can verify a signature against.
				//
				// Measured: `IWebhookDescription` declares no `rawBody` field, but
				// its index signature accepts a boolean, so the flag type-checks
				// and travels to n8n untouched. Because the type system therefore
				// says nothing about whether the flag was honoured, the ARRIVAL of
				// the bytes is checked at runtime in `rawBodyOf` — the declaration
				// asks, the check confirms, and a runtime that ignores the request
				// produces the catalogued error instead of a silent reserialisation.
				rawBody: true,
			},
		],
		properties: factuareaTriggerProperties,
	};

	/**
	 * Fills the event picker from the live catalogue.
	 *
	 * The key is the frozen constant rather than the literal `'getEventTypes'`:
	 * `properties.ts` declares `loadOptionsMethod` from the same constant, and a
	 * typo in either of the two would produce an empty picker and no error at all.
	 */
	methods = {
		loadOptions: {
			[LOAD_OPTIONS_METHOD_EVENT_TYPES]: loadEventOptions,
		},
	};

	/**
	 * Activation and deactivation, keyed by the webhook they belong to.
	 *
	 * The three functions are taken as one object from `webhookLifecycle.ts`, so
	 * the mapping from n8n's names to the implementations lives next to them: a
	 * `create` pointing at the deletion would be a node that unregisters itself on
	 * activation, and nothing at this call site would look wrong.
	 */
	webhookMethods: Record<
		typeof WEBHOOK_NAME,
		Record<WebhookSetupMethodNames, (this: IHookFunctions) => Promise<boolean>>
	> = {
		default: factuareaWebhookMethods,
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		// The raw bytes come first because nothing below can be checked without
		// them. This failure is THROWN rather than answered with a status: it is a
		// misconfiguration of this installation — a proxy rewriting bodies — and
		// not a bad delivery, so it belongs to the 5xx class the emitter retries.
		// The event then survives long enough for an operator to fix the proxy,
		// which a permanent 4xx would not allow.
		const rawBody = rawBodyOf(this);

		const headers = this.getHeaderData();
		const signatureHeader = headerValue(headers, DELIVERY_HEADER_LOOKUP.signature);

		// ORDER OF THE FOUR CHECKS. Each one is where it is for a reason, and two
		// of those reasons are the whole security argument of this node.
		//
		// TOLERANCE BEFORE THE HMAC. A replayed delivery carries its original,
		// perfectly valid signature: verifying it succeeds, because the bytes were
		// genuinely signed by Factuarea — just not recently. The signature cannot
		// tell a replay from a first arrival; only the timestamp can. Running the
		// cheap integer comparison first also means a flood of replays is discarded
		// without computing one HMAC, so an attacker cannot turn captured traffic
		// into cryptographic work on this instance.
		//
		// DEDUPLICATION AFTER THE SIGNATURE. The id it remembers is read out of the
		// body, and an unverified body is whatever the caller typed. Deduplicating
		// first would let anyone POST an unsigned body carrying the id of an event
		// they want suppressed; the genuine delivery of that event would arrive
		// later, be found in the memory, and be dropped as a duplicate. That is a
		// denial of service requiring no secret, no signature and leaving no trace
		// beyond a 200. Verifying first means only Factuarea can write to that
		// memory.
		const parsed = parseSignatureHeader(signatureHeader);

		if (!parsed.ok) {
			return refuseDelivery(this);
		}

		const now = Math.floor(Date.now() / 1000);

		if (!isWithinTolerance(parsed.timestamp, now, toleranceSecondsOf(this))) {
			return refuseDelivery(this);
		}

		const verification = verifySignature(rawBody, signatureHeader, storedSecret(this));

		if (!verification.ok) {
			// The WIRE answer is the same for every rejection — 401, empty body,
			// no hint about which check refused — and that does not change here.
			// What changes is the OPERATOR's side of it. `no_match` is reachable
			// only past the tolerance check above, so it means exactly what
			// `ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE` describes: candidates of
			// the right length were compared against a recent timestamp and none
			// matched, which is the shape of a secret rotated outside n8n (or of a
			// node holding no secret at all — the remedy, re-activating, is the
			// same one). Without this line that message was written, documented in
			// three docblocks and in `docs/LIMITATIONS.md`, and reachable by
			// nobody: the whole verification result was discarded and the user got
			// a silent 401 with no entry anywhere explaining it.
			//
			// It goes to the LOG and never to the response, because the response is
			// read by an unauthenticated caller and the log is read by the person
			// who owns the workflow. Telling a forger that the timestamp was
			// accepted but the digest was not turns each rejection into an oracle;
			// telling the owner the same thing is the difference between a fixable
			// problem and an invisible one. Every other reason stays silent: a
			// header that cannot be parsed is a probe or a proxy, not a rotation,
			// and logging it would let anyone fill the log by POSTing garbage.
			if (verification.reason === 'no_match') {
				this.logger.warn(ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE);
			}

			return refuseDelivery(this);
		}

		// Past this line the body is proven to be Factuarea's, unmodified and
		// recent. Everything below reads it as trusted input.
		const body = this.getBodyData();

		if (deduplicationEnabled(this)) {
			// The key is the event id from the BODY, which is inside the signed
			// material, and never the `Factuarea-Event-Id` header, which is not:
			// a header is free to change without invalidating anything, so keying
			// the memory on one would let an attacker who cannot forge a body still
			// steer which events get suppressed.
			const eventId = typeof body['id'] === 'string' ? body['id'] : null;

			if (eventId !== null) {
				const state = this.getWorkflowStaticData('node') as DeduplicationState;
				const deduplicator = createEventDeduplicator();

				if (deduplicator.hasSeen(state, eventId)) {
					return acknowledgeDuplicate(this);
				}

				// Recorded on ACCEPTANCE, not on the workflow finishing. With
				// `responseMode: 'onReceived'` the response is sent before the
				// workflow runs, so its outcome is not knowable here; acceptance is
				// the only moment this node has. A verified event whose body carries
				// no usable id is processed WITHOUT being remembered rather than
				// dropped: never losing a real event matters more than the repeat
				// this cannot recognise.
				deduplicator.markSeen(state, eventId);
			}
		}

		// The item is the event body verbatim — no key renamed, flattened or
		// dropped, because a workflow is built on those keys — plus exactly one
		// field of this node's own. `delivery_id` is added AFTER the spread so its
		// name is unambiguous, and it is `null` rather than absent when the header
		// is missing: a key that sometimes disappears breaks every expression that
		// reads it, while a null is a value a workflow can test.
		//
		// It comes from a header that is NOT part of the signed material, and that
		// is acceptable precisely because nothing decides anything with it: it is
		// metadata a workflow reads to tell a retry from a new event without
		// inspecting the body — `id` is stable across retries, `delivery_id` is not.
		const item: IDataObject = {
			...body,
			delivery_id: headerValue(headers, DELIVERY_HEADER_LOOKUP.deliveryId) ?? null,
		};

		return { workflowData: [this.helpers.returnJsonArray([item])] };
	}
}
