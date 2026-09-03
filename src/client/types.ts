/**
 * Response shapes of the Factuarea public API v1 that this node consumes, the
 * interface of the client that fetches them, and — below — the SIGNATURES THAT
 * THE REST OF THE PACKAGE IS NOT ALLOWED TO REINVENT.
 *
 * The response shapes were measured 2026-09-02 against:
 *   - `backend/app/Webhooks/Infrastructure/Http/Resource/V1/WebhookEndpointResource.php`
 *   - `backend/app/Webhooks/Infrastructure/Http/Resource/V1/WebhookEndpointWithSecretResource.php`
 *   - `backend/app/Webhooks/Application/Response/WebhookEndpointResponse.php` (nullability)
 *   - `backend/app/PublicApi/Infrastructure/Http/Controller/V1/ListEventCatalogController.php`
 *
 * ===========================================================================
 * FROZEN SIGNATURES — every module below is written by a different phase, in
 * parallel, and none of them can see the others while it is being written. What
 * is written here is what they compile against. Changing any of it means changing
 * it HERE FIRST and telling every phase that consumes it.
 * ===========================================================================
 *
 * ## `src/verify/parseSignatureHeader.ts`
 *
 *     export type SignatureHeaderFailureReason =
 *       | 'missing'            // the header was not present at all
 *       | 'empty'              // present but blank
 *       | 'malformed'          // no readable `key=value` pair
 *       | 'no_timestamp'       // readable pairs, but none of them is `t=`
 *       | 'invalid_timestamp'  // `t=` present but not a base-10 integer
 *       | 'no_signatures';     // no `v1=` pair at all
 *
 *     export type ParsedSignatureHeader =
 *       | { ok: true; timestamp: number; signatures: string[] }
 *       | { ok: false; reason: SignatureHeaderFailureReason };
 *
 *     export function parseSignatureHeader(
 *       header: string | undefined,
 *     ): ParsedSignatureHeader;
 *
 * `signatures` holds EVERY `v1=` value in order of appearance, unfiltered — the
 * length filter belongs to the verifier, not to the parser. Unknown pairs are
 * ignored rather than rejected, so a header carrying a field this version does
 * not know still parses. The parameter is widened to `string | undefined` on
 * purpose: an absent header is one of the enumerated failure cases, so it must
 * arrive as a value the function can classify instead of forcing every caller to
 * guard first. This function NEVER throws.
 *
 * ## `src/verify/verifySignature.ts`
 *
 *     export type SignatureVerification =
 *       | { ok: true; timestamp: number; signatures: string[] }
 *       | { ok: false; reason: SignatureHeaderFailureReason | 'no_candidates' | 'no_match' };
 *
 *     export function verifySignature(
 *       rawBody: string | Buffer,
 *       header: string | undefined,
 *       secret: string,
 *     ): SignatureVerification;
 *
 * It takes the RAW header string and parses it itself, by importing
 * `parseSignatureHeader`. That re-parses a header the trigger has usually parsed
 * already, and that is accepted: it keeps the verifier usable on its own — which
 * is what makes the golden-vector test possible — for the cost of splitting a
 * short string twice.
 *
 * `no_candidates` means every `v1=` was discarded by the length filter;
 * `no_match` means candidates of the right length were compared and none matched.
 * The two are distinct because they have different causes: the first points at a
 * malformed or future header format, the second at a wrong secret.
 *
 * `rawBody` is the bytes as they arrived: the `Buffer` itself, or a string
 * holding them. A caller that has the buffer passes the buffer — the string
 * route decodes and re-encodes, which is exact for this emitter's output and
 * only for it. Re-serialising a parsed object into this argument is prohibited
 * either way — see `src/contract.ts`.
 *
 * ## `src/verify/timestampTolerance.ts`
 *
 *     export function isWithinTolerance(
 *       timestamp: number,
 *       now: number,
 *       toleranceSeconds: number,
 *     ): boolean;
 *
 * All three arguments are in SECONDS, never milliseconds; `now` is injected so the
 * function stays pure and testable. The check is `Math.abs(now - timestamp) <=
 * toleranceSeconds`, inclusive at both edges, and bidirectional.
 *
 * ## `src/dedupe/eventDeduplicator.ts`
 *
 *     export interface DeduplicationState { seenEventIds?: string[] }
 *
 *     export interface EventDeduplicator {
 *       hasSeen(state: DeduplicationState, eventId: string): boolean;
 *       markSeen(state: DeduplicationState, eventId: string): void;
 *     }
 *
 *     export function createEventDeduplicator(
 *       capacity?: number,   // defaults to DEDUPE_CAPACITY from src/contract.ts
 *     ): EventDeduplicator;
 *
 * `state` is the flat object n8n persists per node; both operations MUTATE it in
 * place, which is why `markSeen` returns nothing. `seenEventIds` is optional so a
 * never-used node whose state is `{}` works without seeding. Oldest ids are
 * evicted first once `capacity` is exceeded.
 *
 * ## `src/client/factuareaApiClient.ts`
 *
 *     export function createFactuareaApiClient(
 *       request: FactuareaHttpRequester,
 *       options: FactuareaApiClientOptions,
 *     ): FactuareaApiClient;
 *
 * `request` is the HTTP helper n8n injects (`this.helpers.httpRequest`), passed in
 * rather than imported so the client has no dependency and the tests can hand it a
 * double. `FactuareaApiClient` is declared as a real type at the bottom of this
 * file, so it is the compiler and not this comment that keeps the four operations
 * honest.
 *
 * ## `src/nodes/FactuareaTrigger/properties.ts`
 *
 *     export const factuareaTriggerProperties: INodeProperties[];
 *
 * Exactly three properties, whose parameter names the trigger reads back and
 * therefore cannot be renamed by one side alone:
 *
 *     'events'            multi-select, string[]  — subscribed event names
 *     'toleranceSeconds'  number, default DEFAULT_TOLERANCE_SECONDS,
 *                         min MIN_TOLERANCE_SECONDS, max MAX_TOLERANCE_SECONDS
 *     'deduplicate'       boolean, default true
 *
 * The `events` property loads its options dynamically through the load-options
 * method named `getEventTypes`. That STRING is the contract between the property
 * declaration and the node class that registers the method: the two are written by
 * different phases and a typo in either silently produces an empty picker.
 *
 * ## `src/nodes/FactuareaTrigger/loadEventOptions.ts`
 *
 *     export async function loadEventOptions(
 *       this: ILoadOptionsFunctions,
 *     ): Promise<INodePropertyOptions[]>;
 *
 * Registered by the node class as `methods.loadOptions.getEventTypes`.
 *
 * ## `src/nodes/FactuareaTrigger/webhookLifecycle.ts`
 *
 *     export async function checkWebhookExists(this: IHookFunctions): Promise<boolean>;
 *     export async function createWebhookEndpoint(this: IHookFunctions): Promise<boolean>;
 *     export async function deleteWebhookEndpoint(this: IHookFunctions): Promise<boolean>;
 *
 * They read and write the node's own static data under these two keys, frozen
 * because the lifecycle writes them and the request handler reads them:
 *
 *     'webhookEndpointId'  string — uuid of the destination this trigger owns
 *     'webhookSecret'      string — the plaintext secret, returned only at creation
 */

/** Key under which the trigger stores the uuid of the destination it owns. */
export const STATIC_DATA_ENDPOINT_ID = 'webhookEndpointId';

/** Key under which the trigger stores the plaintext signing secret. */
export const STATIC_DATA_SECRET = 'webhookSecret';

/** Name of the load-options method that fills the event picker. */
export const LOAD_OPTIONS_METHOD_EVENT_TYPES = 'getEventTypes';

/**
 * A webhook destination as the v1 API returns it on read.
 *
 * Eighteen top-level keys. `secret` is NEVER among them: the plaintext secret is
 * returned exactly once, by the creation call, and there is no way to read it
 * back afterwards. That single fact is why this trigger owns its destination and
 * never adopts one it did not create.
 */
export interface WebhookEndpointV1 {
	/** UUID v7 of the destination. */
	id: string;
	object: 'webhook_endpoint';
	url: string;
	description: string | null;
	enabled_events: string[];
	/** Observed values: `active`, `disabled`, `degraded`. */
	status: string;
	ip_allowlist: string[] | null;
	delivery_success_rate_24h: number | null;
	last_delivery_at: string | null;
	last_failure_at: string | null;
	/** While set and in the future, deliveries carry TWO `v1=` signatures. */
	previous_secret_valid_until: string | null;
	created_at: string;
	updated_at: string;
	api_version: string | null;
	/** Serialised as `{}` when empty, never as `[]`. */
	metadata: Record<string, unknown>;
	/** Serialised as `{}` when empty, never as `[]`. */
	custom_headers: Record<string, unknown>;
	timeout_seconds: number;
	degraded_since: string | null;
}

/**
 * The creation response: the same eighteen keys plus the plaintext secret.
 *
 * Returned by `POST /v1/webhook_endpoints` and by the rotate-secret call, and by
 * nothing else. Whatever reads this MUST persist `secret` immediately; there is
 * no second chance to obtain it.
 */
export interface WebhookEndpointWithSecretV1 extends WebhookEndpointV1 {
	secret: string;
}

/**
 * One entry of the public event catalogue, from `GET /v1/event-catalog`.
 *
 * `status` is what makes the live catalogue worth reading: an entry marked
 * `coming_soon` is announced but not yet emitted, and subscribing to it is
 * rejected with 422 by the creation call. Only `available` entries may be
 * offered in the picker.
 *
 * `description` is written in Spanish by the API. It is API data displayed as a
 * hint, not a string this package authors, so the English-only gate has nothing
 * to say about it — but nothing here may copy it into a package-authored message.
 */
export interface EventCatalogEntryV1 {
	name: string;
	category: string;
	description: string;
	status: 'available' | 'coming_soon';
}

/** Body of `POST /v1/webhook_endpoints`, restricted to what this node sends. */
export interface CreateWebhookEndpointInput {
	/** Must be `https://` and resolve on the public internet. */
	url: string;
	/** Event names, all of which must be `available` in the catalogue. */
	enabled_events: string[];
	/** Optional label shown in the Factuarea dashboard. */
	description?: string;
}

/** The subset of n8n's HTTP request options this client uses. */
export interface FactuareaHttpRequestOptions {
	method: 'GET' | 'POST' | 'DELETE';
	url: string;
	headers: Record<string, string>;
	body?: unknown;
	json: boolean;
	/** Ask the helper for the status code instead of throwing on 4xx. */
	returnFullResponse?: boolean;
	ignoreHttpStatusErrors?: boolean;
}

/**
 * The HTTP helper n8n injects, narrowed to what this client needs.
 *
 * Injected rather than imported: the package declares no runtime dependency, and
 * a double satisfies this type in tests without a mocking library.
 */
export type FactuareaHttpRequester = (
	options: FactuareaHttpRequestOptions,
) => Promise<unknown>;

/** What the client needs to address the API and authenticate. */
export interface FactuareaApiClientOptions {
	/** Base URL including the version segment, e.g. `https://api.factuarea.com/v1`. */
	baseUrl: string;
	/** Sent as `Authorization: Bearer <apiKey>`, which the API prefers over `X-API-Key`. */
	apiKey: string;
}

/**
 * The four operations this node performs against Factuarea. Nothing else.
 *
 * There is deliberately no update and no rotate-secret operation: the trigger
 * creates a destination on activation and deletes it on deactivation, and a
 * rotation it did not perform is unrecoverable for it by design (see
 * `ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE`).
 */
export interface FactuareaApiClient {
	/**
	 * `POST /v1/webhook_endpoints` — scope `webhooks:write`.
	 *
	 * Resolves with the destination INCLUDING its plaintext secret, which the
	 * caller must persist at once.
	 */
	createWebhookEndpoint(
		input: CreateWebhookEndpointInput,
	): Promise<WebhookEndpointWithSecretV1>;

	/**
	 * `GET /v1/webhook_endpoints/{id}` — scope `webhooks:read`.
	 *
	 * Resolves with `null` when the destination is gone (HTTP 404) rather than
	 * rejecting: "it no longer exists" is a normal lifecycle answer, and the
	 * trigger reacts to it by creating a new destination.
	 */
	getWebhookEndpoint(id: string): Promise<WebhookEndpointV1 | null>;

	/**
	 * `DELETE /v1/webhook_endpoints/{id}` — scope `webhooks:delete`.
	 *
	 * Resolves normally when the destination was already gone: deactivating a
	 * workflow twice is not an error the user should have to see.
	 */
	deleteWebhookEndpoint(id: string): Promise<void>;

	/**
	 * `GET /v1/event-catalog` — scope `events:read`.
	 *
	 * Resolves with the entries the catalogue declares `available`, filtered by
	 * the client. Rejects with `ERROR_EVENT_CATALOG_UNAVAILABLE` rather than
	 * falling back to a hand-written list.
	 */
	listEventCatalog(): Promise<EventCatalogEntryV1[]>;
}
