import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { createCrmClient } from './client';
import {
	CrmError,
	jsonObject,
	object,
	positiveInteger,
	resources,
} from './contract';
import type { ClientOptions, Resource } from './contract';
import { crmProperties } from './properties';

async function client(
	context: IExecuteFunctions | ILoadOptionsFunctions,
	environment: unknown,
) {
	if (!['credential', 'live', 'sandbox'].includes(String(environment)))
		throw new CrmError(
			'Choose a credential environment.',
			'invalid_environment',
		);
	const authentication = 'getInputData' in context ? context.getNodeParameter('authentication', 0, 'apiKey') : context.getNodeParameter('authentication', 'apiKey');
	if (authentication !== 'apiKey' && authentication !== 'oauth2') throw new CrmError('Choose the original registered authentication type.', 'invalid_authentication');
	const credentialType = authentication === 'oauth2' ? 'factuareaCrmOAuth2Api' : 'factuareaApi';
	const credentials = await context.getCredentials(credentialType);
	const tokenData = credentials.oauthTokenData;
	const selectedBearer = authentication === 'oauth2'
		? tokenData && typeof tokenData === 'object' ? object(tokenData).access_token : undefined
		: credentials.apiKey;
	if (authentication === 'oauth2') {
		const issuer = new URL(String(credentials.issuer));
		if (issuer.protocol !== 'https:' || issuer.origin !== credentials.issuer || issuer.username || issuer.password) throw new CrmError('Choose the actual registered HTTPS OAuth issuer.', 'invalid_credential');
	}
	if (typeof credentials.baseUrl !== 'string')
		throw new CrmError(
			'Select a Factuarea API credential.',
			'invalid_credential',
		);
	return createCrmClient(
		async (options) => {
			if (options.method !== 'GET') {
				const current = await context.getCredentials(credentialType);
				const actual = authentication === 'oauth2' ? object(current.oauthTokenData).access_token : current.apiKey;
				if (typeof actual !== 'string' || !actual || actual.length > 8192 || /[\x00-\x20\x7f]/.test(actual) || actual !== selectedBearer) throw new CrmError('Credential changed during Submit. Preserve the original and recover by GET only.', 'credential_changed', 403);
				if (authentication !== 'oauth2' && !/^fact_(live|test)_[A-Za-z0-9]{24}$/.test(actual)) throw new CrmError('Use the genuine native API key.', 'invalid_credential');
				// Pin the credential actually observed before preflight; mutable transport never refreshes or replays.
				return context.helpers.httpRequest({...options, headers: {...options.headers, Authorization: 'Bearer ' + actual}});
			}
			return context.helpers.httpRequestWithAuthentication.call(
				context,
				credentialType,
				options,
			);
		},
		{
			baseUrl: credentials.baseUrl,
			credentialId: context.getNode().credentials?.[credentialType]?.id ?? '',
			authModel: authentication === 'oauth2' ? 'oauth2' : 'api_key',
			clientId: authentication === 'oauth2' ? String(credentials.clientId) : undefined,
			environment: environment as ClientOptions['environment'],
			abortSignal:
				'getExecutionCancelSignal' in context
					? context.getExecutionCancelSignal()
					: undefined,
		},
	);
}

export class FactuareaCrm implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Factuarea CRM',
		name: 'factuareaCrm',
		icon: 'file:factuarea.svg',
		group: ['transform'],
		version: 1,
		description: 'Create, read and update native Factuarea CRM records',
		defaults: { name: 'Factuarea CRM' },
		inputs: ['main'],
		outputs: ['main'],
		credentials: [
			{name: 'factuareaApi', required: true, displayOptions: {show: {authentication: ['apiKey']}}},
			{name: 'factuareaCrmOAuth2Api', required: true, displayOptions: {show: {authentication: ['oauth2']}}},
		],
		properties: crmProperties,
	};

	methods = {
		loadOptions: {
			async getPipelines(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return (
					await client(this, this.getNodeParameter('environment', 'credential'))
				).options('pipelines');
			},
			async getStages(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				return (
					await client(this, this.getNodeParameter('environment', 'credential'))
				).options('stages', String(this.getNodeParameter('pipelineId', '')));
			},
			async getTargets(
				this: ILoadOptionsFunctions,
			): Promise<INodePropertyOptions[]> {
				const target = this.getNodeParameter('targetType', 'lead');
				if (!['lead', 'opportunity', 'person'].includes(String(target)))
					throw new CrmError('Choose a native target type.', 'invalid_target');
				return (
					await client(this, this.getNodeParameter('environment', 'credential'))
				).options(
					target === 'person'
						? 'people'
						: target === 'opportunity'
							? 'opportunities'
							: 'leads',
				);
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const output: INodeExecutionData[] = [];
		for (let index = 0; index < this.getInputData().length; index++) {
			try {
				const resource = String(this.getNodeParameter('resource', index));
				const operation = String(this.getNodeParameter('operation', index));
				if (['create','update','moveStage'].includes(operation) && this.getNode().retryOnFail === true) throw new CrmError('Disable Retry On Fail for Submit. Recover uncertain originals by GET only.', 'unsafe_write_retry');
				if (resource !== 'contact' && !Object.hasOwn(resources, resource))
					throw new CrmError(
						'Choose a native CRM resource.',
						'invalid_resource',
					);
				const api = await client(
					this,
					this.getNodeParameter('environment', index, 'credential'),
				);
				let result: IDataObject | IDataObject[];
				if (resource === 'contact' && operation === 'search')
					result = await api.contacts(
						String(this.getNodeParameter('search', index, '')),
						positiveInteger(
							this.getNodeParameter('maximumItems', index, 1000),
							10000,
						),
						Boolean(this.getNodeParameter('returnAll', index, true)),
					);
				else if (resource === 'contact')
					throw new CrmError(
						'Contact people support Search.',
						'invalid_operation',
					);
				else if (operation === 'recover') {
					const original = jsonObject(this.getNodeParameter('original', index));
					if (original.resource !== resource)
						throw new CrmError(
							'Select the resource of the original request.',
							'invalid_original',
						);
					result = await api.recover(original);
				} else if (operation === 'create' || operation === 'update' || operation === 'moveStage') {
					const saved = jsonObject(this.getNodeParameter('prepared', index));
					if (saved.resource !== resource || saved.operation !== (operation === 'moveStage' ? 'move_stage' : operation)) throw new CrmError('Select the resource and operation from Prepare.', 'invalid_original');
					result = await api.submit(saved);
				} else if (operation === 'get')
					result = await api.get(
						resource as Resource,
						String(this.getNodeParameter('recordId', index)),
					);
				else if (operation === 'list')
					result = await api.list(
						resource as Resource,
						this.getNodeParameter('filters', index, '{}'),
						positiveInteger(
							this.getNodeParameter('maximumItems', index, 1000),
							10000,
						),
						Boolean(this.getNodeParameter('returnAll', index, true)),
					);
				else if (operation === 'prepareCreate' || operation === 'prepareUpdate' || operation === 'prepareMoveStage') {
					let body: IDataObject;
					if (operation === 'prepareUpdate') {
						const changes = jsonObject(this.getNodeParameter('changes', index));
						const version = positiveInteger(
							this.getNodeParameter('expectedVersion', index),
						);
						body =
							resource === 'lead'
								? { ...changes, expected_version: version }
								: { expected_version: version, changes };
					} else {
						body = jsonObject(this.getNodeParameter('body', index));
						if (resource === 'opportunity' && operation === 'prepareCreate') {
							body = {
								...body,
								pipeline_id: this.getNodeParameter(
									'pipelineId',
									index,
								) as string,
								stage_id: this.getNodeParameter('stageId', index) as string,
							};
						}
						if (resource === 'activity') {
							body = {
								...body,
								target: {
									type: this.getNodeParameter('targetType', index) as string,
									id: this.getNodeParameter('targetId', index) as string,
								},
							};
						}
					}
					const saved = await api.prepare(
						resource as Resource,
						operation === 'prepareMoveStage' ? 'move_stage' : operation === 'prepareUpdate' ? 'update' : 'create',
						body,
						String(this.getNodeParameter('idempotencyKey', index)),
						operation !== 'prepareCreate'
							? String(this.getNodeParameter('recordId', index))
							: undefined,
					);
					result = {prepared: JSON.stringify(saved), originalRequestBody: saved.wire, originalBodySha256: saved.sha256, idempotencyKey: saved.idempotencyKey};
				} else
					throw new CrmError(
						'Choose a supported native operation.',
						'invalid_operation',
					);
				for (const row of Array.isArray(result) ? result : [result])
					output.push({ json: object(row), pairedItem: { item: index } });
			} catch (error) {
				const safe =
					error instanceof CrmError
						? error
						: new CrmError(
								'Factuarea CRM could not complete this item.',
								'crm_error',
							);
				if (!this.continueOnFail()) throw safe;
				output.push({
					json: { error: safe.toJSON() },
					pairedItem: { item: index },
				});
			}
		}
		return [output];
	}
}
