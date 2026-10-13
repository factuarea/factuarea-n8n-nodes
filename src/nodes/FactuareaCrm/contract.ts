import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';

export type Resource = 'lead' | 'opportunity' | 'activity';
export type WriteOperation = 'create' | 'update' | 'move_stage';
export type Requester = (options: IHttpRequestOptions) => Promise<unknown>;

export const resources = {
	lead: {
		path: '/crm/leads',
		operations: {
			list: 'crm_leads.index',
			get: 'crm_leads.show',
			create: 'crm_leads.create',
			update: 'crm_leads.update',
		},
		itemKey: 'data',
		hasMore: true,
	},
	opportunity: {
		path: '/crm/opportunity',
		operations: {
			list: 'crm_opportunities.list',
			get: 'crm_opportunities.show',
			create: 'crm_opportunities.create',
			update: 'crm_opportunities.update',
		},
		itemKey: 'items',
		hasMore: false,
	},
	activity: {
		path: '/crm/crmactivity',
		operations: {
			list: 'crm_activities.index',
			get: 'crm_activities.show',
			create: 'crm_activities.create',
			update: 'crm_activities.update',
		},
		itemKey: 'items',
		hasMore: false,
	},
} as const;

export interface OriginalIntent {
	protocol: 'factuarea-crm-prepared-v2';
	resource: Resource;
	operation: WriteOperation;
	baseUrl: string;
	credentialId: string;
	authorizationVersion: string;
	sandbox: boolean;
	createdAt: number;
	idempotencyKey: string;
	recordId?: string;
	body: IDataObject;
	wire: string;
	sha256: string;
	nativeBinding: CredentialContext;
}

export interface CredentialContext {
	company: string; credential: string; client: string | null; environment: 'test' | 'live'; authModel: 'api_key' | 'oauth2';
}

export interface AccessContext {
	authorization_version: string;
	sandbox: boolean;
	scope: { mode: string; authorization_version: string };
	availability: Array<{
		operation: string;
		available: boolean;
		sandbox_policy: string;
	}>;
}

export interface ClientOptions {
	baseUrl: string;
	credentialId: string;
	environment: 'credential' | 'live' | 'sandbox';
	authModel?: 'api_key' | 'oauth2';
	clientId?: string;
	abortSignal?: IHttpRequestOptions['abortSignal'];
}

export class CrmError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly status?: number,
		readonly unconfirmed = false,
		readonly original?: OriginalIntent,
		readonly retryAfterSeconds?: number,
		readonly fields?: string[],
	) {
		super(message);
		this.name = 'FactuareaCrmError';
	}

	toJSON(): IDataObject {
		return JSON.parse(
			JSON.stringify({
				message: this.message,
				code: this.code,
				status: this.status,
				unconfirmed: this.unconfirmed,
				original: this.original,
				retryAfterSeconds: this.retryAfterSeconds,
				fields: this.fields,
			}),
		) as IDataObject;
	}
}

export function object(value: unknown): IDataObject {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new CrmError('Expected a JSON object.', 'invalid_json');
	return value as IDataObject;
}

export function jsonObject(value: unknown): IDataObject {
	if (typeof value !== 'string') return object(value);
	try {
		return object(JSON.parse(value));
	} catch {
		throw new CrmError(
			'Enter valid JSON containing an object.',
			'invalid_json',
		);
	}
}

export function uuid(value: unknown): string {
	if (
		typeof value !== 'string' ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
	)
		throw new CrmError('Use a public UUID v7 record ID.', 'invalid_record_id');
	return value;
}

export function positiveInteger(
	value: unknown,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (
		typeof value !== 'number' ||
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > maximum
	)
		throw new CrmError(
			'Enter a positive integer within the allowed range.',
			'invalid_integer',
		);
	return value;
}

export function originalKey(value: unknown): string {
	if (typeof value !== 'string' || !/^[\x20-\x7e]{1,255}$/.test(value) || value.startsWith(' ') || value.endsWith(' '))
		throw new CrmError(
			'Use a stable, non-empty Idempotency-Key of at most 255 printable ASCII characters.',
			'invalid_idempotency_key',
		);
	return value;
}
