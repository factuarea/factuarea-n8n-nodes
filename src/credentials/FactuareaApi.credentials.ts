import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

import { CREDENTIAL_FIELD_COMPANY_ID } from '../client/types';
import { DEFAULT_API_BASE_URL } from '../contract';

/**
 * The single credential this package publishes: an API key for the Factuarea
 * public REST API v1, plus the base URL that key belongs to.
 *
 * Measured 2026-09-02 against the emitter, not invented:
 *   - `backend/app/PublicApi/Infrastructure/Http/Routes/v1-public.php`
 *     (`GET event-catalog`, guarded by `public-api.scope:events:read`)
 *   - `backend/config/public_api.php` (the v1 domain frozen in `src/contract.ts`)
 *
 * ## Why the base URL is a PARAMETER and never an environment variable
 *
 * n8n's community-node verification forbids a node from reading the environment:
 * a verified package may not touch `process.env`, and the official analyser
 * fails a package that does. So the usual escape hatch — read
 * `FACTUAREA_API_URL` and fall back to production — is not available here, and
 * writing it would cost the package its verification.
 *
 * Without a parameter there would then be NO way to point this node at anything
 * other than production. Sandbox accounts, a staging deployment and any local
 * integration run would all be unreachable, and the only remedy left would be to
 * fork and republish the package, which is worse in every direction.
 *
 * Hence: the base URL travels with the key, in the credential, where the user
 * can see it and change it. It defaults to `DEFAULT_API_BASE_URL` so the normal
 * case needs no decision, and the value includes the `/v1` version segment
 * because every path this package requests is relative to it.
 *
 * ## THE BASE URL STOPS AT THE VERSION AND NEVER SWALLOWS THE COMPANY
 *
 * The webhook routes now carry the company in their path
 * (`/v1/companies/{company}/webhook-endpoints`), and the tempting shortcut is to
 * let the user paste it into this field once, as
 * `https://api.factuarea.com/v1/companies/<uuid>`. That is prohibited here, and
 * the reason is measured rather than stylistic: the event catalogue hangs from
 * this SAME base with no prefix at all (`{baseUrl}/event-catalog`), and so does
 * the credential test below. A base carrying a company would compose
 * `/v1/companies/<uuid>/event-catalog`, which does not exist, and the failure
 * would land on the credential test and on the event picker — the two places a
 * user goes to check that the key works. The company therefore lives in its own
 * field, and the client takes it as an argument of the three calls that need it.
 *
 * ## The company field is a DEFAULT, and it is typed rather than inferred
 *
 * The node has a Company ID parameter of its own, and it wins when it is filled.
 * The field below exists so an account that works with one company fills it once
 * instead of once per workflow. It is never derived from whoever owns the key:
 * inferring the company from the credential is exactly the behaviour the public
 * API dropped, and reproducing it here would put a trigger on a company nobody
 * chose. When both are empty the trigger refuses to activate and says so.
 *
 * ## Why the credential test hits a READ route
 *
 * `GET /v1/event-catalog` creates nothing, consumes no write quota and is
 * idempotent, so pressing "Test" repeatedly is free. It also exercises the
 * `events:read` scope that the trigger's event picker needs, which means a key
 * that passes the test can actually populate the picker — a test against an
 * authenticated route that the node never calls would pass for keys the node
 * cannot work with.
 *
 * ## The key never reaches a log
 *
 * `typeOptions.password` masks the field in the n8n editor, and n8n stores
 * credential values encrypted. The rest of the guarantee is this package's own:
 * `src/errors.ts` prohibits every message from carrying the API key, the signing
 * secret, a computed digest or a raw response body, and no module here
 * interpolates a credential value into anything a user or a log can read.
 */
export class FactuareaApi implements ICredentialType {
	name = 'factuareaApi';

	displayName = 'Factuarea API';

	documentationUrl = 'https://docs.factuarea.com/guides/webhooks';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'API key from Factuarea (Settings, Developers, API keys). It needs the scopes events:read, webhooks:read, webhooks:write and webhooks:delete, because the trigger reads the event catalogue and registers and removes its own webhook destination.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: DEFAULT_API_BASE_URL,
			required: true,
			description:
				'Root of the Factuarea public API, including the version segment and nothing after it. Leave the default unless the key belongs to a different Factuarea environment. Do not add a company here: the event catalogue and the credential test hang from this same root with no prefix, so a base URL carrying a company breaks both. The company belongs in the field below, or in the Company ID field of the node.',
		},
		{
			displayName: 'Default Company ID',
			// Frozen in `src/client/types.ts` next to the node parameter it backs.
			name: CREDENTIAL_FIELD_COMPANY_ID,
			type: 'string',
			default: '',
			description:
				'UUID of the Factuarea company this key works with, used by a trigger that leaves its own Company ID field empty. Fill it in when the account works with a single company, so it is typed once instead of once per workflow. It is never inferred from the key: when this field and the Company ID field of the node are both empty, the trigger refuses to activate rather than registering a destination on a company nobody chose.',
		},
	];

	/**
	 * Sent on every request this package makes.
	 *
	 * The API accepts `Authorization: Bearer <key>` with precedence over the
	 * `X-API-Key` header, and the bearer form is what `src/client/types.ts`
	 * freezes for the client.
	 */
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	/**
	 * Read-only reachability and scope check — see the docblock above.
	 *
	 * The URL is composed in one expression rather than through `baseURL` plus a
	 * relative `url`, so what the test requests is exactly what the credential
	 * says, with no join rule in between.
	 */
	test: ICredentialTestRequest = {
		request: {
			method: 'GET',
			url: '={{$credentials.baseUrl}}/event-catalog',
		},
	};
}
