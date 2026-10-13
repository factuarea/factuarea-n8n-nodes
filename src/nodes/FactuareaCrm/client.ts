import { createHash } from 'node:crypto';
import type {
	IDataObject,
	IHttpRequestOptions,
	INodePropertyOptions,
} from 'n8n-workflow';
import {
	CrmError,
	jsonObject,
	object,
	originalKey,
	positiveInteger,
	resources,
	uuid,
} from './contract';
import type {
	AccessContext,
	ClientOptions,
	CredentialContext,
	OriginalIntent,
	Requester,
	Resource,
	WriteOperation,
} from './contract';


const LEAD_FIELDS = [
	'name',
	'email',
	'phone',
	'mobile',
	'company_name',
	'notes',
	'address',
	'metadata',
	'estimated_value',
	'typed_fields',
];
const OPPORTUNITY_CHANGES = [
	'title',
	'owner_id',
	'team_id',
	'amount',
	'currency',
	'probability_override',
	'override_reason',
	'expected_close',
	'next_step',
	'playbook_answers',
];
const ACTIVITY_CHANGES = [
	'title',
	'body',
	'owner_id',
	'team_id',
	'due_at',
	'timezone',
	'reminder_at',
];

function closed(body: IDataObject, allowed: readonly string[]): void {
	if (Object.keys(body).some((key) => !allowed.includes(key)))
		throw new CrmError(
			'Request contains fields outside the native operation contract.',
			'invalid_fields',
		);
}

function validateIds(value: IDataObject): void {
	for (const [key, child] of Object.entries(value)) {
		if (key === 'metadata') continue;
		if (key === 'id' || key.endsWith('_id')) {
			if (child !== null && child !== undefined) {
				if (key === 'owner_id') {
					if (
						typeof child !== 'string' ||
						!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
							child,
						)
					)
						throw new CrmError(
							'Use a public UUID owner ID.',
							'invalid_record_id',
						);
				} else uuid(child);
			}
		} else if (child && typeof child === 'object') {
			if (Array.isArray(child)) {
				for (const entry of child)
					if (entry && typeof entry === 'object' && !Array.isArray(entry))
						validateIds(object(entry));
			} else validateIds(object(child));
		}
	}
}

export function validateBody(
	resource: Resource,
	operation: WriteOperation,
	body: IDataObject,
): void {
	if (operation === 'move_stage') {
		if (resource !== 'opportunity') throw new CrmError('Stage movement belongs to Opportunity.', 'invalid_operation');
		closed(body, ['expected_version','target_pipeline_id','target_stage_id','expected_definition_version']);
		positiveInteger(body.expected_version); uuid(body.target_pipeline_id); uuid(body.target_stage_id);
		if (!Number.isSafeInteger(body.expected_definition_version) || (body.expected_definition_version as number) < 0) throw new CrmError('Use the original definition CAS.', 'invalid_integer');
		return;
	}
	if (operation === 'create') {
		closed(
			body,
			resource === 'lead'
				? [...LEAD_FIELDS, 'id', 'source', 'owner_id', 'team_id']
				: resource === 'opportunity'
					? [
							'title',
							'lead_id',
							'contact_id',
							'pipeline_id',
							'stage_id',
							'amount',
							'currency',
							'owner_id',
							'team_id',
						]
					: [
							'type',
							'title',
							'body',
							'target',
							'owner_id',
							'due_at',
							'timezone',
						],
		);
		if (
			resource === 'lead' &&
			!['name', 'email', 'phone', 'mobile'].some(
				(key) =>
					typeof body[key] === 'string' && String(body[key]).trim() !== '',
			)
		)
			throw new CrmError(
				'A lead needs a name, email or phone.',
				'invalid_identity',
			);
		if (
			resource !== 'lead' &&
			(typeof body.title !== 'string' || body.title.trim() === '')
		)
			throw new CrmError('A title is required.', 'invalid_title');
		if (resource === 'opportunity') {
			uuid(body.pipeline_id);
			uuid(body.stage_id);
		}
		if (resource === 'activity') {
			if (
				!['task', 'call', 'meeting', 'note'].includes(String(body.type)) ||
				typeof body.timezone !== 'string' ||
				!body.timezone
			)
				throw new CrmError(
					'Choose an activity type and timezone.',
					'invalid_activity',
				);
			const target = object(body.target);
			closed(target, ['type', 'id']);
			uuid(target.id);
			if (
				!['contact', 'person', 'lead', 'opportunity', 'booking'].includes(
					String(target.type),
				)
			)
				throw new CrmError(
					'Choose a native activity target type.',
					'invalid_target',
				);
		}
	} else {
		positiveInteger(body.expected_version);
		if (resource === 'lead') closed(body, [...LEAD_FIELDS, 'expected_version']);
		else {
			closed(body, ['expected_version', 'changes']);
			closed(
				object(body.changes),
				resource === 'opportunity' ? OPPORTUNITY_CHANGES : ACTIVITY_CHANGES,
			);
		}
	}
	const values =
		resource !== 'lead' && operation === 'update' ? object(body.changes) : body;
	if (
		values.amount !== undefined &&
		(typeof values.amount !== 'string' ||
			!/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,4})?$/.test(values.amount))
	)
		throw new CrmError(
			'Amount must be an exact decimal string with at most four decimal places.',
			'invalid_amount',
		);
	if (
		values.currency !== undefined &&
		(typeof values.currency !== 'string' || !/^[A-Z]{3}$/.test(values.currency))
	)
		throw new CrmError(
			'Currency must be a three-letter uppercase code.',
			'invalid_currency',
		);
	if (
		resource === 'opportunity' &&
		operation === 'create' &&
		(values.amount === undefined || values.currency === undefined)
	)
		throw new CrmError('Amount and currency are required.', 'invalid_amount');
	validateIds(body);
}

function publicId(value: unknown): string {
	if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new CrmError('Use a native public UUID.', 'invalid_context');
	return value;
}
function operationFor(resource: Resource, operation: WriteOperation): string {
	if (operation === 'move_stage') { if (resource !== 'opportunity') throw new CrmError('Stage movement belongs to Opportunity.', 'invalid_operation'); return 'crm_opportunities.move_stage'; }
	return resources[resource].operations[operation];
}
function scopeFor(operation: string): string {
	const resource = operation.split('.')[0];
	return resource + ':' + (['create','update','move_stage'].includes(operation.split('.')[1] ?? '') ? 'write' : 'read');
}
function prepared(value: unknown): OriginalIntent {
	const raw = jsonObject(value);
	closed(raw, ['protocol','resource','operation','baseUrl','credentialId','authorizationVersion','sandbox','createdAt','idempotencyKey','recordId','body','wire','sha256','nativeBinding']);
	const original = raw as unknown as OriginalIntent;
	if (typeof original.credentialId !== 'string' || !original.credentialId || typeof original.authorizationVersion !== 'string' || !original.authorizationVersion || typeof original.sandbox !== 'boolean' || typeof original.createdAt !== 'number' || !Number.isSafeInteger(original.createdAt)) throw new CrmError('Invalid original host binding.', 'invalid_original');
	if (original.protocol !== 'factuarea-crm-prepared-v2' || !Object.hasOwn(resources, original.resource) || !['create','update','move_stage'].includes(original.operation)
		|| original.baseUrl !== 'https://api.factuarea.com/v1' || typeof original.wire !== 'string' || typeof original.sha256 !== 'string'
		|| !/^[0-9a-f]{64}$/.test(original.sha256) || createHash('sha256').update(original.wire,'utf8').digest('hex') !== original.sha256
		|| JSON.stringify(original.body) !== original.wire) throw new CrmError('Preserve the exact prepared request snapshot.', 'invalid_original');
	originalKey(original.idempotencyKey); validateBody(original.resource, original.operation, object(original.body));
	const binding = object(original.nativeBinding);
	closed(binding, ['company','credential','client','environment','authModel']);
	publicId(binding.company); publicId(binding.credential);
	if (!['api_key','oauth2'].includes(String(binding.authModel)) || !['test','live'].includes(String(binding.environment))
		|| binding.authModel === 'oauth2' && !binding.client || binding.authModel === 'api_key' && binding.client !== null) throw new CrmError('Invalid original credential binding.', 'invalid_original');
	if (binding.client !== null) publicId(binding.client);
	if ((binding.environment === 'test') !== original.sandbox) throw new CrmError('Invalid original realm.', 'invalid_original');
	if (original.operation !== 'create') uuid(original.recordId); else if (original.recordId !== undefined) throw new CrmError('A creation cannot carry a record route.', 'invalid_original');
	return original;
}
function confirmed(original: OriginalIntent, data: IDataObject): IDataObject {
	try {
		if (original.resource === 'activity') {
			if (data.state !== 'confirmed') throw new Error('Unconfirmed state');
			uuid(data.activity_id); uuid(data.effect_id);
			if (data.activity !== null && object(data.activity).id !== data.activity_id) throw new Error('Identity mismatch');
		} else { uuid(data.id); if (data.state !== undefined && data.state !== 'confirmed' || data.confirmed === false || data.representation_available === false && data.confirmed !== true) throw new Error('Unconfirmed identity'); if (original.operation === 'move_stage' && data.id !== original.recordId) throw new Error('Identity mismatch'); if (data.confirmed !== undefined && data.confirmed !== true) throw new Error('Unconfirmed identity'); }
	} catch { throw new CrmError('The native response did not confirm the original effect. Use Original GET without another write.', 'unconfirmed_write', undefined, true, original); }
	return data;
}

export function createCrmClient(request: Requester, options: ClientOptions) {
	let parsed: URL;
	try {
		parsed = new URL(options.baseUrl);
	} catch {
		throw new CrmError(
			'Use the official Factuarea API base URL.',
			'invalid_api_host',
		);
	}
	if (
		parsed.protocol !== 'https:' ||
		parsed.hostname !== 'api.factuarea.com' ||
		(parsed.port && parsed.port !== '443') ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash ||
		!/^\/v1\/?$/.test(parsed.pathname)
	)
		throw new CrmError(
			'CRM credentials may only be sent to https://api.factuarea.com/v1.',
			'invalid_api_host',
		);
	const baseUrl = 'https://api.factuarea.com/v1';

	async function send(
		path: string,
		method: 'GET' | 'POST' | 'PATCH' = 'GET',
		qs?: IDataObject,
		original?: OriginalIntent,
	): Promise<{ body: IDataObject; headers: IDataObject }> {
		if (options.abortSignal?.aborted)
			throw new CrmError(
				'The n8n execution was cancelled before dispatch.',
				'execution_cancelled',
			);
		const wire: IHttpRequestOptions = {
			url: baseUrl + path,
			method,
			qs,
			json: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			allowedDomains: 'api.factuarea.com',
			timeout: 30000,
			abortSignal: options.abortSignal,
			headers: { Accept: 'application/json' },
		};
		if (original) {
			if (method !== 'GET') wire.body = original.wire;
			wire.json = false;
			wire.headers = {
				...wire.headers,
				'Idempotency-Key': original.idempotencyKey,
				...(method !== 'GET' ? {'Content-Type': 'application/json'} : {}),
			};
		}
		let response: IDataObject;
		try {
			response = object(await request(wire));
		} catch {
			throw new CrmError(
				original
					? 'The write outcome is unconfirmed. Recover the original request; do not create a replacement intent.'
					: 'Factuarea could not be reached.',
				original ? 'unconfirmed_write' : 'connection_error',
				undefined,
				Boolean(original),
				original,
			);
		}
		const status = response.statusCode;
		if (typeof status !== 'number')
			throw new CrmError(
				'Factuarea returned an invalid HTTP response.',
				'invalid_response',
				undefined,
				Boolean(original),
				original,
			);
		if (status < 200 || status >= 300) {
			const headers =
				response.headers && typeof response.headers === 'object'
					? object(response.headers)
					: {};
			const seconds = Number(headers['retry-after'] ?? headers['Retry-After']);
			let fields: string[] | undefined;
			if (status === 422) {
				const raw =
					response.body && typeof response.body === 'object'
						? object(response.body)
						: {};
				const errors =
					raw.errors && typeof raw.errors === 'object'
						? object(raw.errors)
						: {};
				fields = Object.keys(errors).filter((key) =>
					/^[a-zA-Z0-9_.]{1,100}$/.test(key),
				);
				if (raw.error && typeof raw.error === 'object') {
					const param = object(raw.error).param;
					if (typeof param === 'string' && /^[a-zA-Z0-9_.]{1,100}$/.test(param))
						fields.push(param);
				}
			}
			const messages: Record<number, [string, string]> = {
				401: [
					'The Factuarea credential is invalid or expired.',
					'authentication_failed',
				],
				403: [
					'Current CRM scope or authorization denies this operation.',
					'crm_access_denied',
				],
				404: [
					'The record is unavailable in the credential context.',
					'resource_not_found',
				],
				409: [
					'The original intent conflicts with the current revision or a previously used key. Preserve its key and expected version; review the conflict before recovery.',
					'crm_conflict',
				],
				422: [
					'The native operation rejected the request fields or business rule.',
					'validation_failed',
				],
				429: [
					'Factuarea rate-limited this request. Wait for Retry-After, then recover the saved original by GET only.',
					'rate_limited',
				],
			};
			if (status === 409) {
				const raw =
					response.body &&
					typeof response.body === 'object' &&
					!Array.isArray(response.body)
						? object(response.body)
						: {};
				const native =
					raw.error &&
					typeof raw.error === 'object' &&
					!Array.isArray(raw.error)
						? object(raw.error)
						: {};
				const conflicts: Record<string, [string, string]> = {
					crm_version_conflict: [
						'The original revision conflicts with the native record. Preserve its key and expected version and review the conflict.',
						'crm_version_conflict',
					],
					idempotency_key_reused: [
						'This key was already used with different content. Recover the actual original intent; do not reuse the key for changed content.',
						'idempotency_key_reused',
					],
					crm_effect_unconfirmed: [
						'The native original effect is still unconfirmed. Recover the original request without replacing its key or version.',
						'crm_effect_unconfirmed',
					],
				};
				if (
					typeof native.code === 'string' &&
					Object.hasOwn(conflicts, native.code)
				)
					messages[409] = conflicts[native.code]!;
			}
			const [message, code] = messages[status] ?? [
				status >= 500
					? original
						? 'The write may have reached Factuarea. Recover the original request.'
						: 'Factuarea is temporarily unavailable.'
					: 'Factuarea rejected this request.',
				status >= 500
					? original
						? 'unconfirmed_write'
						: 'server_error'
					: 'http_error',
			];
			throw new CrmError(
				message,
				code,
				status,
				Boolean(original) &&
					(status >= 500 || code === 'crm_effect_unconfirmed'),
				original,
				status === 429 && Number.isFinite(seconds) && seconds >= 0
					? seconds
					: undefined,
				fields,
			);
		}
		try {
			return {
				body: object(typeof response.body === 'string' ? JSON.parse(response.body) : response.body),
				headers: response.headers ? object(response.headers) : {},
			};
		} catch {
			throw new CrmError(
				'Factuarea returned an invalid response envelope.',
				'invalid_response',
				status,
				Boolean(original),
				original,
			);
		}
	}

	async function credential(requiredScope: string, expected?: CredentialContext): Promise<CredentialContext> {
		const oauth = options.authModel === 'oauth2';
		const {body} = await send(oauth ? '/crm/credential-context' : '/account');
		const data = object(body.data);
		let current: CredentialContext;
		let scopes: unknown;
		if (oauth) {
			closed(data, ['company_id','credential_id','client_id','environment','scopes','authorization_version']);
			if (Object.keys(data).length !== 6 || typeof data.authorization_version !== 'string' || !data.authorization_version)
				throw new CrmError('The native OAuth context is invalid.', 'invalid_context');
			current = {company: publicId(data.company_id), credential: publicId(data.credential_id), client: publicId(data.client_id), environment: data.environment as 'test'|'live', authModel: 'oauth2'};
			if (current.client !== options.clientId) throw new CrmError('The OAuth client binding changed.', 'credential_changed', 403);
			scopes = data.scopes;
		} else {
			const key = object(data.api_key);
			current = {company: publicId(object(data.company).id), credential: publicId(key.id), client: null, environment: key.environment as 'test'|'live', authModel: 'api_key'};
			scopes = key.scopes;
		}
		if (!['test','live'].includes(current.environment) || !Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string'))
			throw new CrmError('The native credential context is invalid.', 'invalid_context');
		for (const scope of [oauth ? 'crm_access_context:read' : 'account:read', requiredScope])
			if (!scopes.includes('*') && !scopes.includes(scope)) throw new CrmError('The current native scope is unavailable.', 'insufficient_scope', 403);
		if (expected && (expected.company !== current.company || expected.environment !== current.environment || expected.authModel !== current.authModel
			|| expected.client !== current.client || current.authModel === 'api_key' && expected.credential !== current.credential))
			throw new CrmError('The original credential or realm changed.', 'credential_changed', 403);
		return current;
	}

	async function access(
		operation: string,
		expected?: { version: string; sandbox: boolean },
	): Promise<AccessContext> {
		if (options.authModel === 'oauth2') await credential(scopeFor(operation));
		const { body } = await send('/crm/access-context');
		let context: AccessContext;
		try {
			context = object(body.data) as unknown as AccessContext;
			object(context.scope);
		} catch {
			throw new CrmError(
				'Factuarea returned an invalid CRM access context.',
				'invalid_context',
			);
		}
		if (
			typeof context.authorization_version !== 'string' ||
			!context.authorization_version ||
			typeof context.sandbox !== 'boolean' ||
			!['own', 'team', 'company'].includes(context.scope.mode) ||
			context.scope.authorization_version !== context.authorization_version ||
			!Array.isArray(context.availability)
		)
			throw new CrmError(
				'CRM authorization is denied or incoherent.',
				'crm_access_denied',
				403,
			);
		if (
			(options.environment === 'live' && context.sandbox) ||
			(options.environment === 'sandbox' && !context.sandbox)
		)
			throw new CrmError(
				'The credential environment differs from the selected environment.',
				'environment_mismatch',
				403,
			);
		if (
			expected &&
			(context.authorization_version !== expected.version ||
				context.sandbox !== expected.sandbox)
		)
			throw new CrmError(
				'CRM authorization changed. Discard this result and restart with the current credential context.',
				'crm_context_changed',
				403,
			);
		const entries = context.availability.filter(
			(entry) => entry && entry.operation === operation,
		);
		if (
			entries.length !== 1 ||
			entries[0]?.available !== true ||
			(context.sandbox && entries[0].sandbox_policy === 'blocked')
		)
			throw new CrmError(
				'This CRM operation is unavailable for the current credential, plan or environment.',
				'crm_operation_unavailable',
				403,
			);
		return context;
	}

	async function cursorList(
		path: string,
		operation: string,
		itemKey: string,
		hasMore: boolean,
		query: IDataObject,
		maximum: number,
		all: boolean,
	): Promise<IDataObject[]> {
		positiveInteger(maximum, 10000);
		const limit = Math.min(100, maximum);
		const output: IDataObject[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		let expected: { version: string; sandbox: boolean } | undefined;
		for (;;) {
			const context = await access(operation, expected);
			expected = {
				version: context.authorization_version,
				sandbox: context.sandbox,
			};
			const { body } = await send(path, 'GET', {
				...query,
				limit,
				...(cursor ? { cursor } : {}),
			});
			const page = object(body.data);
			if (
				!Array.isArray(page[itemKey]) ||
				(page.next_cursor !== null &&
					(typeof page.next_cursor !== 'string' || !page.next_cursor)) ||
				(hasMore &&
					(typeof page.has_more !== 'boolean' ||
						page.has_more !== (page.next_cursor !== null)))
			)
				throw new CrmError(
					'Factuarea returned an invalid cursor page.',
					'invalid_pagination',
				);
			if (
				(page[itemKey] as unknown[]).length === 0 &&
				page.next_cursor !== null
			)
				throw new CrmError(
					'Factuarea returned an empty cursor page with more results.',
					'invalid_pagination',
				);
			for (const item of page[itemKey] as unknown[]) {
				const row = object(item);
				uuid(row.id);
				output.push(row);
				if (output.length === maximum) return output;
			}
			if (!all || page.next_cursor === null) return output;
			cursor = page.next_cursor as string;
			if (seen.has(cursor))
				throw new CrmError(
					'Factuarea repeated a pagination cursor.',
					'invalid_pagination',
				);
			seen.add(cursor);
		}
	}

	async function contacts(
		search: string,
		maximum: number,
		all = true,
		selector = false,
	): Promise<IDataObject[]> {
		positiveInteger(maximum, 10000);
		const output: IDataObject[] = [];
		let expected: { version: string; sandbox: boolean } | undefined;
		for (let page = 1; ; page++) {
			const context = await access(
				selector ? 'crm_contact_people.options' : 'crm_contact_people.index',
				expected,
			);
			expected = {
				version: context.authorization_version,
				sandbox: context.sandbox,
			};
			const { body } = await send(
				selector ? '/crm/contact-people/options' : '/crm/contact-people',
				'GET',
				selector
					? { kind: 'people', search, page }
					: { search, page, per_page: 100 },
			);
			const meta = object(body.meta);
			if (
				!Array.isArray(body.data) ||
				meta.current_page !== page ||
				typeof meta.total !== 'number' ||
				!Number.isSafeInteger(meta.total) ||
				meta.total < 0 ||
				(!selector &&
					(typeof meta.per_page !== 'number' || meta.per_page !== 100))
			)
				throw new CrmError(
					'Factuarea returned an invalid contact page.',
					'invalid_pagination',
				);
			const rows = body.data as unknown[];
			if (
				rows.length > (selector ? 25 : 100) ||
				(!rows.length && output.length < meta.total)
			)
				throw new CrmError(
					'Factuarea returned an incomplete contact page.',
					'invalid_pagination',
				);
			for (const item of rows) {
				const row = object(item);
				uuid(row.id);
				output.push(row);
				if (output.length === maximum) return output;
			}
			if (!all || output.length >= meta.total) return output;
		}
	}

	return {
		async get(resource: Resource, id: string): Promise<IDataObject> {
			uuid(id);
			await access(resources[resource].operations.get);
			const { body } = await send(`${resources[resource].path}/${id}`);
			return object(body.data);
		},
		async list(
			resource: Resource,
			filters: unknown,
			maximum: number,
			all = true,
		): Promise<IDataObject[]> {
			const definition = resources[resource];
			const native = jsonObject(filters);
			validateIds(native);
			return cursorList(
				definition.path,
				definition.operations.list,
				definition.itemKey,
				definition.hasMore,
				{ filters: JSON.stringify(native) },
				maximum,
				all,
			);
		},
		contacts,
		async prepare(
			resource: Resource,
			operation: WriteOperation,
			body: IDataObject,
			key: string,
			id?: string,
		): Promise<OriginalIntent> {
			validateBody(resource, operation, body);
			originalKey(key);
			if (operation !== 'create') uuid(id);
			const wire = JSON.stringify(body);
			const context = await access(operationFor(resource, operation));
			const nativeBinding = await credential(scopeFor(operationFor(resource, operation)));
			if ((nativeBinding.environment === 'test') !== context.sandbox) throw new CrmError('The native credential realm changed.', 'environment_mismatch', 403);
			const original: OriginalIntent = {
				protocol: 'factuarea-crm-prepared-v2',
				resource,
				operation,
				baseUrl,
				credentialId: options.credentialId,
				authorizationVersion: context.authorization_version,
				sandbox: context.sandbox,
				createdAt: Date.now(),
				idempotencyKey: key,
				...(id ? { recordId: id } : {}),
				body: JSON.parse(wire) as IDataObject, wire, sha256: createHash('sha256').update(wire, 'utf8').digest('hex'), nativeBinding,
			};
			return original;
		},
		async submit(value: unknown): Promise<IDataObject> {
			const original = prepared(value);
			if (original.credentialId !== options.credentialId) throw new CrmError('The saved n8n credential changed.', 'credential_changed', 403);
			const context = await access(operationFor(original.resource, original.operation));
			if (context.sandbox !== original.sandbox) throw new CrmError('The original realm changed.', 'environment_mismatch', 403);
			const current = await credential(scopeFor(operationFor(original.resource, original.operation)), original.nativeBinding);
			if (current.credential !== original.nativeBinding.credential) throw new CrmError('Credential changed after Prepare. Recover the saved original by GET only.', 'credential_changed', 403);
			return dispatch(original);
		},
		async recover(value: unknown): Promise<IDataObject> {
			const original = prepared(value);
			if (original.credentialId !== options.credentialId) throw new CrmError('The saved n8n credential changed.', 'credential_changed', 403);
			if (original.operation === 'update') throw new CrmError('This update has no canonical Original GET route. Preserve the original for native review; do not redispatch PATCH.', 'original_unavailable');
			const context = await access(operationFor(original.resource, original.operation));
			if (context.sandbox !== original.sandbox) throw new CrmError('The original realm changed.', 'environment_mismatch', 403);
			await credential(scopeFor(operationFor(original.resource, original.operation)), original.nativeBinding);
			const {body} = await send(resources[original.resource].path + (original.operation === 'move_stage' ? '/' + original.recordId + '/stage/original' : '/create/original'), 'GET', {original_body_sha256: original.sha256}, original);
			const meta = object(body.meta), receipt = object(body.data);
			closed(receipt, ['state','original_body_sha256','original_response']);
			if (typeof meta.authorization_version !== 'string' || !meta.authorization_version || receipt.original_body_sha256 !== original.sha256
				|| !['confirmed','pending','in_progress','unconfirmed','missing'].includes(String(receipt.state))) throw new CrmError('The original receipt is invalid.', 'invalid_original');
			if (receipt.state !== 'confirmed') throw new CrmError('The original effect is not confirmed. This state never authorizes another POST.', 'original_' + String(receipt.state), undefined, true, original);
			const response = object(receipt.original_response);
			if (!Number.isSafeInteger(response.status) || (response.status as number) < 200 || (response.status as number) >= 300 || typeof response.body !== 'string')
				throw new CrmError('The original HTTP response is invalid.', 'invalid_original');
			let frozen: IDataObject;
			try { frozen = object(JSON.parse(response.body)); } catch { throw new CrmError('The original response body is invalid.', 'invalid_original'); }
			const result = confirmed(original, object(frozen.data));
			return {...result, _factuarea: {confirmed: true, recovered: true, idempotencyKey: original.idempotencyKey,
				originalHttpStatus: response.status, originalResponseBody: response.body, originalBodySha256: original.sha256, authorizationVersion: meta.authorization_version}};
		},
		async options(
			kind: 'pipelines' | 'stages' | 'leads' | 'people' | 'opportunities',
			pipelineId?: string,
		): Promise<INodePropertyOptions[]> {
			let rows: IDataObject[];
			if (kind === 'stages') {
				uuid(pipelineId);
				await access('crm_pipelines.show');
				const { body } = await send(`/crm/pipelines/${pipelineId}`);
				const pipeline = object(body.data);
				if (!Array.isArray(pipeline.stages))
					throw new CrmError(
						'Factuarea returned an invalid pipeline.',
						'invalid_response',
					);
				rows = pipeline.stages.map(object);
			} else if (kind === 'people') rows = await contacts('', 1000, true, true);
			else if (kind === 'opportunities')
				rows = await cursorList(
					'/crm/opportunity',
					'crm_opportunities.list',
					'items',
					false,
					{},
					1000,
					true,
				);
			else
				rows = await cursorList(
					kind === 'pipelines' ? '/crm/pipelines' : '/crm/leads',
					kind === 'pipelines' ? 'crm_pipelines.index' : 'crm_leads.index',
					kind === 'pipelines' ? 'items' : 'data',
					true,
					{},
					1000,
					true,
				);
			return rows
				.filter((row) => row.status !== 'archived')
				.map((row) => ({
					name: String(row.name ?? row.label ?? row.title ?? uuid(row.id)),
					value: uuid(row.id),
				}));
		},
	};

	async function dispatch(original: OriginalIntent): Promise<IDataObject> {
		const { body, headers } = await send(
			resources[original.resource].path +
				(original.operation === 'move_stage' ? `/${original.recordId}/stage` : original.operation === 'update' ? `/${original.recordId}` : ''),
			original.operation === 'update' ? 'PATCH' : 'POST',
			undefined,
			original,
		);
		const data = confirmed(original, object(body.data));
		return {
			...data,
			_factuarea: {
				confirmed: true,
				replayed:
					headers['idempotent-replayed'] === 'true' ||
					headers['Idempotent-Replayed'] === 'true',
				idempotencyKey: original.idempotencyKey,
			},
		};
	}
}
