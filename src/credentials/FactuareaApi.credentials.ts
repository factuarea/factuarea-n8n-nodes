import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

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
				'Root of the Factuarea public API, including the version segment. Leave the default unless the key belongs to a different Factuarea environment.',
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
