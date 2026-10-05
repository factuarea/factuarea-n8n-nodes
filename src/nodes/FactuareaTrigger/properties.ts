import type { INodeProperties } from 'n8n-workflow';

import {
	DEFAULT_TOLERANCE_SECONDS,
	MAX_TOLERANCE_SECONDS,
	MIN_TOLERANCE_SECONDS,
} from '../../contract';
import {
	LISTEN_ON_DEFAULT,
	LOAD_OPTIONS_METHOD_EVENT_TYPES,
	PARAMETER_ACCOUNT_ID,
	PARAMETER_ACCOUNT_RELATIONSHIP,
	PARAMETER_COMPANY_FILTER,
	PARAMETER_COMPANY_ID,
	PARAMETER_LISTEN_ON,
} from '../../client/types';

/**
 * The eight parameters the trigger exposes in the n8n editor.
 *
 * There are exactly eight (four of them predate account mode), and their `name` values are frozen in
 * `src/client/types.ts`: the node class reads each one back with
 * `getNodeParameter('<name>')`, and the two sides are written by different
 * phases. Renaming one here without renaming it there produces a trigger that
 * silently reads `undefined` instead of what the user configured, which is worse
 * than a compile error because nothing reports it.
 *
 * ## Everything here is in English, and that is the declared exception
 *
 * Parameter names, descriptions and hints are user-facing text, and the project
 * rule is to write user-facing text in Spanish. This package is the bounded
 * exception, and its reason is written down in `docs/ENGLISH-ONLY.md`: n8n's
 * verification and its markets require English. The English-only gate reads this
 * file, so a Spanish description added here fails the build rather than shipping.
 *
 * ## Every description says what the parameter does AND what changing it costs
 *
 * A description that only names the field ("The events to subscribe to") tells
 * the user nothing they could not read off the label. Each of the four below
 * states the consequence of moving it, because all four have one: the company
 * decides where the destination is registered and cannot be changed under a
 * running trigger, the event selection is fixed when the delivery destination is
 * created, a wider tolerance is a wider replay window, and turning deduplication
 * off makes the workflow run again for every retry of an event it already
 * handled.
 *
 * ## Account mode is a second mode of the SAME node, and company mode is the default
 *
 * The package declares one node and one credential, so listening to a whole
 * account is a mode, not a second node. `listenOn` defaults to `company`: a
 * workflow saved before the mode existed has no value for it, n8n resolves the
 * missing value to this default before it evaluates `displayOptions`, and the
 * workflow therefore renders and behaves exactly as it did. Each mode shows only
 * its own fields: the company field in company mode; the account, the
 * relationship filter and the company filter in account mode. The events, the
 * tolerance and deduplication belong to both, because the signature scheme and
 * the retry behaviour are the same.
 *
 * ## Why the company is the first TARGET, and why it is a field at all
 *
 * Until this version the node had nowhere to name a company: the webhook routes
 * of the public API hung from the root of the version and the API resolved the
 * company from the API key. They now carry it in the path, so the integrator has
 * to say which one — and the field sits at the top because it is the first
 * decision, not the last: the event picker below reads a catalogue that is the
 * same for every company, so filling the two in the other order reads as if the
 * events chose the company.
 */
export const factuareaTriggerProperties: INodeProperties[] = [
	{
		displayName: 'Listen On',
		name: PARAMETER_LISTEN_ON,
		type: 'options',
		options: [
			{
				name: 'Company',
				value: 'company',
				description: 'Events of one company, registered on the company webhook routes',
			},
			{
				name: 'Account',
				value: 'account',
				description:
					'Events of a whole account, its own tax ids and the accounts it manages, registered on the account webhook routes',
			},
		],
		default: LISTEN_ON_DEFAULT,
		description:
			'Whether this trigger listens to the events of one company or to those of a whole account. Company is the behaviour of every workflow saved before this option existed. Account registers an account webhook, which needs a live API key issued by an owner or admin of the account. The mode is read when the workflow is activated: switching it afterwards takes effect when the workflow is activated again.',
	},
	{
		displayName: 'Company ID',
		// Frozen in `src/client/types.ts`: `webhookLifecycle.ts` reads this exact
		// name back, and a rename on one side alone is a value read as
		// `undefined` with nothing reporting it.
		name: PARAMETER_COMPANY_ID,
		type: 'string',
		default: '',
		displayOptions: { show: { [PARAMETER_LISTEN_ON]: ['company'] } },
		// Deliberately NOT `required`: an empty value is legal when the credential
		// carries a default company, and n8n turns a required-and-empty parameter
		// into a node issue that blocks activation, which would make that
		// documented fallback unusable. The rejection lives in the lifecycle,
		// which names both fields.
		placeholder: '019251c0-0000-7000-8000-000000000001',
		description:
			'UUID of the Factuarea company whose webhook destinations this trigger manages, as shown in Factuarea (Settings, Companies). It is the company UUID and never a tax id. Every webhook route of the public API carries it in the path, so the trigger cannot register anything without it and Factuarea does not pick one on your behalf. Leave it empty only when the credential carries a default company, which is then used instead. Changing it points the trigger at another company: deactivate and activate the workflow again so the destination is registered where the events are produced.',
	},
	{
		displayName: 'Account ID',
		// Frozen in `src/client/types.ts`: the lifecycle reads this exact name back.
		name: PARAMETER_ACCOUNT_ID,
		type: 'string',
		default: '',
		displayOptions: { show: { [PARAMETER_LISTEN_ON]: ['account'] } },
		// Not `required`, for the same reason as the company: the credential may
		// carry a default account, and the rejection lives in the lifecycle, which
		// names both fields.
		placeholder: '019251c0-0000-7000-8000-000000000002',
		description:
			'UUID of the Factuarea account whose events this trigger listens to. You type it: it is the UUID returned by GET /v1/me in data.account.id (the example requests of Factuarea under Developers show it too), and Factuarea does not pick one from the API key. Every account webhook route carries it in the path. Leave it empty only when the credential carries a default account, which is then used instead. Changing it points the trigger at another account: deactivate and activate the workflow again so the destination is registered where the events are produced.',
	},
	{
		displayName: 'Account Relationship',
		name: PARAMETER_ACCOUNT_RELATIONSHIP,
		type: 'options',
		options: [
			{
				name: 'Own',
				value: 'own',
				description: 'Only the tax ids of your own account',
			},
			{
				name: 'Managed',
				value: 'managed',
				description: 'Only the tax ids of the accounts your account manages',
			},
			{
				name: 'All',
				value: 'all',
				description: 'Your own tax ids and those of the accounts you manage',
			},
		],
		default: 'all',
		displayOptions: { show: { [PARAMETER_LISTEN_ON]: ['account'] } },
		description:
			'Which tax ids the account webhook covers. It is sent to Factuarea when the workflow is activated and fixed for that destination, so changing it takes effect on the next activation. Each delivered event says which of the two it is, own or managed, and never all.',
	},
	{
		displayName: 'Company ID Filter',
		name: PARAMETER_COMPANY_FILTER,
		type: 'string',
		default: '',
		displayOptions: { show: { [PARAMETER_LISTEN_ON]: ['account'] } },
		placeholder: '019251c0-0000-7000-8000-000000000001',
		description:
			'Optional UUID of one company (tax id) of the account. When it is filled, an event that belongs to another company is acknowledged and dropped without starting the workflow, so Factuarea does not retry it. An event of the account itself, which belongs to no company, always starts the workflow. This is a filter on the delivered events: the destination still receives every event of the account and is not narrowed in Factuarea.',
	},
	{
		displayName: 'Events',
		name: 'events',
		type: 'multiOptions',
		typeOptions: {
			// This string is the contract with the node class, which registers the
			// same name under `methods.loadOptions`. A typo on either side produces
			// an empty picker and no error at all.
			loadOptionsMethod: LOAD_OPTIONS_METHOD_EVENT_TYPES,
		},
		default: [],
		required: true,
		description:
			'Which Factuarea events start this workflow. The options are read from the live public catalogue using the selected credential, so an event that Factuarea has announced but cannot emit yet is not offered. In account mode the fifteen account events (members, access, managed accounts, tax ids and imports) are offered as well, because no public catalogue lists them. The selection is sent to Factuarea when the workflow is activated: changing it later takes effect on the next activation, because the delivery destination is created once with the events chosen at that moment.',
	},
	{
		displayName: 'Timestamp Tolerance (Seconds)',
		name: 'toleranceSeconds',
		type: 'number',
		typeOptions: {
			minValue: MIN_TOLERANCE_SECONDS,
			maxValue: MAX_TOLERANCE_SECONDS,
		},
		default: DEFAULT_TOLERANCE_SECONDS,
		description:
			'How far the timestamp signed into a delivery may sit from this instance clock, in either direction, before the delivery is rejected even though its signature is correct. Raising it widens the window in which a captured delivery can be replayed against this workflow. Lowering it below the real clock difference between this instance and Factuarea rejects every delivery, and the rejection looks the same as a wrong secret.',
		hint: 'Change this only when correctly signed deliveries are rejected because the two clocks differ. The default matches the window Factuarea documents.',
	},
	{
		displayName: 'Skip Repeated Events',
		name: 'deduplicate',
		type: 'boolean',
		default: true,
		description:
			'Whether to answer a repeat delivery of an event already processed with success and drop it, instead of producing a second item. Factuarea retries a delivery until it is acknowledged, so the same event does arrive more than once. Turning this off runs the workflow again for every retry, repeating whatever the workflow does. The memory of processed events is bounded and belongs to the active workflow, so a manual test execution can still produce an item for an event an activated run already handled.',
	},
];
