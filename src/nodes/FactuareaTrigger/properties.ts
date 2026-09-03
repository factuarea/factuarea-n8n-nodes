import type { INodeProperties } from 'n8n-workflow';

import {
	DEFAULT_TOLERANCE_SECONDS,
	MAX_TOLERANCE_SECONDS,
	MIN_TOLERANCE_SECONDS,
} from '../../contract';
import { LOAD_OPTIONS_METHOD_EVENT_TYPES } from '../../client/types';

/**
 * The three parameters the trigger exposes in the n8n editor.
 *
 * There are exactly three, and their `name` values are frozen in
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
 * the user nothing they could not read off the label. Each of the three below
 * states the consequence of moving it, because all three have one: the event
 * selection is fixed when the delivery destination is created, a wider tolerance
 * is a wider replay window, and turning deduplication off makes the workflow run
 * again for every retry of an event it already handled.
 */
export const factuareaTriggerProperties: INodeProperties[] = [
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
			'Which Factuarea events start this workflow. The options are read from the live public catalogue using the selected credential, so an event that Factuarea has announced but cannot emit yet is not offered. The selection is sent to Factuarea when the workflow is activated: changing it later takes effect on the next activation, because the delivery destination is created once with the events chosen at that moment.',
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
