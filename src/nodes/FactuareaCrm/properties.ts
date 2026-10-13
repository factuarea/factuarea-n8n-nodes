import type { INodeProperties } from 'n8n-workflow';

export const crmProperties: INodeProperties[] = [
	{displayName: 'Authentication', name: 'authentication', type: 'options', default: 'apiKey', options: [{name: 'API Key', value: 'apiKey'}, {name: 'Native CRM OAuth2', value: 'oauth2'}]},
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		default: 'lead',
		options: [
			{ name: 'Lead', value: 'lead' },
			{ name: 'Opportunity', value: 'opportunity' },
			{ name: 'Activity', value: 'activity' },
			{ name: 'Contact Person', value: 'contact' },
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'create',
		displayOptions: { show: { resource: ['lead', 'opportunity', 'activity'] } },
		options: [
			{ name: 'Prepare Create', value: 'prepareCreate', action: 'Prepare an immutable CRM creation' },
			{ name: 'Submit Prepared Create', value: 'create', action: 'Submit a prepared CRM creation once' },
			{ name: 'Get', value: 'get', action: 'Get a CRM record' },
			{ name: 'Get Many', value: 'list', action: 'Get many CRM records' },
			{
				name: 'Recover Original',
				value: 'recover',
				action: 'Recover the original CRM write',
			},
			{name: 'Prepare Move Stage (Opportunity)', value: 'prepareMoveStage', action: 'Prepare an Opportunity stage movement'},
			{name: 'Submit Prepared Move Stage (Opportunity)', value: 'moveStage', action: 'Submit a prepared Opportunity stage movement'},
			{ name: 'Prepare Update', value: 'prepareUpdate', action: 'Prepare an immutable CRM update' },
			{ name: 'Submit Prepared Update', value: 'update', action: 'Submit a prepared CRM update once' },
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'search',
		displayOptions: { show: { resource: ['contact'] } },
		options: [
			{ name: 'Search', value: 'search', action: 'Search contact people' },
		],
	},
	{
		displayName: 'Expected Environment',
		name: 'environment',
		type: 'options',
		default: 'credential',
		options: [
			{ name: 'Credential Environment', value: 'credential' },
			{ name: 'Live', value: 'live' },
			{ name: 'Sandbox', value: 'sandbox' },
		],
		description:
			'Checks the native credential environment. This setting never changes company or realm.',
	},
	{
		displayName: 'Record ID',
		name: 'recordId',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				operation: ['get', 'prepareUpdate','prepareMoveStage'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description: 'Public UUID v7 returned as id by Factuarea',
	},
	{
		displayName: 'Creation Fields (JSON)',
		name: 'body',
		type: 'json',
		default: '{}',
		required: true,
		displayOptions: {
			show: {
				operation: ['prepareCreate','prepareMoveStage'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description:
			'Native creation fields. Lead: name/email/phone. Opportunity: title, amount as a string and currency. Activity: type, title and timezone. Do not include authority or internal UUID fields.',
	},
	{
		displayName: 'Pipeline Name or ID',
		name: 'pipelineId',
		type: 'options',
		default: '',
		required: true,
		typeOptions: { loadOptionsMethod: 'getPipelines' },
		displayOptions: {
			show: { operation: ['prepareCreate'], resource: ['opportunity'] },
		},
		description:
			'Choose from the current credential context, or provide a public ID using an expression',
	},
	{
		displayName: 'Stage Name or ID',
		name: 'stageId',
		type: 'options',
		default: '',
		required: true,
		typeOptions: {
			loadOptionsMethod: 'getStages',
			loadOptionsDependsOn: ['pipelineId'],
		},
		displayOptions: {
			show: { operation: ['prepareCreate'], resource: ['opportunity'] },
		},
		description: 'Stage belonging to the selected pipeline',
	},
	{
		displayName: 'Target Type',
		name: 'targetType',
		type: 'options',
		default: 'lead',
		options: [
			{ name: 'Lead', value: 'lead' },
			{ name: 'Opportunity', value: 'opportunity' },
			{ name: 'Person', value: 'person' },
		],
		displayOptions: { show: { operation: ['prepareCreate'], resource: ['activity'] } },
	},
	{
		displayName: 'Target Name or ID',
		name: 'targetId',
		type: 'options',
		default: '',
		required: true,
		typeOptions: {
			loadOptionsMethod: 'getTargets',
			loadOptionsDependsOn: ['targetType'],
		},
		displayOptions: { show: { operation: ['prepareCreate'], resource: ['activity'] } },
		description:
			'Choose an authorized target, or provide a public ID using an expression',
	},
	{
		displayName: 'Changes (JSON)',
		name: 'changes',
		type: 'json',
		default: '{}',
		required: true,
		displayOptions: {
			show: {
				operation: ['prepareUpdate'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description:
			'Only native editable fields. Omitted fields remain omitted; null is sent as null.',
	},
	{
		displayName: 'Expected Version',
		name: 'expectedVersion',
		type: 'number',
		default: 1,
		required: true,
		typeOptions: { minValue: 1 },
		displayOptions: {
			show: {
				operation: ['prepareUpdate'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description:
			'Exact version read for this intent. A conflict never refreshes it automatically.',
	},
	{
		displayName: 'Idempotency Key',
		name: 'idempotencyKey',
		type: 'string',
		default: '',
		required: true,
		displayOptions: {
			show: {
				operation: ['prepareCreate', 'prepareUpdate','prepareMoveStage'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description:
			'Stable key unique to this source item and operation. Keep it unchanged across retries. Never use a key shared by different items.',
	},
	{displayName: 'Prepared Request (JSON)', name: 'prepared', type: 'json', default: '{}', required: true, displayOptions: {show: {operation: ['create', 'update','moveStage']}}, description: 'The saved output from Prepare. The exact bytes and key are sent once. After uncertainty or OAuth renewal use Original GET.'},
	{
		displayName: 'Original Request (JSON)',
		name: 'original',
		type: 'json',
		default: '{}',
		required: true,
		displayOptions: {
			show: {
				operation: ['recover'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description:
			'The saved Prepare snapshot or error.original. Queries the canonical Original GET only. Missing or pending never authorizes another write; updates without an Original GET stay unavailable.',
	},
	{
		displayName: 'Filters (JSON)',
		name: 'filters',
		type: 'json',
		default: '{}',
		displayOptions: {
			show: {
				operation: ['list'],
				resource: ['lead', 'opportunity', 'activity'],
			},
		},
		description:
			'Native public filter object. The same filters are retained on every cursor page.',
	},
	{
		displayName: 'Search',
		name: 'search',
		type: 'string',
		default: '',
		displayOptions: { show: { operation: ['search'], resource: ['contact'] } },
		description:
			'Search text evaluated under current record and private-field policy',
	},
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: true,
		displayOptions: { show: { operation: ['list', 'search'] } },
		description: 'Whether to follow every authorized page up to Maximum Items',
	},
	{
		displayName: 'Maximum Items',
		name: 'maximumItems',
		type: 'number',
		default: 1000,
		typeOptions: { minValue: 1, maxValue: 10000 },
		displayOptions: { show: { operation: ['list', 'search'] } },
		description:
			'Explicit total cap per input item. Get Many uses pages of up to 100 records.',
	},
];
