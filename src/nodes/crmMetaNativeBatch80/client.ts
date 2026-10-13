import type {IDataObject,IHttpRequestOptions} from 'n8n-workflow';
import {MetaContractError,closed,object,projection,request,text} from './contract';
import type {MetaOperation} from './contract';
export class MetaError extends Error {
 constructor(readonly code:string,readonly status?:number,readonly unconfirmed=false){super('Native Meta: '+code);}
 toJSON():IDataObject{return {code:this.code,message:this.message,...(this.status===undefined?{}:{status:this.status}),unconfirmed:this.unconfirmed};}
}
export function createMetaClient(send:(options:IHttpRequestOptions)=>Promise<unknown>,context:{baseUrl:unknown;authModel:'api_key'|'oauth2';clientId?:unknown}) {
 if(context.baseUrl!=='https://api.factuarea.com/v1')throw new MetaError('invalid_native_host');
 async function http(path:string,method:'GET'|'POST'|'PUT'='GET',body?:string) {
  let response:unknown;try{response=await send({url:context.baseUrl+path,method,body,json:false,returnFullResponse:true,ignoreHttpStatusErrors:true,disableFollowRedirect:true,timeout:30000,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})}});}catch(error){if(error instanceof MetaError)throw error;throw new MetaError('unconfirmed_native_request',undefined,method!=='GET');}
  const frame=response as {statusCode?:number;body?:unknown};let payload:unknown;try{payload=typeof frame?.body==='string'?JSON.parse(frame.body):frame?.body;}catch{throw new MetaError('invalid_native_response',undefined,method!=='GET');}
  if(frame?.statusCode!==200){let code='meta_native_unavailable';try{const value=object(payload).error;if(typeof value==='string'&&/^(meta_oauth_[a-z_]{1,100}|provider_not_released)$/.test(value))code=value;}catch{/* Closed errors never carry provider payloads, code/state or secrets. */}throw new MetaError(code,frame?.statusCode,method!=='GET'&&(frame?.statusCode===409||frame?.statusCode===429||Number(frame?.statusCode)>=500));}
  return payload;
 }
 const publicUuid=(value:unknown)=>{if(typeof value!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new MetaError('invalid_native_context');};
 async function authority(){
  const response=await http(context.authModel==='oauth2'?'/crm/credential-context':'/account'),data=object(object(response).data);
  let scopes:unknown,environment:unknown;
  if(context.authModel==='oauth2'){closed(data,['company_id','credential_id','client_id','environment','scopes','authorization_version']);publicUuid(data.company_id);publicUuid(data.credential_id);publicUuid(data.client_id);text(data.authorization_version,16384);if(data.client_id!==context.clientId)throw new MetaError('native_client_changed',403);scopes=data.scopes;environment=data.environment;}
  else{publicUuid(object(data.company).id);const key=object(data.api_key);publicUuid(key.id);scopes=key.scopes;environment=key.environment;}
  const required=context.authModel==='oauth2'?['crm_access_context:read','crm_connections:write']:['account:read','crm_connections:write'];
  if(environment!=='live'||!Array.isArray(scopes)||scopes.some(s=>typeof s!=='string')||required.some(s=>!scopes.includes(s)&&!scopes.includes('*')))throw new MetaError('current_native_authority_required',403);
 }
 return {async execute(operation:MetaOperation,values:unknown):Promise<IDataObject>{try{const r=request(operation,values);await authority();const data=projection(await http(r.path,r.method,r.body),r);return {...data as IDataObject,native_projection_json:JSON.stringify(data),...(r.body===undefined||operation==='completeOAuth'?{}:{original_request_body:r.body})};}catch(error){if(error instanceof MetaContractError)throw new MetaError(error.code,error.status);throw error;}}};
}
