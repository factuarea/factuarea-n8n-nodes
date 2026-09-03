/**
 * Fills the node's event picker from the LIVE public catalogue.
 *
 * Registered by the node class as `methods.loadOptions.getEventTypes` — the
 * method name is frozen as `LOAD_OPTIONS_METHOD_EVENT_TYPES` in
 * `src/client/types.ts` and read from there by the property declaration too, so
 * the three sides cannot drift apart with a typo.
 *
 * ## Why there is no fallback list, anywhere in this file
 *
 * The obvious defensive move — ship a hand-written array of event names and
 * return it when the request fails — is prohibited here, and the reason is not
 * taste. The catalogue carries a `status`, and an entry marked `coming_soon` is
 * ANNOUNCED but not yet emitted: subscribing to it is rejected with 422 by the
 * creation call. A frozen list would therefore offer the user options that the
 * node itself makes impossible to activate, and the failure would arrive later,
 * somewhere else, as an error about a value the node had suggested. It would
 * also mean republishing the package — and passing n8n verification again —
 * every time the catalogue grows. Reading it live is what lets this node gain
 * events without a new version.
 *
 * So when the catalogue cannot be read, the picker stays EMPTY and says why.
 * An empty picker with an explanation is recoverable; a populated picker full
 * of names the API will refuse is not.
 *
 * ## The available-only filter lives in the client, on purpose
 *
 * `listEventCatalog()` already drops everything that is not `available` — it is
 * written into its contract in `src/client/types.ts` and pinned by its own
 * tests. This function does not filter again: two copies of the same rule in two
 * modules is two places to keep in sync, and the second one is the one that gets
 * forgotten. `test/loadEventOptions.test.ts` still pins the end-to-end
 * guarantee, driving the real client over a doubled HTTP helper, so a
 * regression in either module surfaces here.
 *
 * ## Ordering
 *
 * Options come back sorted by name with `localeCompare(…, 'en')`. The locale is
 * pinned rather than left to the host: an unpinned comparison orders the list
 * differently depending on the machine's locale, so the same catalogue would
 * render in a different order on two n8n instances, and a screenshot in a
 * support ticket would not match what the user sees. `'en'` is the package's
 * declared language (see `docs/ENGLISH-ONLY.md`).
 */

import type {
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
} from 'n8n-workflow';

import { createFactuareaApiClient } from '../../client/factuareaApiClient';
import type { FactuareaHttpRequester } from '../../client/types';
import { DEFAULT_API_BASE_URL } from '../../contract';
import { ERROR_EVENT_CATALOG_UNAVAILABLE, ERROR_INSUFFICIENT_SCOPE } from '../../errors';

/**
 * The credential type this node authenticates with.
 *
 * Must stay equal to the `name` field of `src/credentials/FactuareaApi.credentials.ts`
 * and to the credential the node class declares. Nothing in the type system ties
 * the three together — `getCredentials` takes a plain string — so a rename there
 * fails at runtime with "credentials not found", not at compile time.
 */
const CREDENTIAL_NAME = 'factuareaApi';

/** The value as a non-empty string, or `null`. */
function asText(value: unknown): string | null {
	return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Adapts n8n's HTTP helper to the requester type the client takes.
 *
 * The client receives its transport as an argument instead of importing one,
 * which is what keeps the package's runtime dependency list empty and lets a
 * test hand it a plain function. The two option types describe the same request
 * and differ in one field: ours widens `body` to `unknown`, because the client
 * hands the helper whatever it was asked to serialise as JSON, while n8n's
 * enumerates the shapes its helper accepts. The cast is confined to that one
 * field. This module only ever issues the catalogue GET, which carries no body
 * at all, but the adapter is written total because its type is.
 */
function requesterOf(context: ILoadOptionsFunctions): FactuareaHttpRequester {
	return async (options) =>
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
 * The message the user reads when the picker could not be filled.
 *
 * One failure is let through unchanged, and only one: a missing scope. The
 * client raises `ERROR_INSUFFICIENT_SCOPE` for a 403, and that message names the
 * exact remedy — grant the key `events:read` in Factuarea. Collapsing it into
 * "the catalogue could not be loaded" would send the user to check connectivity
 * and credential validity, neither of which is wrong here, and neither of which
 * fixes it.
 *
 * Everything else becomes `ERROR_EVENT_CATALOG_UNAVAILABLE`: a transport
 * failure, an unreadable body, an unknown status, a credential without a usable
 * key. Replacing rather than re-throwing is deliberate — an error raised
 * somewhere below can carry text this node did not author, and a load-options
 * failure is rendered straight into the editor, so passing an arbitrary message
 * through is how a response body ends up on someone's screen. `src/errors.ts`
 * spells out what may never appear in a message.
 */
function catalogueFailure(error: unknown): Error {
	if (error instanceof Error && error.message === ERROR_INSUFFICIENT_SCOPE) {
		return error;
	}

	return new Error(ERROR_EVENT_CATALOG_UNAVAILABLE);
}

export async function loadEventOptions(
	this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
	try {
		const credentials = await this.getCredentials(CREDENTIAL_NAME);

		const apiKey = asText(credentials['apiKey']);

		if (apiKey === null) {
			throw new Error(ERROR_EVENT_CATALOG_UNAVAILABLE);
		}

		// A blank base URL falls back to the SAME constant the credential
		// declares as its default, so clearing the field reproduces the declared
		// default instead of composing requests against an empty origin. This is
		// not inventing an environment: it is the one the credential already says.
		const baseUrl = asText(credentials['baseUrl']) ?? DEFAULT_API_BASE_URL;

		const client = createFactuareaApiClient(requesterOf(this), { baseUrl, apiKey });
		const entries = await client.listEventCatalog();

		return entries
			.map((entry) => ({
				name: entry.name,
				value: entry.name,
				description: entry.description,
			}))
			.sort((left, right) => left.name.localeCompare(right.name, 'en'));
	} catch (error) {
		throw catalogueFailure(error);
	}
}
