/**
 * The fifteen account events a trigger in account mode can subscribe to.
 *
 * ## Why this list is written down here, and the only one in the package
 *
 * Every other event name the picker offers is read LIVE from the public
 * catalogue (`GET {baseUrl}/event-catalog`), and `loadEventOptions.ts` explains
 * why a hand-written list is prohibited there. These fifteen are the exception
 * because no route serves them: the account events are disjoint from the public
 * catalogue (the backend asserts that the two sets do not intersect), so the
 * catalogue request never returns an `account.*` name and there is nothing to
 * read. An account webhook accepts them together with the company events that
 * are available, which is why account mode shows both.
 *
 * ## How the list is kept honest
 *
 * `test/accountEventCatalog.test.ts` compares it with
 * `test/vectors/account-event-types.json`, a file extracted from the schema
 * `components.schemas.AccountEventType.enum` of the frozen public API document
 * by `scripts/extract-account-event-types.mjs <path-to-openapi.json>`; the
 * vector's `$meta` carries the document's digests and that command. When the contract gains or loses
 * an account event, regenerate the vector from the new document and the test
 * fails naming the event this list lacks or no longer should have. The order is
 * the contract's, not alphabetical: `loadEventOptions` sorts for display.
 *
 * Company mode never offers any of these: a company webhook endpoint rejects an
 * `account.*` name.
 */
export const ACCOUNT_EVENT_CATALOG = [
	'account.member_added',
	'account.member_removed',
	'account.member_role_changed',
	'account.owner_transferred',
	'account.member_grant_changed',
	'account.access_granted',
	'account.access_revoked',
	'account.access_level_changed',
	'account.managed_account_provisioned',
	'account.managed_account_claimed',
	'account.management_ended',
	'account.nif_added',
	'account.nif_transferred',
	'account.nif_archived',
	'account.import_completed',
] as const;

/** One of the fifteen account event names. */
export type AccountEventType = (typeof ACCOUNT_EVENT_CATALOG)[number];
