import { strict as assert } from 'node:assert';
import {createHash} from 'node:crypto';
import {FactuareaCrmOAuth2Api} from '../src/credentials/FactuareaCrmOAuth2Api.credentials';
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

const API_KEY='fact_live_'+'a'.repeat(24);
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
	'crm_opportunities.move_stage',
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

function account(credential=EFFECT, overrides: IDataObject={}): IDataObject {
 return {data:{company:{id:ID},api_key:{id:credential,environment:'live',scopes:['account:read','crm_leads:write','crm_opportunities:write','crm_activities:write'],...overrides}}};
}
function oauth(credential=EFFECT, overrides: IDataObject={}): IDataObject {
 return {data:{company_id:ID,credential_id:credential,client_id:NEXT_ID,environment:'live',scopes:['crm_access_context:read','crm_leads:write','crm_opportunities:write','crm_activities:write'],authorization_version:'current-C7',...overrides}};
}
async function saved(resource: Resource='lead', operation: 'create'|'update'|'move_stage'='create'): Promise<OriginalIntent> {
 const double=programmed(answer(access()),answer(account()));
 const body=operation==='move_stage'?{expected_version:4,target_pipeline_id:PIPELINE,target_stage_id:STAGE,expected_definition_version:0}
  :operation==='update'?resource==='lead'?{expected_version:4,name:null}:{expected_version:4,changes:{title:null}}:createBody(resource);
 const original=await client(double).prepare(resource,operation,body,'RAW source original key',operation==='create'?undefined:ID);
 assert.equal(double.calls.filter(call=>call.method!=='GET').length,0);assert.equal(double.remaining(),0);return original;
}
function receipt(original:OriginalIntent,state='confirmed',data:unknown=writeResponse(original.resource)): IDataObject {
 return {data:{state,original_body_sha256:original.sha256,original_response:state==='confirmed'?{status:201,body:' '+JSON.stringify(data)+' '}:null},meta:{authorization_version:'new-owner-C7'}};
}

describe('Factuarea CRM prepared native transport',()=>{
 it('rejects transport-normalized header edge whitespace without trimming before HTTP',async()=>{
  const double=programmed();for(const key of [' original','original ',' original '])await assert.rejects(client(double).prepare('lead','create',createBody('lead'),key));assert.equal(double.calls.length,0);
 });
 for(const resource of ['lead','opportunity','activity'] as const) {
  it('prepares '+resource+' without a write and submits exact saved UTF8 bytes once',async()=>{
   const original=await saved(resource);assert.equal(original.sha256,createHash('sha256').update(original.wire).digest('hex'));
   const double=programmed(answer(access()),answer(account()),answer(writeResponse(resource),201));
   const result=await client(double).submit(original);assert.equal(result.id??result.activity_id,ID);
   assert.equal(double.calls[2]?.body,original.wire);assert.equal(double.calls[2]?.json,false);assert.equal(double.calls[2]?.headers?.['Idempotency-Key'],original.idempotencyKey);
   assert.equal(double.calls.filter(call=>call.method==='POST').length,1);assert.equal(double.remaining(),0);
  });
  it('reads and paginates '+resource+' with current C7 and unchanged filters',async()=>{
   const double=programmed(answer(access()),answer({data:{id:ID,name:null}}),answer(access()),answer(page(resource,[ID],ID)),answer(access()),answer(page(resource,[NEXT_ID],null)));
   assert.equal((await client(double).get(resource,ID)).name,null);
   assert.equal((await client(double).list(resource,{search:'Inbound'},1000)).length,2);
   assert.equal(double.calls[3]?.qs?.filters,double.calls[5]?.qs?.filters);assert.equal(double.calls[5]?.qs?.cursor,ID);
  });
  it('recovers '+resource+' only through canonical Original GET with frozen HTTP bytes',async()=>{
   const original=await saved(resource),frame=receipt(original);
   const double=programmed(answer(access()),answer(account()),answer(frame));
   const result=await client(double).recover(original),call=double.calls[2];
   assert.equal(call?.url,BASE_URL+resources[resource].path+'/create/original');assert.equal(call?.method,'GET');assert.equal(call?.body,undefined);
   assert.deepEqual(call?.qs,{original_body_sha256:original.sha256});assert.equal(call?.headers?.['Idempotency-Key'],original.idempotencyKey);
   assert.equal((result._factuarea as IDataObject).originalResponseBody,(frame.data as IDataObject).original_response && ((frame.data as IDataObject).original_response as IDataObject).body);
   assert.equal((result._factuarea as IDataObject).originalHttpStatus,201);assert.equal(double.calls.filter(call=>call.method!=='GET').length,0);
  });
 }
 for(const resource of ['lead','activity'] as const) it('retains confirmed '+resource+' owner pointers with hidden representation in Submit and Original',async()=>{
  const original=await saved(resource);
  const native={data:resource==='activity'?{state:'confirmed',effect_id:EFFECT,activity_id:ID,activity:null}:{id:ID,confirmed:true,representation_available:false}};
  const submit=programmed(answer(access()),answer(account()),answer(native,201));
  const submitted=await client(submit).submit(original);assert.equal(submitted.id??submitted.activity_id,ID);
  if(resource==='activity')assert.equal(submitted.activity,null);else assert.equal(submitted.version,undefined);
  const frame=receipt(original,'confirmed',native),recovery=programmed(answer(access()),answer(account()),answer(frame));
  const recovered=await client(recovery).recover(original);assert.equal(recovered.id??recovered.activity_id,ID);
  assert.equal((recovered._factuarea as IDataObject).originalResponseBody,((frame.data as IDataObject).original_response as IDataObject).body);
  assert.ok(recovery.calls.every(call=>call.method==='GET'));
 });
 it('moves opportunity stage with original CAS and recovers its fourth canonical GET',async()=>{
  const original=await saved('opportunity','move_stage');
  const double=programmed(answer(access()),answer(account()),answer(writeResponse('opportunity')));
  await client(double).submit(original);assert.equal(double.calls[2]?.url,BASE_URL+'/crm/opportunity/'+ID+'/stage');assert.equal(double.calls[2]?.body,original.wire);
  const recovery=programmed(answer(access()),answer(account()),answer(receipt(original)));
  await client(recovery).recover(original);assert.equal(recovery.calls[2]?.url,BASE_URL+'/crm/opportunity/'+ID+'/stage/original');
 });
 it('never redispatches an uncertain update: no canonical update Original route exists',async()=>{
  const original=await saved('lead','update'),double=programmed();
  await assert.rejects(client(double).recover(original),error=>error instanceof CrmError && error.code==='original_unavailable');assert.equal(double.calls.length,0);
 });
 for(const state of ['pending','in_progress','unconfirmed','missing']) it('Original '+state+' never permits a write',async()=>{
  const original=await saved();const double=programmed(answer(access()),answer(account()),answer(receipt(original,state)));
  await assert.rejects(client(double).recover(original),error=>error instanceof CrmError && error.code==='original_'+state);assert.ok(double.calls.every(call=>call.method==='GET'));
 });
 it('rejects modified wire, caller authority, wrong route UUID and foreign singleton key before dispatch',async()=>{
  const original=await saved(),double=programmed();
  for(const bad of [{...original,wire:'{}'},{...original,recordId:ID},{...original,company_id:ID}]) await assert.rejects(client(double).submit(bad));
  assert.equal(double.calls.length,0);
  const changed=programmed(answer(access()),answer(account(NEXT_ID)));await assert.rejects(client(changed).recover(original),/credential or realm changed/);assert.equal(changed.calls.length,2);
 });
 it('captures input bytes before context reads and retains explicit null and decimal scale',async()=>{
  const body:IDataObject={...createBody('opportunity'),lead_id:null};const double=programmed(answer(access()),answer(account()));
  const promise=client(double).prepare('opportunity','create',body,'original');body.amount='999.0';
  const original=await promise;assert.equal(JSON.parse(original.wire).amount,'125.0040');assert.equal(JSON.parse(original.wire).lead_id,null);
 });
 for(const status of [401,403,409,422,429,503]) it('HTTP '+status+' does not retry POST or leak private native errors',async()=>{
  const original=await saved(),double=programmed(answer(access()),answer(account()),answer({error:{message:'private-key-secret',code:'denied'}},status,{'retry-after':'17'}));
  await assert.rejects(client(double).submit(original),error=>{assert.equal(String(error).includes('private-key-secret'),false);return error instanceof CrmError && error.status===status;});assert.equal(double.calls.length,3);
 });
 it('timeout and pending activity retain original without automatic recovery',async()=>{
  const original=await saved('activity');
  for(const response of [new Error('private-token'),answer({data:{state:'pending',effect_id:EFFECT,activity_id:null,activity:null}})]){
   const double=programmed(answer(access()),answer(account()),response);
   await assert.rejects(client(double).submit(original),error=>error instanceof CrmError && error.unconfirmed && error.original===original);assert.equal(double.calls.length,3);
  }
 });
 it('uses actual OAuth credential context and current writer-only grants, without inferring a client family',async()=>{
  const initial=programmed(answer(oauth()),answer(access()),answer(oauth()));const options={authModel:'oauth2' as const,clientId:NEXT_ID};
  const original=await client(initial,options).prepare('lead','create',createBody('lead'),'oauth:original');
  assert.equal(initial.calls[0]?.url,BASE_URL+'/crm/credential-context');assert.equal(Object.hasOwn(original.nativeBinding,'family_id'),false);
  const successor=programmed(answer(oauth(STAGE)),answer(access()),answer(oauth(STAGE)));
  await assert.rejects(client(successor,options).submit(original),/Credential changed after Prepare/);assert.ok(successor.calls.every(call=>call.method==='GET'));
  const recovery=programmed(answer(oauth(STAGE)),answer(access({authorization_version:'fresh-C7',scope:{mode:'company',authorization_version:'fresh-C7'}})),answer(oauth(STAGE)),answer(receipt(original)));
  assert.equal((await client(recovery,options).recover(original)).id,ID);assert.ok(recovery.calls.every(call=>call.method==='GET'));
 });
 it('blocks current OAuth writer revocation, company/client drift and realm changes',async()=>{
  const initial=programmed(answer(oauth()),answer(access()),answer(oauth()));const options={authModel:'oauth2' as const,clientId:NEXT_ID};
  const original=await client(initial,options).prepare('lead','create',createBody('lead'),'oauth:original');
  for(const overrides of [{scopes:['crm_access_context:read']},{client_id:PIPELINE},{company_id:PIPELINE},{environment:'test'}]){
   const double=programmed(answer(oauth(STAGE,overrides)),answer(access()),answer(oauth(STAGE,overrides)));
   await assert.rejects(client(double,options).recover(original));assert.ok(double.calls.every(call=>call.method==='GET'));
  }
 });
 it('discards a list when C7 changes and refuses repeated cursors',async()=>{
  const changed=programmed(answer(access()),answer(page('lead',[ID],ID)),answer(access({authorization_version:'new',scope:{mode:'company',authorization_version:'new'}})));
  await assert.rejects(client(changed).list('lead',{},1000),/authorization changed/);
  const repeated=programmed(answer(access()),answer(page('lead',[ID],ID)),answer(access()),answer(page('lead',[NEXT_ID],ID)));
  await assert.rejects(client(repeated).list('lead',{},1000),/cursor/);
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
			apiKey: API_KEY,
			baseUrl: BASE_URL,
		}),
		getNode: () => node,
		getExecutionCancelSignal: () => undefined,
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequest: async (options:IHttpRequestOptions)=>{assert.equal(options.method==='POST'||options.method==='PATCH',true);assert.equal(options.headers?.Authorization,'Bearer '+API_KEY);return double.request(options);},
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

describe('Factuarea CRM actual host node',()=>{
 it('refuses host Retry On Fail before mutable HTTP so automatic node retries cannot resend POST',async()=>{
  const original=await saved(),double=programmed(),context=execution(double,[{resource:'lead',operation:'create',prepared:JSON.stringify(original)}]);
  const node=context.getNode();node.retryOnFail=true;context.getNode=()=>node;
  await assert.rejects(new FactuareaCrm().execute.call(context),error=>error instanceof CrmError && error.code==='unsafe_write_retry');assert.equal(double.calls.length,0);
 });
 it('Prepare and Submit are distinct executions preserving pairing and original identity',async()=>{
  const preparation=programmed(answer(access()),answer(account()));
  const [preparedItems]=await new FactuareaCrm().execute.call(execution(preparation,[{resource:'lead',operation:'prepareCreate',body:{name:'Inbound',notes:null},idempotencyKey:'original key RAW'}]));
  const prepared=preparedItems?.[0]?.json.prepared;assert.equal(typeof prepared,'string');assert.ok(preparation.calls.every(call=>call.method==='GET'));
  const submission=programmed(answer(access()),answer(account()),answer(writeResponse('lead')));
  const [items]=await new FactuareaCrm().execute.call(execution(submission,[{resource:'lead',operation:'create',prepared}]));
  assert.equal(items?.[0]?.json.id,ID);assert.deepEqual(items?.[0]?.pairedItem,{item:0});assert.equal(submission.calls[2]?.body,JSON.parse(String(prepared)).wire);
 });
 it('credential replacement between preflight and Submit stops before mutable HTTP',async()=>{
  const original=await saved(),double=programmed(answer(access()),answer(account())),context=execution(double,[{resource:'lead',operation:'create',prepared:JSON.stringify(original)}]);
  let reads=0;context.getCredentials=(async()=>({baseUrl:BASE_URL,apiKey:++reads===1?API_KEY:'fact_live_'+'b'.repeat(24)})) as IExecuteFunctions['getCredentials'];
  await assert.rejects(new FactuareaCrm().execute.call(context));assert.equal(double.calls.length,2);assert.ok(double.calls.every(call=>call.method==='GET'));
 });
 it('an in-place OAuth refresh during preflight cannot change the pinned Submit bearer',async()=>{
  const original=await saved();original.nativeBinding={company:ID,credential:EFFECT,client:NEXT_ID,environment:'live',authModel:'oauth2'};
  const double=programmed(answer(oauth()),answer(access()),answer(oauth()));
  const context=execution(double,[{authentication:'oauth2',resource:'lead',operation:'create',prepared:JSON.stringify(original)}]);
  const credentials={issuer:'https://registered-issuer.example.invalid',clientId:NEXT_ID,baseUrl:BASE_URL,oauthTokenData:{access_token:'first-native-bearer'}};
  context.getNode=()=>({id:'node-1',credentials:{factuareaCrmOAuth2Api:{id:'credential-1',name:'OAuth'}}} as unknown as INode);
  context.getCredentials=(async()=>credentials) as IExecuteFunctions['getCredentials'];
  context.helpers.httpRequestWithAuthentication=async function(type,options){assert.equal(type,'factuareaCrmOAuth2Api');credentials.oauthTokenData.access_token='refreshed-native-bearer';return double.request(options);};
  await assert.rejects(new FactuareaCrm().execute.call(context));assert.equal(double.calls.length,3);assert.ok(double.calls.every(call=>call.method==='GET'));
 });
 it('OAuth GET uses the native host refresh helper and mutable POST bypasses automatic refresh',async()=>{
  const original=await saved();original.nativeBinding={company:ID,credential:EFFECT,client:NEXT_ID,environment:'live',authModel:'oauth2'};
  const double=programmed(answer(oauth()),answer(access()),answer(oauth()),answer(writeResponse('lead')));
  const context=execution(double,[{authentication:'oauth2',resource:'lead',operation:'create',prepared:JSON.stringify(original)}]);
  const nativeGet=context.helpers.httpRequestWithAuthentication;let gets=0,writes=0;
  context.getNode=()=>({id:'node-1',credentials:{factuareaCrmOAuth2Api:{id:'credential-1',name:'OAuth'}}} as unknown as INode);
  context.getCredentials=(async()=>({issuer:'https://registered-issuer.example.invalid',clientId:NEXT_ID,baseUrl:BASE_URL,oauthTokenData:{access_token:'actual-oauth-access'}})) as IExecuteFunctions['getCredentials'];
  context.helpers.httpRequestWithAuthentication=async function(type,options){assert.equal(type,'factuareaCrmOAuth2Api');assert.equal(options.method,'GET');gets++;return double.request(options);};
  context.helpers.httpRequest=async function(options){assert.equal(options.method,'POST');assert.equal(options.headers?.Authorization,'Bearer actual-oauth-access');writes++;return double.request(options);};
  await new FactuareaCrm().execute.call(context);assert.equal(gets,3);assert.equal(writes,1);void nativeGet;
 });
 it('continueOnFail retains original bytes without success or private token details',async()=>{
  const original=await saved(),double=programmed(answer(access()),answer(account()),new Error('private-token'));
  const [items]=await new FactuareaCrm().execute.call(execution(double,[{resource:'lead',operation:'create',prepared:JSON.stringify(original)}],true));
  const error=items?.[0]?.json.error as IDataObject;assert.equal(error.unconfirmed,true);assert.equal((error.original as IDataObject).wire,original.wire);assert.equal(items?.[0]?.json._factuarea,undefined);assert.doesNotMatch(JSON.stringify(items),/private-token|masked-test-key/);
 });
 it('ships six inactive Prepare/Submit recipe nodes with retained snapshots and per-effect branches',()=>{
  assert.equal(recipe.active,false);const crm=recipe.nodes.filter(node=>node.type==='n8n-nodes-factuarea.factuareaCrm');assert.equal(crm.length,6);
  assert.equal(crm.filter(node=>node.parameters.operation==='prepareCreate').length,3);
  for(const node of crm.filter(node=>node.parameters.operation==='create'))assert.equal((node.parameters as IDataObject).prepared,'={{ $json.prepared }}');
  assert.doesNotMatch(JSON.stringify(recipe),/Bearer |clientSecret|fact_test_/);assert.ok(recipe.nodes.every(node=>!Object.hasOwn(node,'credentials')));
 });
 it('retains the genuine API-key credential and defines separate native PKCE OAuth',()=>{
  const oauthCredential=new FactuareaCrmOAuth2Api();assert.deepEqual(oauthCredential.extends,['oAuth2Api']);assert.equal(oauthCredential.properties.find(p=>p.name==='grantType')?.default,'pkce');
  assert.equal(oauthCredential.test.request.url,BASE_URL+'/crm/credential-context');
  assert.deepEqual(new FactuareaCrm().description.credentials?.map(c=>c.name),['factuareaApi','factuareaCrmOAuth2Api']);
 });
});
