import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
} from 'n8n-workflow';
import { createCrmClient } from '../src/nodes/FactuareaCrm/client';
import { CrmError, resources } from '../src/nodes/FactuareaCrm/contract';
import type {
	OriginalIntent,
	Resource,
} from '../src/nodes/FactuareaCrm/contract';
import { FactuareaCrm } from '../src/nodes/FactuareaCrm/FactuareaCrm.node';
import recipe from '../docs/recipes/web-lead-follow-up.workflow.json';

const BASE_URL = 'https://api.factuarea.com/v1';
const ID = '019251c0-0000-7000-8000-000000000001';
const NEXT_ID = '019251c0-0000-7000-8000-000000000002';
const PIPELINE = '019251c0-0000-7000-8000-000000000003';
const STAGE = '019251c0-0000-7000-8000-000000000004';
const EFFECT = '019251c0-0000-7000-8000-000000000005';
const operations = [
	...Object.values(resources).flatMap((resource) =>
		Object.values(resource.operations),
	),
	'crm_pipelines.index',
	'crm_pipelines.show',
	'crm_contact_people.index',
	'crm_contact_people.options',
];

function access(overrides: IDataObject = {}): IDataObject {
	return {
		data: {
			scope: {
				mode: 'company',
				owner_ids: [],
				team_ids: [],
				authorization_version: 'c7-fixture',
			},
			authorization_version: 'c7-fixture',
			sandbox: false,
			availability: operations.map((operation) => ({
				operation,
				available: true,
				sandbox_policy: 'allow_local',
			})),
			...overrides,
		},
	};
}

function answer(
	body: unknown,
	statusCode = 200,
	headers: IDataObject = {},
): IDataObject {
	return { statusCode, body: body as IDataObject, headers };
}

function programmed(...answers: unknown[]) {
	const calls: IHttpRequestOptions[] = [];
	const queue = [...answers];
	const request = async (options: IHttpRequestOptions): Promise<unknown> => {
		calls.push(options);
		assert.ok(queue.length, 'unexpected native HTTP request');
		const next = queue.shift();
		if (next instanceof Error) throw next;
		return next;
	};
	return { calls, request, remaining: () => queue.length };
}

function client(double: ReturnType<typeof programmed>, options = {}) {
	return createCrmClient(double.request, {
		baseUrl: BASE_URL,
		credentialId: 'credential-1',
		environment: 'credential',
		...options,
	});
}

function createBody(resource: Resource): IDataObject {
	if (resource === 'lead')
		return { name: 'Inbound lead', email: 'visible@example.test' };
	if (resource === 'opportunity')
		return {
			title: 'Inbound opportunity',
			pipeline_id: PIPELINE,
			stage_id: STAGE,
			amount: '125.0040',
			currency: 'EUR',
		};
	return {
		type: 'task',
		title: 'Follow up',
		target: { type: 'lead', id: ID },
		timezone: 'Europe/Madrid',
	};
}

function writeResponse(resource: Resource): IDataObject {
	return {
		data:
			resource === 'activity'
				? {
						state: 'confirmed',
						effect_id: EFFECT,
						activity_id: ID,
						activity: { id: ID, version: 2, title: 'Follow up', body: null },
					}
				: resource === 'lead'
					? { id: ID, version: 2, name: null }
					: { id: ID, version: 2, title: null },
	};
}

function page(
	resource: Resource,
	ids: string[],
	cursor: string | null,
): IDataObject {
	return {
		data: {
			[resources[resource].itemKey]: ids.map((id) => ({ id, name: null })),
			next_cursor: cursor,
			...(resources[resource].hasMore ? { has_more: cursor !== null } : {}),
			limit: 100,
		},
	};
}

async function capturedOriginal(
	resource: Resource = 'lead',
): Promise<OriginalIntent> {
	const double = programmed(
		answer(access()),
		new Error('private transport details'),
	);
	try {
		await client(double).write(
			resource,
			'create',
			createBody(resource),
			'source-item-1:create',
		);
	} catch (error) {
		assert.ok(error instanceof CrmError);
		assert.ok(error.original);
		return error.original;
	}
	throw new Error('The test did not produce an unconfirmed original.');
}

describe('Factuarea CRM native transport', () => {
	for (const resource of ['lead', 'opportunity', 'activity'] as const) {
		it(`creates ${resource} through its native endpoint and original key`, async () => {
			const double = programmed(
				answer(access()),
				answer(writeResponse(resource), 201),
			);
			const body = createBody(resource);
			const result = await client(double).write(
				resource,
				'create',
				body,
				'source-item-1:create',
			);
			assert.equal(double.calls[0]?.url, BASE_URL + '/crm/access-context');
			assert.equal(double.calls[1]?.url, BASE_URL + resources[resource].path);
			assert.equal(double.calls[1]?.method, 'POST');
			assert.deepEqual(double.calls[1]?.body, body);
			assert.equal(
				double.calls[1]?.headers?.['Idempotency-Key'],
				'source-item-1:create',
			);
			assert.equal(double.calls[1]?.disableFollowRedirect, true);
			assert.equal(
				double.calls[1]?.sendCredentialsOnCrossOriginRedirect,
				false,
			);
			assert.equal(double.calls[1]?.allowedDomains, 'api.factuarea.com');
			assert.equal(double.calls[1]?.timeout, 30000);
			assert.equal((result._factuarea as IDataObject).confirmed, true);
			assert.equal(double.remaining(), 0);
		});

		it(`reads ${resource} without materializing omitted private fields`, async () => {
			const data =
				resource === 'activity'
					? { activity: { id: ID, body: null }, comments: [], attachments: [] }
					: { id: ID, name: null };
			const double = programmed(answer(access()), answer({ data }));
			assert.deepEqual(await client(double).get(resource, ID), data);
			assert.equal(
				double.calls[1]?.url,
				`${BASE_URL}${resources[resource].path}/${ID}`,
			);
			assert.equal(double.calls[1]?.method, 'GET');
		});

		it(`paginates ${resource} with unchanged filters and a fresh C7 check per page`, async () => {
			const double = programmed(
				answer(access()),
				answer(page(resource, [ID], 'native-cursor')),
				answer(access()),
				answer(page(resource, [NEXT_ID], null)),
			);
			const rows = await client(double).list(resource, { owner_id: ID }, 1000);
			assert.deepEqual(
				rows.map((row) => row.id),
				[ID, NEXT_ID],
			);
			assert.deepEqual(double.calls[1]?.qs, {
				filters: JSON.stringify({ owner_id: ID }),
				limit: 100,
			});
			assert.deepEqual(double.calls[3]?.qs, {
				filters: JSON.stringify({ owner_id: ID }),
				limit: 100,
				cursor: 'native-cursor',
			});
			assert.equal(double.calls[2]?.url, BASE_URL + '/crm/access-context');
		});

		it(`updates ${resource} using the exact original CAS and explicit null`, async () => {
			const changes =
				resource === 'lead'
					? { notes: null }
					: resource === 'opportunity'
						? { next_step: null }
						: { body: null };
			const body =
				resource === 'lead'
					? { ...changes, expected_version: 7 }
					: { changes, expected_version: 7 };
			const double = programmed(
				answer(access()),
				answer(writeResponse(resource)),
			);
			await client(double).write(
				resource,
				'update',
				body,
				'source-item-1:update:7',
				ID,
			);
			assert.equal(double.calls[1]?.method, 'PATCH');
			assert.equal(
				double.calls[1]?.url,
				`${BASE_URL}${resources[resource].path}/${ID}`,
			);
			assert.deepEqual(double.calls[1]?.body, body);
		});

		it(`recovers ${resource} with exactly the same original request and native confirmation`, async () => {
			const original = await capturedOriginal(resource);
			const double = programmed(
				answer(access()),
				answer(writeResponse(resource), 200, { 'idempotent-replayed': 'true' }),
			);
			const result = await client(double).recover(original);
			assert.equal(double.calls.length, 2);
			assert.equal(double.calls[1]?.method, 'POST');
			assert.equal(double.calls[1]?.url, BASE_URL + resources[resource].path);
			assert.deepEqual(double.calls[1]?.body, original.body);
			assert.equal(
				double.calls[1]?.headers?.['Idempotency-Key'],
				original.idempotencyKey,
			);
			assert.equal((result._factuarea as IDataObject).replayed, true);
		});
	}

	it('honors the explicit total cap without requesting another page', async () => {
		const double = programmed(
			answer(access()),
			answer(page('lead', [ID, NEXT_ID], 'more')),
		);
		assert.equal((await client(double).list('lead', {}, 1)).length, 1);
		assert.equal(double.calls.length, 2);
	});

	it('returns one page when Return All is disabled', async () => {
		const double = programmed(
			answer(access()),
			answer(page('activity', [ID], 'more')),
		);
		assert.equal(
			(await client(double).list('activity', {}, 1000, false)).length,
			1,
		);
		assert.equal(double.calls.length, 2);
	});

	it('rejects repeated or malformed cursors instead of announcing a complete list', async () => {
		for (const invalid of [
			{ data: { data: [], next_cursor: null, has_more: true } },
			page('lead', [NEXT_ID], 'same'),
		]) {
			const double = programmed(
				answer(access()),
				answer(page('lead', [ID], 'same')),
				answer(access()),
				answer(invalid),
			);
			await assert.rejects(
				client(double).list('lead', {}, 1000),
				(error: unknown) =>
					error instanceof CrmError && error.code === 'invalid_pagination',
			);
		}
	});

	it('drops accumulated list data when Company or C7 changes between pages', async () => {
		const double = programmed(
			answer(access()),
			answer(page('opportunity', [ID], 'more')),
			answer(
				access({
					authorization_version: 'new-company-c7',
					scope: { mode: 'company', authorization_version: 'new-company-c7' },
				}),
			),
		);
		await assert.rejects(
			client(double).list('opportunity', {}, 1000),
			(error: unknown) =>
				error instanceof CrmError && error.code === 'crm_context_changed',
		);
		assert.equal(double.calls.length, 3);
	});

	for (const denied of [
		access({ scope: { mode: 'denied', authorization_version: 'c7-fixture' } }),
		access({ scope: { mode: 'company', authorization_version: 'stale' } }),
		access({ availability: [] }),
		access({
			sandbox: true,
			availability: operations.map((operation) => ({
				operation,
				available: true,
				sandbox_policy: 'blocked',
			})),
		}),
	]) {
		it('refuses unavailable, denied, incoherent or sandbox-blocked operations before effects', async () => {
			const double = programmed(answer(denied));
			await assert.rejects(
				client(double).write('lead', 'create', createBody('lead'), 'original'),
				(error: unknown) => error instanceof CrmError && error.status === 403,
			);
			assert.equal(double.calls.length, 1);
		});
	}

	it('checks the expected environment without changing the credential realm', async () => {
		const double = programmed(answer(access({ sandbox: true })));
		await assert.rejects(
			client(double, { environment: 'live' as const }).get('lead', ID),
			(error: unknown) =>
				error instanceof CrmError && error.code === 'environment_mismatch',
		);
		assert.equal(double.calls.length, 1);
	});

	it('forwards n8n cancellation and prevents requests after cancellation', async () => {
		const controller = new AbortController();
		const double = programmed(answer(access()), answer({ data: { id: ID } }));
		const api = client(double, { abortSignal: controller.signal });
		await api.get('lead', ID);
		assert.equal(double.calls[0]?.abortSignal, controller.signal);
		assert.equal(double.calls[1]?.abortSignal, controller.signal);
		controller.abort();
		await assert.rejects(
			api.get('lead', ID),
			(error: unknown) =>
				error instanceof CrmError && error.code === 'execution_cancelled',
		);
		assert.equal(double.calls.length, 2);
	});

	it('refuses arbitrary credential hosts, insecure URLs, query strings and user info', () => {
		for (const baseUrl of [
			'https://attacker.example/v1',
			'http://api.factuarea.com/v1',
			'https://api.factuarea.com/v1?token=x',
			'https://user:secret@api.factuarea.com/v1',
			'https://api.factuarea.com:8443/v1',
		]) {
			const double = programmed();
			assert.throws(
				() => client(double, { baseUrl }),
				(error: unknown) =>
					error instanceof CrmError && error.code === 'invalid_api_host',
			);
			assert.equal(double.calls.length, 0);
		}
	});

	it('rejects integer aliases, caller authority, invalid keys, floating amounts and unsafe CAS', async () => {
		const double = programmed();
		const api = client(double);
		await assert.rejects(api.get('lead', '123'));
		await assert.rejects(
			api.write('lead', 'create', { name: 'Lead', company_id: ID }, 'original'),
		);
		await assert.rejects(
			api.write('lead', 'create', { name: 'Lead', owner_uuid: ID }, 'original'),
		);
		await assert.rejects(api.write('lead', 'create', createBody('lead'), ''));
		await assert.rejects(
			api.write(
				'opportunity',
				'create',
				{ ...createBody('opportunity'), amount: 125.004 },
				'original',
			),
		);
		await assert.rejects(
			api.write(
				'activity',
				'update',
				{ expected_version: 1.5, changes: { body: null } },
				'original',
				ID,
			),
		);
		assert.equal(double.calls.length, 0);
	});

	it('treats timeouts and 5xx writes as unconfirmed and never automatically retries', async () => {
		for (const failure of [
			new Error('api key and private transport body'),
			answer({ error: { message: 'private server body' } }, 503),
		]) {
			const double = programmed(answer(access()), failure);
			try {
				await client(double).write(
					'lead',
					'create',
					createBody('lead'),
					'source-stable',
				);
				assert.fail('expected unconfirmed write');
			} catch (error) {
				assert.ok(error instanceof CrmError);
				assert.equal(error.unconfirmed, true);
				assert.equal(error.original?.idempotencyKey, 'source-stable');
				assert.deepEqual(error.original?.body, createBody('lead'));
				assert.doesNotMatch(error.message, /private|api key/);
			}
			assert.equal(double.calls.length, 2);
		}
	});

	it('does not turn pending activity state or a malformed success into confirmation', async () => {
		for (const data of [
			{ state: 'pending', effect_id: EFFECT, activity_id: ID, activity: null },
			{
				state: 'confirmed',
				effect_id: EFFECT,
				activity_id: ID,
				activity: { id: NEXT_ID },
			},
		]) {
			const double = programmed(answer(access()), answer({ data }, 201));
			await assert.rejects(
				client(double).write(
					'activity',
					'create',
					createBody('activity'),
					'original',
				),
				(error: unknown) =>
					error instanceof CrmError &&
					error.unconfirmed &&
					Boolean(error.original),
			);
		}
	});

	it('preserves the original key and version on 409 without refreshing a mutable record', async () => {
		const double = programmed(
			answer(access()),
			answer({ error: { message: 'private conflict' } }, 409),
		);
		try {
			await client(double).write(
				'opportunity',
				'update',
				{ expected_version: 4, changes: { next_step: null } },
				'original-update',
				ID,
			);
			assert.fail('expected conflict');
		} catch (error) {
			assert.ok(error instanceof CrmError);
			assert.equal(error.code, 'crm_conflict');
			assert.equal(error.unconfirmed, false);
			assert.equal(error.original?.body.expected_version, 4);
			assert.equal(error.original?.idempotencyKey, 'original-update');
			assert.doesNotMatch(error.message, /private conflict/);
		}
		assert.equal(double.calls.length, 2);
	});

	it('distinguishes native revision, reused-key and unconfirmed-effect conflicts safely', async () => {
		for (const code of [
			'crm_version_conflict',
			'idempotency_key_reused',
			'crm_effect_unconfirmed',
		]) {
			const double = programmed(
				answer(access()),
				answer({ error: { code, message: 'private conflict body' } }, 409),
			);
			try {
				await client(double).write(
					'activity',
					'create',
					createBody('activity'),
					'original',
				);
				assert.fail('expected conflict');
			} catch (error) {
				assert.ok(error instanceof CrmError);
				assert.equal(error.code, code);
				assert.equal(error.unconfirmed, code === 'crm_effect_unconfirmed');
				assert.equal(error.original?.idempotencyKey, 'original');
				assert.doesNotMatch(JSON.stringify(error.toJSON()), /private conflict/);
			}
			assert.equal(double.calls.length, 2);
		}
	});

	it('exposes safe 422 field names and 429 Retry-After without private messages', async () => {
		for (const [status, headers, body, expected] of [
			[
				422,
				{},
				{ error: { param: 'amount', message: 'private amount details' } },
				'validation_failed',
			],
			[
				429,
				{ 'retry-after': '12' },
				{ error: { message: 'private quota' } },
				'rate_limited',
			],
		] as const) {
			const double = programmed(
				answer(access()),
				answer(body, status, headers),
			);
			try {
				await client(double).write(
					'lead',
					'create',
					createBody('lead'),
					'original',
				);
				assert.fail('expected native error');
			} catch (error) {
				assert.ok(error instanceof CrmError);
				assert.equal(error.code, expected);
				if (status === 422) assert.deepEqual(error.fields, ['amount']);
				else assert.equal(error.retryAfterSeconds, 12);
				assert.doesNotMatch(
					JSON.stringify(error.toJSON()),
					/private amount|private quota/,
				);
			}
		}
	});

	it('rejects expired, changed-credential or changed-realm originals without resubmitting', async () => {
		const original = await capturedOriginal();
		for (const invalid of [
			{ ...original, createdAt: Date.now() - 300001 },
			{ ...original, credentialId: 'other-credential' },
			{ ...original, baseUrl: 'https://other.example/v1' },
		]) {
			const double = programmed();
			await assert.rejects(client(double).recover(invalid));
			assert.equal(double.calls.length, 0);
		}
		const double = programmed(answer(access({ sandbox: true })));
		await assert.rejects(
			client(double).recover(original),
			(error: unknown) =>
				error instanceof CrmError && error.code === 'crm_context_changed',
		);
		assert.equal(double.calls.length, 1);
	});

	it('revalidates current scope when recovering the original rather than trusting its snapshot', async () => {
		const original = await capturedOriginal();
		const double = programmed(answer(access({ availability: [] })));
		await assert.rejects(
			client(double).recover(original),
			(error: unknown) => error instanceof CrmError && error.status === 403,
		);
		assert.equal(double.calls.length, 1);
	});

	it('recovers an uncertain update using its original CAS without a mutable GET', async () => {
		const failure = programmed(answer(access()), new Error('timeout'));
		let original: OriginalIntent | undefined;
		try {
			await client(failure).write(
				'opportunity',
				'update',
				{ expected_version: 17, changes: { amount: '12.2500' } },
				'original-update',
				ID,
			);
		} catch (error) {
			assert.ok(error instanceof CrmError);
			original = error.original;
		}
		assert.ok(original);
		const recovery = programmed(
			answer(access()),
			answer(writeResponse('opportunity'), 200, {
				'idempotent-replayed': 'true',
			}),
		);
		await client(recovery).recover(original);
		assert.equal(recovery.calls[1]?.method, 'PATCH');
		assert.equal(recovery.calls[1]?.url, `${BASE_URL}/crm/opportunity/${ID}`);
		assert.deepEqual(recovery.calls[1]?.body, {
			expected_version: 17,
			changes: { amount: '12.2500' },
		});
		assert.equal(
			recovery.calls[1]?.headers?.['Idempotency-Key'],
			'original-update',
		);
		assert.equal(recovery.calls.length, 2);
	});

	it('searches contact people through native page pagination and retains the query', async () => {
		const double = programmed(
			answer(access()),
			answer({
				data: [{ id: ID, name: null }],
				meta: { current_page: 1, per_page: 100, total: 2 },
			}),
			answer(access()),
			answer({
				data: [{ id: NEXT_ID, name: 'Visible person' }],
				meta: { current_page: 2, per_page: 100, total: 2 },
			}),
		);
		assert.equal((await client(double).contacts('inbound', 1000)).length, 2);
		assert.equal(double.calls[1]?.url, BASE_URL + '/crm/contact-people');
		assert.deepEqual(double.calls[3]?.qs, {
			search: 'inbound',
			page: 2,
			per_page: 100,
		});
	});

	it('loads pipeline and stage options from native authorized DTOs and hides archived entries', async () => {
		const double = programmed(
			answer(access()),
			answer({
				data: {
					items: [{ id: PIPELINE, name: 'Sales', status: 'active' }],
					next_cursor: null,
					has_more: false,
				},
			}),
			answer(access()),
			answer({
				data: {
					id: PIPELINE,
					stages: [
						{ id: STAGE, name: 'Qualified', status: 'active' },
						{ id: NEXT_ID, name: 'Archived', status: 'archived' },
					],
				},
			}),
		);
		assert.deepEqual(await client(double).options('pipelines'), [
			{ name: 'Sales', value: PIPELINE },
		]);
		assert.deepEqual(await client(double).options('stages', PIPELINE), [
			{ name: 'Qualified', value: STAGE },
		]);
		assert.equal(double.calls[3]?.url, `${BASE_URL}/crm/pipelines/${PIPELINE}`);
	});

	it('loads person selector options without hydrating or guessing private names', async () => {
		const double = programmed(
			answer(access()),
			answer({
				data: [
					{ id: ID, label: null },
					{ id: NEXT_ID, label: 'Visible person' },
				],
				meta: { current_page: 1, total: 2 },
			}),
		);
		assert.deepEqual(await client(double).options('people'), [
			{ name: ID, value: ID },
			{ name: 'Visible person', value: NEXT_ID },
		]);
		assert.equal(
			double.calls[1]?.url,
			BASE_URL + '/crm/contact-people/options',
		);
		assert.deepEqual(double.calls[1]?.qs, {
			kind: 'people',
			search: '',
			page: 1,
		});
	});

	it('loads lead and opportunity targets through their actual native cursor paths', async () => {
		for (const [kind, resource] of [
			['leads', 'lead'],
			['opportunities', 'opportunity'],
		] as const) {
			const double = programmed(
				answer(access()),
				answer(page(resource, [ID], null)),
			);
			assert.deepEqual(await client(double).options(kind), [
				{ name: ID, value: ID },
			]);
			assert.equal(double.calls[1]?.url, BASE_URL + resources[resource].path);
		}
	});
});

function execution(
	double: ReturnType<typeof programmed>,
	parameters: Array<Record<string, unknown>>,
	continueOnFail = false,
): IExecuteFunctions {
	const node = {
		id: 'node-1',
		name: 'Factuarea CRM',
		type: 'factuareaCrm',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
		credentials: { factuareaApi: { id: 'credential-1', name: 'Factuarea' } },
	} as INode;
	return {
		getInputData: () => parameters.map(() => ({ json: {} })),
		getNodeParameter: (name: string, index: number, fallback?: unknown) =>
			parameters[index]?.[name] ?? fallback,
		getCredentials: async () => ({
			apiKey: 'masked-test-key',
			baseUrl: BASE_URL,
		}),
		getNode: () => node,
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async function (
				this: IExecuteFunctions,
				credential: string,
				options: IHttpRequestOptions,
			) {
				assert.equal(this.getNode().id, node.id);
				assert.equal(credential, 'factuareaApi');
				assert.equal(options.headers?.Authorization, undefined);
				return double.request(options);
			},
		},
	} as unknown as IExecuteFunctions;
}

describe('Factuarea CRM real node execution', () => {
	it('executes the inbound lead, opportunity and activity recipe with native identities', async () => {
		const double = programmed(
			answer(access()),
			answer({ data: { id: ID, name: 'Inbound' } }, 201),
			answer(access()),
			answer({ data: { id: NEXT_ID, title: 'Inbound opportunity' } }, 201),
			answer(access()),
			answer(
				{
					data: {
						state: 'confirmed',
						effect_id: EFFECT,
						activity_id: STAGE,
						activity: { id: STAGE, title: 'Follow up' },
					},
				},
				201,
			),
		);
		const node = new FactuareaCrm();
		const [leads] = await node.execute.call(
			execution(double, [
				{
					resource: 'lead',
					operation: 'create',
					body: { name: 'Inbound', source: 'manual' },
					idempotencyKey: 'inbound:event-1:lead',
				},
			]),
		);
		const [opportunities] = await node.execute.call(
			execution(double, [
				{
					resource: 'opportunity',
					operation: 'create',
					body: {
						title: 'Inbound opportunity',
						lead_id: leads?.[0]?.json.id,
						amount: '125.0000',
						currency: 'EUR',
					},
					pipelineId: PIPELINE,
					stageId: STAGE,
					idempotencyKey: 'inbound:event-1:opportunity',
				},
			]),
		);
		const [activities] = await node.execute.call(
			execution(double, [
				{
					resource: 'activity',
					operation: 'create',
					body: { type: 'task', title: 'Follow up', timezone: 'Europe/Madrid' },
					targetType: 'opportunity',
					targetId: opportunities?.[0]?.json.id,
					idempotencyKey: 'inbound:event-1:follow-up',
				},
			]),
		);
		assert.equal((double.calls[3]?.body as IDataObject).lead_id, ID);
		assert.deepEqual((double.calls[5]?.body as IDataObject).target, {
			type: 'opportunity',
			id: NEXT_ID,
		});
		assert.equal(activities?.[0]?.json.state, 'confirmed');
		assert.equal(activities?.[0]?.json.activity_id, STAGE);
		assert.equal(double.remaining(), 0);
	});

	it('ships an inactive recipe with per-step confirmation branches and no credentials', () => {
		const workflow = recipe as unknown as {
			active: boolean;
			nodes: Array<{
				name: string;
				type: string;
				typeVersion: number;
				parameters: Record<string, unknown>;
				onError?: string;
				credentials?: unknown;
			}>;
			connections: Record<string, { main: Array<Array<{ node: string }>> }>;
		};
		assert.equal(workflow.active, false);
		assert.ok(workflow.nodes.every((node) => node.credentials === undefined));
		const crmNodes = workflow.nodes.filter(
			(node) => node.type === 'n8n-nodes-factuarea.factuareaCrm',
		);
		assert.equal(crmNodes.length, 3);
		assert.equal(
			new Set(crmNodes.map((node) => node.parameters.idempotencyKey)).size,
			3,
		);
		for (const node of crmNodes) {
			assert.equal(node.typeVersion, new FactuareaCrm().description.version);
			assert.equal(node.parameters.environment, 'sandbox');
			assert.equal(node.onError, 'continueRegularOutput');
			assert.match(String(node.parameters.idempotencyKey), /eventId/);
			assert.doesNotMatch(
				String(node.parameters.idempotencyKey),
				/\$execution|random/,
			);
		}
		assert.equal(
			workflow.nodes.find((node) => node.name === 'Inbound')?.parameters
				.authentication,
			'headerAuth',
		);
		for (const gate of [
			'Valid Source',
			'Lead Confirmed',
			'Opportunity Confirmed',
			'Activity Confirmed',
		])
			assert.equal(
				workflow.connections[gate]?.main[1]?.[0]?.node,
				'Respond Review Required',
			);
		assert.equal(
			workflow.connections['Activity Confirmed']?.main[0]?.[0]?.node,
			'Respond Completed',
		);
		assert.equal(
			workflow.connections['Create Follow-Up']?.main[0]?.[0]?.node,
			'Activity Confirmed',
		);
		assert.doesNotMatch(
			JSON.stringify(recipe),
			/fk_live_|fk_test_|Bearer |apiKey|clientSecret/,
		);
	});

	it('uses n8n authentication and item-specific keys while preserving item pairing', async () => {
		const double = programmed(
			answer(access()),
			answer(writeResponse('lead'), 201),
			answer(access()),
			answer({ data: { id: NEXT_ID, name: 'Second' } }, 201),
		);
		const context = execution(double, [
			{
				resource: 'lead',
				operation: 'create',
				body: '{"name":"First"}',
				idempotencyKey: 'source-1',
			},
			{
				resource: 'lead',
				operation: 'create',
				body: '{"name":"Second"}',
				idempotencyKey: 'source-2',
			},
		]);
		const [items] = await new FactuareaCrm().execute.call(context);
		assert.equal(items?.length, 2);
		assert.deepEqual(
			items?.map((item) => item.pairedItem),
			[{ item: 0 }, { item: 1 }],
		);
		assert.equal(double.calls[1]?.headers?.['Idempotency-Key'], 'source-1');
		assert.equal(double.calls[3]?.headers?.['Idempotency-Key'], 'source-2');
	});

	it('creates opportunity and activity relationships using the selected native options', async () => {
		const double = programmed(
			answer(access()),
			answer(writeResponse('opportunity'), 201),
			answer(access()),
			answer(writeResponse('activity'), 201),
		);
		const context = execution(double, [
			{
				resource: 'opportunity',
				operation: 'create',
				body: { title: 'Inbound', amount: '10.0000', currency: 'EUR' },
				pipelineId: PIPELINE,
				stageId: STAGE,
				idempotencyKey: 'inbound:opportunity',
			},
			{
				resource: 'activity',
				operation: 'create',
				body: { type: 'task', title: 'Follow up', timezone: 'Europe/Madrid' },
				targetType: 'opportunity',
				targetId: ID,
				idempotencyKey: 'inbound:activity',
			},
		]);
		await new FactuareaCrm().execute.call(context);
		assert.equal((double.calls[1]?.body as IDataObject).pipeline_id, PIPELINE);
		assert.deepEqual((double.calls[3]?.body as IDataObject).target, {
			type: 'opportunity',
			id: ID,
		});
	});

	it('emits a recoverable item error and continues without fabricating success', async () => {
		const double = programmed(
			answer(access()),
			new Error('private timeout'),
			answer(access()),
			answer({ data: { id: NEXT_ID } }, 201),
		);
		const context = execution(
			double,
			[
				{
					resource: 'lead',
					operation: 'create',
					body: { name: 'First' },
					idempotencyKey: 'source-1',
				},
				{
					resource: 'lead',
					operation: 'create',
					body: { name: 'Second' },
					idempotencyKey: 'source-2',
				},
			],
			true,
		);
		const [items] = await new FactuareaCrm().execute.call(context);
		assert.equal(items?.length, 2);
		const error = items?.[0]?.json.error as IDataObject;
		assert.equal(error.unconfirmed, true);
		assert.equal((error.original as IDataObject).idempotencyKey, 'source-1');
		assert.equal(items?.[0]?.json._factuarea, undefined);
		assert.equal(items?.[1]?.json.id, NEXT_ID);
		assert.doesNotMatch(
			JSON.stringify(items),
			/masked-test-key|private timeout/,
		);
	});

	it('stops on failure when Continue On Fail is disabled', async () => {
		const double = programmed(
			answer(access()),
			answer({ error: { message: 'private denied data' } }, 403),
		);
		const context = execution(double, [
			{ resource: 'lead', operation: 'get', recordId: ID },
			{ resource: 'lead', operation: 'get', recordId: NEXT_ID },
		]);
		await assert.rejects(
			new FactuareaCrm().execute.call(context),
			(error: unknown) => error instanceof CrmError && error.status === 403,
		);
		assert.equal(double.calls.length, 2);
	});

	it('executes Recover Original using the original input without replacing its CAS', async () => {
		const original = await capturedOriginal();
		const double = programmed(
			answer(access()),
			answer(
				{ data: { id: ID, confirmed: true, representation_available: false } },
				200,
				{ 'idempotent-replayed': 'true' },
			),
		);
		const [items] = await new FactuareaCrm().execute.call(
			execution(double, [
				{
					resource: 'lead',
					operation: 'recover',
					original: JSON.stringify(original),
				},
			]),
		);
		assert.equal(items?.[0]?.json.confirmed, true);
		assert.equal(items?.[0]?.json.representation_available, false);
		assert.deepEqual(double.calls[1]?.body, original.body);
	});

	it('loads stage options through the real node consumer with the chosen credential', async () => {
		const double = programmed(
			answer(access()),
			answer({
				data: {
					id: PIPELINE,
					stages: [{ id: STAGE, name: 'Qualified', status: 'active' }],
				},
			}),
		);
		const executeContext = execution(double, []);
		const context = {
			...executeContext,
			getNodeParameter: (name: string, fallback?: unknown) =>
				name === 'pipelineId' ? PIPELINE : fallback,
		} as unknown as ILoadOptionsFunctions;
		assert.deepEqual(
			await new FactuareaCrm().methods.loadOptions.getStages.call(context),
			[{ name: 'Qualified', value: STAGE }],
		);
	});
});
