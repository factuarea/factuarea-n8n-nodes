/**
 * The complete catalogue of user-facing error messages this node can show.
 *
 * Every message names the CAUSE and the NEXT STEP. A message that only says what
 * failed leaves the user with a trigger that does not fire and no idea what to
 * do, which is the same as no message at all.
 *
 * All messages are in English. That is the declared, bounded exception to the
 * project rule of writing user-facing messages in Spanish, and its reason is
 * written down in `docs/ENGLISH-ONLY.md`: n8n's target markets require it, and
 * without verification there is no presence on n8n Cloud. The exception stops at
 * the sibling packages; the monorepo keeps Spanish with three-locale parity.
 *
 * ## PROHIBITED IN EVERY MESSAGE, WITHOUT EXCEPTION
 *
 * No message in this file — and no message any other module builds — may contain:
 *
 *   - the webhook signing secret, in whole or in part;
 *   - the API key, in whole or in part;
 *   - the expected signature, or any HMAC digest computed by this node;
 *   - the raw body of an API response, which can carry account data.
 *
 * The reason is not style. A workflow error surfaces in the n8n execution log,
 * which is stored, shared in screenshots and pasted into support tickets. A
 * message that echoes the expected signature hands an attacker the one value the
 * comparison exists to protect, and turns a rejected delivery into a forgery
 * recipe. A message that echoes the response body leaks the account's data into
 * a log that has different readers than the API does.
 *
 * When a message needs to point at what failed, it names the FIELD or the
 * OPERATION — never the value.
 *
 * The English-only gate reads this file. So does anyone changing it: if a new
 * message needs a value interpolated into it, the value must be one the user
 * supplied and can already see (a URL, an event name), never one the node holds.
 */

/**
 * The receiving URL was refused by Factuarea.
 *
 * Two measured causes, both permanent and both fixed the same way. Factuarea
 * only accepts `https://` destinations, and it refuses — permanently, with no
 * retry — any destination that resolves to a private network address. A
 * self-hosted n8n reachable only from an internal network therefore never
 * receives a delivery.
 */
export const ERROR_ENDPOINT_URL_NOT_ACCEPTED =
	'Factuarea refused this workflow\'s webhook URL. Factuarea only delivers to HTTPS addresses that resolve on the public internet, and it rejects addresses on private networks permanently rather than retrying them. Expose this n8n instance on a public HTTPS address (a tunnel or a reverse proxy works) or run the workflow on n8n Cloud, then activate the trigger again.';

/**
 * The account is already at its webhook destination limit.
 *
 * The API answers 422 with subcode `max_webhook_endpoints_reached`. Nothing the
 * node can do about it: the user has to free a slot.
 */
export const ERROR_ENDPOINT_LIMIT_REACHED =
	'Your Factuarea account has reached its limit of webhook destinations, so this trigger could not register one. Delete a webhook destination you no longer use in Factuarea (Settings, Developers, Webhooks) and activate this workflow again.';

/**
 * The API key is missing a scope this node needs.
 *
 * The trigger needs `webhooks:write` to register its destination,
 * `webhooks:read` to check it still exists, `webhooks:delete` to remove it on
 * deactivation, and `events:read` to list the event catalogue.
 */
export const ERROR_INSUFFICIENT_SCOPE =
	'The Factuarea API key in this credential is missing a permission this trigger needs. Give the key the webhooks read, write and delete permissions and the events read permission in Factuarea (Settings, Developers, API keys), or create a new key with them, then update the credential.';

/**
 * The event catalogue could not be read.
 *
 * The event list is read live from the public catalogue on purpose: a list
 * frozen into the package would offer events the API refuses to subscribe to.
 * When the call fails the node says so instead of falling back to that list.
 */
export const ERROR_EVENT_CATALOG_UNAVAILABLE =
	'The list of Factuarea events could not be loaded, so there is nothing to choose from. This trigger reads the event list from Factuarea every time you open it rather than shipping a fixed copy, so a failed request leaves the field empty. Check that the credential is valid and that Factuarea is reachable, then reopen this field.';

/**
 * The runtime did not hand over the raw request body.
 *
 * Reconstructing it by re-serialising the parsed object is prohibited: it changes
 * bytes and turns every valid signature into an invalid one. Failing loudly here
 * is the only honest option.
 */
export const ERROR_RAW_BODY_UNAVAILABLE =
	'This delivery could not be verified because n8n did not provide the raw request body, and the signature is computed over the exact bytes Factuarea sent. Rebuilding those bytes from the parsed payload would change them and reject every delivery, so the trigger stops instead. Make sure no proxy in front of n8n rewrites request bodies, then send the delivery again.';

/**
 * The timestamp is inside tolerance but no candidate signature matched.
 *
 * This is the shape of a secret rotated outside n8n. The node cannot read the
 * secret of an existing destination — the API returns it once, at creation — so
 * it cannot recover on its own. Re-activating the trigger deletes the stale
 * destination and creates a new one with a new secret.
 */
export const ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE =
	'A delivery arrived with a valid timestamp but a signature this trigger could not match. The most likely cause is that the webhook secret was rotated outside n8n: Factuarea only returns a secret when the destination is created, so this trigger cannot pick up a new one by itself. Deactivate and activate this workflow to register a fresh destination, then send the event again.';

/**
 * The destination this trigger owns no longer exists in Factuarea.
 *
 * Not an error the user has to act on during normal lifecycle handling — the
 * trigger treats it as "not registered" and creates a new destination. It is a
 * message because a client operation still has to explain a 404 when it surfaces.
 */
export const ERROR_ENDPOINT_GONE =
	'The webhook destination this trigger registered no longer exists in Factuarea; it was probably deleted from the Factuarea dashboard or through the API. Activate this workflow again to register a new destination with a new secret.';

/**
 * The destination still exists, but Factuarea has stopped delivering to it.
 *
 * Measured: `DeliverWebhookCommandHandler` drops a delivery when the endpoint's
 * status is not `active`, and `OnWebhookDeliveryFailedDetectDegraded` moves a
 * destination to `degraded` after 100 permanent failures in 24 hours. A
 * destination can also be disabled from the dashboard. All of them leave a
 * destination that reads back perfectly well and receives nothing, which is why
 * "it exists" is not the question the lifecycle check may ask.
 */
export const ERROR_ENDPOINT_NOT_ACTIVE =
	'The webhook destination this trigger registered still exists in Factuarea but is no longer active, so Factuarea has stopped delivering events to it. Factuarea suspends a destination after 100 deliveries fail permanently within 24 hours, and a destination can also be disabled from the dashboard. Deactivate and activate this workflow: deactivating removes the suspended destination and activating registers a fresh one.';

/**
 * The destination points somewhere this workflow no longer answers.
 *
 * The receiving address comes from n8n (`getNodeWebhookUrl`), and it changes
 * when the instance's public URL changes — a new domain, a new tunnel, a
 * reverse proxy moved. The destination in Factuarea keeps the address it was
 * registered with, so deliveries keep going to an address nothing answers on,
 * and the trigger, which only asked whether the destination EXISTS, keeps
 * reporting that everything is in place.
 */
export const ERROR_ENDPOINT_URL_MISMATCH =
	'The webhook destination this trigger registered points at a different address from the one this workflow answers on now, so Factuarea is delivering these events to an address this workflow never sees. The address changes when the public URL of this n8n instance changes. Deactivate and activate this workflow: deactivating removes the destination at the old address and activating registers one for the current address.';

/**
 * The workflow was activated with no event selected.
 *
 * `required: true` on the `events` property does NOT stop an activation, so
 * without this check the empty list travels to the API, which answers 422
 * `invalid_param_value` for `enabled_events` — a status the client can only
 * translate into the generic message that sends the user to check their API
 * key, which is not the problem at all.
 */
export const ERROR_NO_EVENTS_SELECTED =
	'Select at least one event in the Events field before activating this workflow. Factuarea registers a delivery destination with the events chosen at the moment of activation and refuses one that subscribes to nothing, so a trigger with an empty selection cannot be registered and would never fire.';

/**
 * No company was named, so no webhook route can be addressed.
 *
 * Every webhook-endpoint route of the public API carries the company in its
 * path (`/v1/companies/{company}/webhook-endpoints`). Before this version the
 * routes had no such segment and the API resolved the company from the key on
 * its own; they no longer do, and this node refuses to guess. A request built
 * without the segment reaches a route that does not exist, and the 404 that
 * comes back says nothing about the field that is empty.
 *
 * The two places a company can be named are both typed by the integrator: the
 * node's own Company ID field, and the credential's Default Company ID. Neither
 * is derived from whoever owns the key.
 */
export const ERROR_COMPANY_NOT_SELECTED =
	'Select the company this trigger works with before activating the workflow. Fill in the Company ID field of the node, or the Default Company ID field of the Factuarea API credential, with the company UUID from Factuarea (Settings, Companies). Every webhook route of the public API carries the company in its path, and Factuarea no longer picks one on your behalf, so a trigger without it cannot register a destination.';

/**
 * Account mode: no account was named, so no account webhook route can be addressed.
 *
 * Every account webhook route carries the account in its path
 * (`/v1/accounts/{account}/webhooks`). The two places an account can be named
 * are both typed by the integrator: the node's own Account ID field and the
 * credential's Default Account ID field. Neither is derived from whoever owns
 * the key, because the key does not say which account a workflow should watch.
 */
export const ERROR_ACCOUNT_NOT_SELECTED =
	'Select the account this trigger listens to before activating the workflow. Fill in the Account ID field of the node, or the Default Account ID field of the Factuarea API credential, with the account UUID from Factuarea (call GET /v1/me with your API key and read data.account.id; the cURL example in Settings, Developers also shows the UUID of the active account). Every account webhook route of the public API carries the account in its path, and Factuarea does not pick one from the API key, so a trigger without it cannot register an endpoint.';

/**
 * An account route answered 404 `account_not_found`: the Account ID is not the
 * account of this API key (or does not exist).
 *
 * Told apart from a missing endpoint by the error `code`, because the remedy is
 * different: the endpoint is fine, the account in the path is wrong.
 */
export const ERROR_ACCOUNT_NOT_FOUND =
	'Factuarea says the Account ID of this trigger is not the account of this API key, or that account does not exist. Check the Account ID field of the node, or the Default Account ID field of the Factuarea API credential. The UUID of the account of your key is returned by GET /v1/me in data.account.id.';

/**
 * A test key tried to write an account endpoint.
 *
 * The node refuses it BEFORE calling when the key starts with `fact_test_`, and
 * also translates the REST answers a test key meets (403
 * `module_not_available_in_sandbox`) and the MCP code `live_credential_required`
 * (`AccountCapabilityCredentialGuard::ensureWrite`), in case the backend emits
 * it. A 403 `insufficient_scope` stays the missing-scope message.
 */
export const ERROR_LIVE_CREDENTIAL_REQUIRED =
	'Factuarea refused to register an account webhook because the API key in this credential is a test key. Account webhooks can only be created and removed with a live key. Create a live API key in Factuarea (Settings, Developers, API keys), update the credential with it, then activate this workflow again.';

/**
 * The key's issuer cannot act on the account (403 `forbidden_action`).
 *
 * Account endpoints are reserved to owners and admins whose access covers every
 * tax ID of the account, and the check is repeated on the key's issuer.
 */
export const ERROR_ACCOUNT_CAPABILITY_REQUIRED =
	'Factuarea refused this account webhook because the user who issued the API key cannot manage the whole account. Account webhooks need a key issued by an owner or an admin with access to all tax IDs of the account. Create a new API key as such a user in Factuarea (Settings, Developers, API keys), update the credential with it, then activate this workflow again.';

/**
 * The account is at its account-endpoint limit (422 `account_webhook_endpoint_limit_reached`).
 */
export const ERROR_ACCOUNT_ENDPOINT_LIMIT_REACHED =
	'Your Factuarea account has reached its limit of account webhook endpoints, so this trigger could not register one. Delete an account webhook endpoint you no longer use in Factuarea (Settings, Developers, Webhooks) and activate this workflow again.';

/**
 * The plan does not include account webhooks (402 `addon_required`).
 */
export const ERROR_ACCOUNT_WEBHOOKS_ADDON_REQUIRED =
	'Your current Factuarea plan does not include account webhooks, so this trigger could not register an endpoint. Upgrade the plan of the paying account in Factuarea (Settings, Billing), or switch this trigger back to listening to a single company, then activate this workflow again.';

/**
 * The endpoint was switched off because its creator lost the capability
 * (`status: disabled`, `disabled_reason: creator_lost_capability`).
 *
 * Not an HTTP rejection: the endpoint still reads back, and receives nothing.
 */
export const ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY =
	'The account webhook endpoint this trigger registered has been disabled by Factuarea because the user who created its API key is no longer an owner or an admin with access to all tax IDs. Factuarea has stopped delivering events to it. Update the credential with a key issued by such a user, then deactivate and activate this workflow to register a fresh endpoint.';

/**
 * Every message in the catalogue, keyed by a stable identifier.
 *
 * Enumerated here so tests and gates can walk the catalogue instead of
 * rediscovering the exports. Adding a message means adding it here too.
 */
export const NODE_ERRORS = {
	endpointUrlNotAccepted: ERROR_ENDPOINT_URL_NOT_ACCEPTED,
	endpointLimitReached: ERROR_ENDPOINT_LIMIT_REACHED,
	insufficientScope: ERROR_INSUFFICIENT_SCOPE,
	eventCatalogUnavailable: ERROR_EVENT_CATALOG_UNAVAILABLE,
	rawBodyUnavailable: ERROR_RAW_BODY_UNAVAILABLE,
	signatureMismatchWithinTolerance: ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE,
	endpointGone: ERROR_ENDPOINT_GONE,
	endpointNotActive: ERROR_ENDPOINT_NOT_ACTIVE,
	endpointUrlMismatch: ERROR_ENDPOINT_URL_MISMATCH,
	noEventsSelected: ERROR_NO_EVENTS_SELECTED,
	companyNotSelected: ERROR_COMPANY_NOT_SELECTED,
	accountNotSelected: ERROR_ACCOUNT_NOT_SELECTED,
	accountNotFound: ERROR_ACCOUNT_NOT_FOUND,
	liveCredentialRequired: ERROR_LIVE_CREDENTIAL_REQUIRED,
	accountCapabilityRequired: ERROR_ACCOUNT_CAPABILITY_REQUIRED,
	accountEndpointLimitReached: ERROR_ACCOUNT_ENDPOINT_LIMIT_REACHED,
	accountWebhooksAddonRequired: ERROR_ACCOUNT_WEBHOOKS_ADDON_REQUIRED,
	accountEndpointCreatorLostCapability: ERROR_ACCOUNT_ENDPOINT_CREATOR_LOST_CAPABILITY,
} as const;

/** Stable identifier of a catalogued error message. */
export type NodeErrorKey = keyof typeof NODE_ERRORS;
