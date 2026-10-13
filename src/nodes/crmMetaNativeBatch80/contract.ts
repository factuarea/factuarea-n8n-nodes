/** Native Meta Batch78 HTTP contract. No operation IDs are inferred from paths. */
export type MetaOperation='options'|'mapping'|'inspect'|'publishMapping'|'prepareOAuth'|'completeOAuth'|'publishConsent';
export type NativeObject=Record<string,unknown>;
export class MetaContractError extends Error { constructor(readonly code:string,readonly status=422){super(code);} }
export const META_ROUTES={options:{method:'GET',suffix:'options'},mapping:{method:'GET',suffix:'{connection_uuid}/mappings/{form_uuid}'},inspect:{method:'POST',suffix:'{connection_uuid}/mappings/{form_uuid}/inspect'},publishMapping:{method:'PUT',suffix:'{connection_uuid}/mappings/{form_uuid}'},prepareOAuth:{method:'POST',suffix:'oauth/prepare'},completeOAuth:{method:'POST',suffix:'oauth/complete'},publishConsent:{method:'POST',suffix:'{connection_uuid}/consent'}} as const;
export const PREFIX='/crm/connections/meta-lead-ads/';
export const BASIC=['name','email','phone','mobile','company_name','notes'];
function bad():never {throw new MetaContractError('invalid_native_meta_contract');}
export function object(value:unknown):NativeObject {if(value===null||typeof value!=='object'||Array.isArray(value))bad();return value as NativeObject;}
export function closed(value:unknown,fields:readonly string[]):NativeObject {const d=object(value);if(Object.keys(d).length!==fields.length||Object.keys(d).some(k=>!fields.includes(k)))bad();return d;}
export function uuid(value:unknown,credential=false):string {if(typeof value!=='string'||!(credential?/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/:/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/).test(value))bad();return value;}
export function text(value:unknown,max=8192):string {if(typeof value!=='string'||!value.trim()||value.length>max)bad();return value;}
export function external(value:unknown):string {if(typeof value!=='string'||!/^[1-9][0-9]{0,31}$/.test(value))bad();return value;}
export function version(value:unknown,nullable=false):number|null {if(nullable&&value===null)return null;if(!Number.isSafeInteger(value)||Number(value)<1)bad();return value as number;}
export function checksum(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))bad();return value;}
export function json(value:unknown):NativeObject {const raw=text(value,1048576);if(Buffer.byteLength(raw,'utf8')>1048576)bad();try{return object(JSON.parse(raw));}catch{bad();}}
function list(value:unknown,max=100):unknown[] {if(!Array.isArray(value)||value.length>max)bad();return value;}
function strings(value:unknown,ids=false):string[] {return list(value,1000).map(v=>ids?uuid(v):text(v,100));}
export function mapping(value:unknown):NativeObject[] {
 const records=list(value);if(!records.length)bad();const remote=new Set<string>(),targets=new Set<string>();
 return records.map(raw=>{const d=closed(raw,['remote_name','target','type','field_version','required','options']);const name=text(d.remote_name,100),target=text(d.target,100),options=object(d.options);
  if(remote.has(name)||targets.has(target)||typeof d.required!=='boolean'||!['text','number','date','boolean','select','multi'].includes(String(d.type)))bad();remote.add(name);targets.add(target);
  if(BASIC.includes(target)){if(d.type!=='text'||d.field_version!==null||Object.keys(options).length)bad();}else{uuid(target);version(d.field_version);}
  if(!['select','multi'].includes(String(d.type))&&Object.keys(options).length)bad();for(const [key,value] of Object.entries(options)){text(key,8192);uuid(value);}return d;
 });
}
export function grants(value:unknown):NativeObject[] {const records=list(value);if(!records.length)bad();const seen=new Set<string>();return records.map(raw=>{const d=closed(raw,['stream','actions']),stream=uuid(d.stream),actions=list(d.actions,2);if(seen.has(stream)||!actions.length||new Set(actions).size!==actions.length||actions.some(a=>!['read','ingest'].includes(String(a))||typeof a!=='string'))bad();seen.add(stream);return d;});}
export interface MetaRequest {operation:MetaOperation;path:string;method:'GET'|'POST'|'PUT';input:NativeObject;body?:string;connection_uuid?:string;form_uuid?:string}
export function request(operation:MetaOperation,values:unknown):MetaRequest {
 const route=META_ROUTES[operation];if(!route)bad();
 const record=['mapping','inspect','publishMapping','publishConsent'].includes(operation),form=['mapping','inspect','publishMapping'].includes(operation),human=['prepareOAuth','publishMapping','publishConsent'].includes(operation);
 const keys=[...(record?['connection_uuid']:[]),...(form?['form_uuid']:[]),...(['options','mapping'].includes(operation)?[]:['input_json']),...(human?['confirmed']:[])];const d=closed(values,keys);
 const connection=record?uuid(d.connection_uuid):undefined,formId=form?uuid(d.form_uuid):undefined;
 const input=['options','mapping'].includes(operation)?{}:json(d.input_json);
 const fields:Record<string,string[]>={prepareOAuth:['page_id'],completeOAuth:['state','code'],inspect:['credential_uuid','remote_form_id'],publishMapping:['credential_uuid','remote_form_id','mapping','expected_mapping_version','expected_publication_version','fields_snapshot_checksum'],publishConsent:['credential_uuid','grants','expected_consent_version']};
 if(fields[operation])closed(input,fields[operation]!);
 if(human){if(d.confirmed!==true)throw new MetaContractError('human_confirmation_required');input.confirmed=true;}
 if(input.credential_uuid!==undefined)uuid(input.credential_uuid,true);if(input.remote_form_id!==undefined)external(input.remote_form_id);
 if(operation==='prepareOAuth')external(input.page_id);
 if(operation==='completeOAuth'){if(typeof input.state!=='string'||!/^[0-9a-f-]{36}$/.test(input.state))bad();text(input.code);if(/[\x00-\x20\x7f]/.test(String(input.code)))bad();}
 if(operation==='publishMapping'){mapping(input.mapping);version(input.expected_mapping_version,true);version(input.expected_publication_version);checksum(input.fields_snapshot_checksum);}
 if(operation==='publishConsent'){grants(input.grants);version(input.expected_consent_version,true);}
 const path=PREFIX+route.suffix.replace('{connection_uuid}',connection??'').replace('{form_uuid}',formId??'');const body=route.method==='GET'?undefined:JSON.stringify(input);if(body!==undefined&&Buffer.byteLength(body,'utf8')>1048576)bad();
 return {operation,path,method:route.method,input,body,...(connection?{connection_uuid:connection}:{}),...(formId?{form_uuid:formId}:{})};
}
function identity(d:NativeObject,r:MetaRequest) {uuid(d.connection_uuid);uuid(d.credential_uuid,true);if(r.connection_uuid&&d.connection_uuid!==r.connection_uuid)bad();if(r.form_uuid){uuid(d.form_uuid);if(d.form_uuid!==r.form_uuid)bad();}if(r.input.credential_uuid!==undefined&&d.credential_uuid!==r.input.credential_uuid)bad();external(d.page_id);if(d.remote_form_id!==undefined){external(d.remote_form_id);if(r.input.remote_form_id!==undefined&&d.remote_form_id!==r.input.remote_form_id)bad();}}
export function projection(response:unknown,r:MetaRequest):NativeObject {
 if(r.operation==='prepareOAuth'){const d=closed(response,['authorization_url','state']);if(typeof d.state!=='string'||!/^[0-9a-f-]{36}$/.test(d.state))bad();let url:URL;try{url=new URL(text(d.authorization_url,16384));}catch{bad();}if(url.protocol!=='https:'||url.hostname!=='www.facebook.com'||url.pathname!=='/v25.0/dialog/oauth'||url.username||url.password||url.port||url.hash||url.searchParams.get('state')!==d.state)bad();return d;}
 if(r.operation==='completeOAuth'){const d=closed(response,['status','connection_uuid','credential_uuid','page_id','scopes']);if(d.status!=='credentials_installed')bad();identity(d,r);strings(d.scopes);return d;}
 const frame=closed(response,['data']),d=object(frame.data);
 if(r.operation==='options'){closed(d,['options']);const options=list(d.options,1);options.forEach(raw=>{const option=closed(raw,['connection_uuid','credential_uuid','page_id','page_name']);identity(option,r);if(option.page_name!==null)text(option.page_name,1000);});return d;}
 if(r.operation==='publishConsent')throw new MetaContractError('app_review_evidence_unavailable',409); // Current canonical external reader admits no consent receipt.
 if(r.operation==='inspect'){
  closed(d,['status','connection_uuid','credential_uuid','form_uuid','page_id','remote_form_id','app_id','responsible_uuid','remote_field_names','publication_version','authorization_version','configuration_version','fields_snapshot_checksum','expected_mapping_version','expected_consent_version','destination','app_review']);
  if(d.status!=='mapping_inspected')bad();identity(d,r);external(d.app_id);uuid(d.responsible_uuid);strings(d.remote_field_names);
  for(const key of ['publication_version','authorization_version','configuration_version'])version(d[key]);version(d.expected_mapping_version,true);version(d.expected_consent_version,true);checksum(d.fields_snapshot_checksum);
  const dest=closed(d.destination,['basic_fields','required_basic_fields','allowed_field_ids','required_field_ids','fields_snapshot']);strings(dest.basic_fields);strings(dest.required_basic_fields);strings(dest.allowed_field_ids,true);strings(dest.required_field_ids,true);object(dest.fields_snapshot);
  const review=closed(d.app_review,['available','reason']);if(review.available!==false||review.reason!=='app_review_evidence_unavailable')bad();return d; // Original Fields object/list/property order is never sorted or replaced.
 }
 closed(d,['status','connection_uuid','credential_uuid','form_uuid','page_id','remote_form_id','mapping_version','publication_version','fields_snapshot_checksum','mapping']);if(d.status!=='mapping_published')bad();identity(d,r);uuid(d.form_uuid);version(d.mapping_version);version(d.publication_version);checksum(d.fields_snapshot_checksum);mapping(d.mapping);
 if(r.operation==='publishMapping'&&(d.publication_version!==r.input.expected_publication_version||d.fields_snapshot_checksum!==r.input.fields_snapshot_checksum||!sameMapping(mapping(d.mapping),mapping(r.input.mapping))))bad();return d;
}

function sameMapping(actual:NativeObject[],expected:NativeObject[]):boolean {return actual.length===expected.length&&actual.every((d,i)=>{const e=expected[i]!;return ['remote_name','target','type','field_version','required'].every(k=>d[k]===e[k])&&Object.keys(object(d.options)).length===Object.keys(object(e.options)).length&&Object.entries(object(d.options)).every(([k,v])=>object(e.options)[k]===v);});}
