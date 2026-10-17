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
 * THE COMPANY TRAVELS PER CALL, NOT IN THE OPTIONS. The three webhook-endpoint
 * operations take the company uuid as their FIRST argument, because the fourth
 * operation — the event catalogue — hangs from the root of the version and must
 * not gain a company segment. Putting the company in
 * `FactuareaApiClientOptions` would make one client instance mean two different
 * addressing rules, and the catalogue is the one that would break.
 *
 * ## `src/nodes/FactuareaTrigger/properties.ts`
 *
 *     export const factuareaTriggerProperties: INodeProperties[];
 *
 * Exactly four properties, whose parameter names the trigger reads back and
 * therefore cannot be renamed by one side alone:
 *
 *     'companyId'         string, required     — uuid of the company whose
 *                         webhook destinations this trigger manages, exported
 *                         below as PARAMETER_COMPANY_ID
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
 *
 * All three read the company uuid with `getNodeParameter(PARAMETER_COMPANY_ID)`
 * and hand it to the client, so every webhook-endpoint request they build
 * carries the company segment. None of them falls back to letting the API pick
 * a company.
 */

/** Key under which the trigger stores the uuid of the destination it owns. */
export const STATIC_DATA_ENDPOINT_ID = 'webhookEndpointId';

/** Key under which the trigger stores the plaintext signing secret. */
export const STATIC_DATA_SECRET = 'webhookSecret';

/** Name of the load-options method that fills the event picker. */
export const LOAD_OPTIONS_METHOD_EVENT_TYPES = 'getEventTypes';

/**
 * Name of the node parameter holding the company uuid.
 *
 * Frozen here rather than written twice because `properties.ts` declares the
 * parameter and `webhookLifecycle.ts` reads it back, and the two are written by
 * different phases: a typo on either side would produce a trigger that reads
 * `undefined`, refuses to activate, and blames a field that is filled in.
 *
 * The value is the company UUID, never a tax id: the public API matches this
 * path segment with `whereUuid('company')`.
 */
export const PARAMETER_COMPANY_ID = 'companyId';

/**
 * Name of the credential field holding the fallback company uuid.
 *
 * The credential carries a company so an account that works with a single
 * company fills it once instead of once per workflow. It is a value the
 * integrator TYPES, never one derived from whoever owns the key: the resolution
 * this package refuses is the old one, where a path without a company segment
 * let the API choose on its own.
 */
export const CREDENTIAL_FIELD_COMPANY_ID = 'companyId';

/*
 * ===========================================================================
 * ACCOUNT MODE — frozen contracts (change `account-tenancy-sibling-repos`, D9).
 *
 * The trigger gains a second mode of the SAME node: it can listen to the events
 * of a whole account instead of one company. The package still declares one
 * node and one credential, so the mode is a parameter, and `company` stays the
 * default so a workflow saved before this existed behaves exactly as it did.
 *
 * Field names below are the ones of the frozen OpenAPI document (`AccountWebhook`,
 * `AccountWebhookWithSecret`, `CreateAccountWebhookV1Request`) and of the account
 * envelope emitted by `AccountWebhookEnvelopeFactory.php:66-79`.
 * ===========================================================================
 */

/** Name of the node parameter that selects the mode. */
export const PARAMETER_LISTEN_ON = 'listenOn';

/** What the trigger listens to: one company, or a whole account. */
export type ListenOn = 'company' | 'account';

/** The mode of a workflow that has no `listenOn` parameter saved. */
export const LISTEN_ON_DEFAULT: ListenOn = 'company';

/** Name of the node parameter holding the account uuid. */
export const PARAMETER_ACCOUNT_ID = 'accountId';

/**
 * Name of the credential field holding the fallback account uuid.
 *
 * Typed by the integrator, never derived from whoever owns the key.
 */
export const CREDENTIAL_FIELD_ACCOUNT_ID = 'accountId';

/** Name of the node parameter holding the relationship filter. */
export const PARAMETER_ACCOUNT_RELATIONSHIP = 'accountRelationship';

/**
 * Which tax ids an account endpoint covers: `own` (the account's own), `managed`
 * (the accounts it manages) or `all`. An EVENT envelope only ever carries `own`
 * or `managed`, never `all`.
 */
export type AccountRelationshipFilter = 'own' | 'managed' | 'all';

/** Name of the node parameter that narrows account mode to one company. */
export const PARAMETER_COMPANY_FILTER = 'companyFilter';

/** Static-data key: the mode the endpoint was created under. */
export const STATIC_DATA_LISTEN_ON = 'webhookListenOn';

/** Static-data key: the account the endpoint was created under. */
export const STATIC_DATA_ACCOUNT_ID = 'webhookAccountId';

/**
 * Static-data key: the company a COMPANY endpoint was created under.
 *
 * n8n discards the parameters that a `displayOptions` rule hides, so a workflow
 * switched from Company to Account mode loses its `companyId` parameter. The
 * check and the deletion prefer this stored value, falling back to the node and
 * the credential only for endpoints saved before the key existed.
 */
export const STATIC_DATA_COMPANY_ID = 'webhookCompanyId';

/**
 * An account webhook endpoint as the v1 API returns it on read
 * (`AccountWebhook`; every key is always present).
 *
 * `secret` is NEVER among them: it is returned once, by the creation call.
 */
export interface AccountWebhookEndpointV1 {
	/** UUID v7; the `{webhook}` segment of the routes. */
	id: string;
	object: 'account_webhook';
	environment: 'live' | 'test';
	url: string;
	enabled_events: string[];
	account_relationship: AccountRelationshipFilter;
	status: 'active' | 'disabled';
	/** `null` while active; the only value today is `creator_lost_capability`. */
	disabled_reason: 'creator_lost_capability' | null;
	/** `YYYY-MM-DD`, or `null`. */
	api_version: string | null;
	description: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * The creation response: the same keys plus the plaintext secret.
 *
 * `secret` is `null` only on an idempotent replay, because the secret is never
 * stored. Whatever reads this MUST persist `secret` at once.
 */
export interface AccountWebhookEndpointWithSecretV1 extends AccountWebhookEndpointV1 {
	secret: string | null;
}

/**
 * Body of `POST /v1/accounts/{account}/webhooks`, restricted to what this node
 * sends. The account is a segment of the path, not a field of the body.
 */
export interface CreateAccountWebhookEndpointBody {
	/** Must be `https://`. */
	url: string;
	/** Company events that are `available` plus the `account.*` events. */
	enabled_events: string[];
	account_relationship: AccountRelationshipFilter;
	description?: string;
}

/**
 * The three keys an account delivery adds to the envelope of a company delivery.
 *
 * `company_id` is `null` in an `account.*` event that is not about a tax id.
 */
export interface AccountEnvelopeFields {
	account: { id: string };
	account_relationship: 'own' | 'managed';
	company_id: string | null;
}

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
 * Returned by `POST /v1/companies/{company}/webhook-endpoints` and by the
 * rotate-secret call, and by nothing else. Whatever reads this MUST persist `secret` immediately; there is
 * no second chance to obtain it.
 */
export interface WebhookEndpointWithSecretV1 extends WebhookEndpointV1 {
	secret: string;
}

/**
 * One entry of the public event catalogue, from `GET /v1/event-catalog`.
 *
 * That path is the ROOT of the version and carries NO company segment, and it
 * is the one route of this package that must never gain one: the catalogue
 * enumerates what the product can emit, which is the same list for every
 * company. Prefixing it would turn a working call into a 404.
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

/**
 * Body of `POST /v1/companies/{company}/webhook-endpoints`, restricted to what
 * this node sends. The company is NOT a field of the body: it is a segment of
 * the path, and the client takes it as an argument of its own.
 */
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
	/**
	 * Base URL including the version segment, e.g. `https://api.factuarea.com/v1`.
	 *
	 * It stops at the version and NEVER carries a company segment. The event
	 * catalogue hangs from this same base with no prefix, so a base ending in
	 * `/companies/<uuid>` would break the catalogue while fixing nothing: the
	 * company belongs to the three webhook-endpoint calls, which take it as an
	 * argument.
	 */
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
	 * `POST /v1/companies/{company}/webhook-endpoints` — scope `webhooks:write`.
	 *
	 * `companyId` is the uuid that fills the `{company}` segment. It is the first
	 * argument, and not part of `input`, because it addresses the request rather
	 * than describing the destination.
	 *
	 * Resolves with the destination INCLUDING its plaintext secret, which the
	 * caller must persist at once.
	 */
	createWebhookEndpoint(
		companyId: string,
		input: CreateWebhookEndpointInput,
	): Promise<WebhookEndpointWithSecretV1>;

	/**
	 * `GET /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}` — scope
	 * `webhooks:read`.
	 *
	 * Resolves with `null` when the destination is gone (HTTP 404) rather than
	 * rejecting: "it no longer exists" is a normal lifecycle answer, and the
	 * trigger reacts to it by creating a new destination. A destination that
	 * belongs to a different company answers 404 too, which is the same
	 * lifecycle answer and the same reaction.
	 */
	getWebhookEndpoint(companyId: string, id: string): Promise<WebhookEndpointV1 | null>;

	/**
	 * `DELETE /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}` —
	 * scope `webhooks:delete`.
	 *
	 * Resolves normally when the destination was already gone: deactivating a
	 * workflow twice is not an error the user should have to see.
	 */
	deleteWebhookEndpoint(companyId: string, id: string): Promise<void>;

	/**
	 * `GET /v1/event-catalog` — scope `events:read`. ROOT, no company segment,
	 * and no `companyId` argument: see `EventCatalogEntryV1` above.
	 *
	 * Resolves with the entries the catalogue declares `available`, filtered by
	 * the client. Rejects with `ERROR_EVENT_CATALOG_UNAVAILABLE` rather than
	 * falling back to a hand-written list.
	 */
	listEventCatalog(): Promise<EventCatalogEntryV1[]>;

	/**
	 * `POST /v1/accounts/{account}/webhooks` — scope `webhooks:write`, live
	 * credential only. `accountId` fills `{account}`.
	 *
	 * Resolves with the endpoint INCLUDING its plaintext secret, which the caller
	 * must persist at once.
	 */
	createAccountWebhookEndpoint(
		accountId: string,
		body: CreateAccountWebhookEndpointBody,
	): Promise<AccountWebhookEndpointWithSecretV1>;

	/**
	 * `GET /v1/accounts/{account}/webhooks/{webhook}` — scope `webhooks:read`.
	 *
	 * Rejects with `ERROR_ENDPOINT_GONE` on HTTP 404 (the signature has no `null`
	 * branch); the caller tells that message apart from other failures.
	 */
	getAccountWebhookEndpoint(accountId: string, endpointId: string): Promise<AccountWebhookEndpointV1>;

	/**
	 * `DELETE /v1/accounts/{account}/webhooks/{webhook}` — scope
	 * `webhooks:delete`. Resolves normally when the endpoint was already gone.
	 */
	deleteAccountWebhookEndpoint(accountId: string, endpointId: string): Promise<void>;
}
