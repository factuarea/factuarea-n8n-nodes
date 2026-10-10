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
	const credentials = await context.getCredentials('factuareaApi');
	if (typeof credentials.baseUrl !== 'string')
		throw new CrmError(
			'Select a Factuarea API credential.',
			'invalid_credential',
		);
	return createCrmClient(
		(options) =>
			context.helpers.httpRequestWithAuthentication.call(
				context,
				'factuareaApi',
				options,
			),
		{
			baseUrl: credentials.baseUrl,
			credentialId: context.getNode().credentials?.factuareaApi?.id ?? '',
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
		credentials: [{ name: 'factuareaApi', required: true }],
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
				else if (operation === 'create' || operation === 'update') {
					let body: IDataObject;
					if (operation === 'update') {
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
						if (resource === 'opportunity') {
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
					result = await api.write(
						resource as Resource,
						operation,
						body,
						String(this.getNodeParameter('idempotencyKey', index)),
						operation === 'update'
							? String(this.getNodeParameter('recordId', index))
							: undefined,
					);
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
