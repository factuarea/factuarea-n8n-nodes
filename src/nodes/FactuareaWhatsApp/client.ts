import type {IDataObject,IHttpRequestOptions} from 'n8n-workflow';
import {createHash} from 'node:crypto';

export class WhatsAppError extends Error {
 constructor(message:string,readonly code:string,readonly status?:number,readonly unconfirmed=false,readonly original?:string){super(message);}
 toJSON():IDataObject{return {message:this.message,code:this.code,...(this.status===undefined?{}:{status:this.status}),unconfirmed:this.unconfirmed,...(this.original===undefined?{}:{original:this.original})};}
}
type ObjectData=Record<string,unknown>;
const DATA=['conversation_id','message_id','effect_id','expected_version','message_version','purpose','sender','recipient','body','template','preparation_token','snapshot_digest','authorization_version'];
const WIRE=['conversation_id','effect_id','expected_version','message_version','purpose','template','preparation_token'];
const hash=(wire:string)=>createHash('sha256').update(wire,'utf8').digest('hex');
function closed(value:unknown,fields:readonly string[]):ObjectData {if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k)))throw new WhatsAppError('Preserve the closed native WhatsApp contract.','invalid_native_contract');return value as ObjectData;}
function id(value:unknown):string {if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))throw new WhatsAppError('Use the existing native public UUID.','invalid_uuid');return value;}
function text(value:unknown,max:number):string {if(typeof value!=='string'||!value.trim()||value.length>max)throw new WhatsAppError('The native field is invalid.','invalid_native_contract');return value;}
function participant(value:unknown,recipient=false){const p=closed(value,recipient?['channel','phone','name','kind']:['channel','phone','name']);if(p.channel!=='whatsapp'||typeof p.phone!=='string'||!/^\+[1-9][0-9]{5,14}$/.test(p.phone)||p.name!==null&&typeof p.name!=='string'||recipient&&p.kind!=='to')throw new WhatsAppError('Use the actual native sender and recipient.','invalid_native_contract');}
function preparation(value:unknown):ObjectData {
 const d=closed(value,DATA);for(const key of ['conversation_id','message_id','effect_id'])id(d[key]);
 for(const key of ['expected_version','message_version'])if(!Number.isSafeInteger(d[key])||Number(d[key])<1)throw new WhatsAppError('Preserve the native CAS.','invalid_native_contract');
 if(!['contact_request','marketing'].includes(String(d.purpose))||typeof d.snapshot_digest!=='string'||!/^[a-f0-9]{64}$/.test(d.snapshot_digest))throw new WhatsAppError('Preserve the native purpose and snapshot digest.','invalid_native_contract');
 participant(d.sender);participant(d.recipient,true);text(d.body,4096);text(d.preparation_token,65536);text(d.authorization_version,255);
 if(d.template!==null&&(typeof d.template!=='object'||Array.isArray(d.template)))throw new WhatsAppError('Use the actual approved native template selection.','invalid_native_contract');return d;
}
function wire(d:ObjectData):string {const value=JSON.stringify(Object.fromEntries(WIRE.map(k=>[k,d[k]])));if(Buffer.byteLength(value,'utf8')>65536)throw new WhatsAppError('The original wire exceeds the native limit.','invalid_original');return value;}
interface Context {company:string;credential:string;environment:'live';authModel:'api_key'}
interface Snapshot {protocol:'factuarea-whatsapp-human-v1';preparation:ObjectData;original_wire:string;original_wire_sha256:string;context:Context}
function snapshot(value:unknown):Snapshot {
 const raw=text(value,393216);let decoded;try{decoded=JSON.parse(raw);}catch{throw new WhatsAppError('Use the saved preparation JSON.','invalid_original');}
 const s=closed(decoded,['protocol','preparation','original_wire','original_wire_sha256','context']),d=preparation(s.preparation),c=closed(s.context,['company','credential','environment','authModel']);id(c.company);id(c.credential);
 if(s.protocol!=='factuarea-whatsapp-human-v1'||c.environment!=='live'||c.authModel!=='api_key'||typeof s.original_wire!=='string'||s.original_wire!==wire(d)||s.original_wire_sha256!==hash(s.original_wire))throw new WhatsAppError('Preserve the exact original WhatsApp preparation.','invalid_original');
 return s as unknown as Snapshot;
}
function receipt(value:unknown):ObjectData {
 const r=closed(value,['status','provider_message_id','submitted_at','reason_code']);
 if(r.status!=='confirmed'||typeof r.provider_message_id!=='string'||!/^wamid\.[A-Za-z0-9+\/_=-]+$/.test(r.provider_message_id)||typeof r.submitted_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.submitted_at)||r.reason_code!==null)throw new WhatsAppError('The native provider has not confirmed this original. Use Original GET without another Send.','unconfirmed_delivery',undefined,true);
 return r;
}
export function createWhatsAppClient(request:(options:IHttpRequestOptions)=>Promise<unknown>,baseUrl:unknown) {
 if(baseUrl!=='https://api.factuarea.com/v1')throw new WhatsAppError('Use the official native API base URL.','invalid_api_host');
 async function http(path:string,method:'GET'|'POST'='GET',body?:string,qs?:ObjectData,original?:string):Promise<unknown>{
  let response;try{response=await request({url:baseUrl+path,method,body,qs:qs as IDataObject|undefined,json:false,returnFullResponse:true,ignoreHttpStatusErrors:true,disableFollowRedirect:true,timeout:30000,headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})}});}catch(error){if(error instanceof WhatsAppError)throw error;throw new WhatsAppError('The native request could not complete. Preserve the original preparation.','native_request_unavailable',undefined,method==='POST',original);}
  const r=response as {statusCode?:number;body?:unknown};if(!r||!Number.isInteger(r.statusCode)||r.statusCode!==200)throw new WhatsAppError('The native request was denied or unavailable.','native_request_denied',r?.statusCode,method==='POST'&&Number(r?.statusCode)>=500,original);
  try{return typeof r.body==='string'?JSON.parse(r.body):r.body;}catch{throw new WhatsAppError('The native response is invalid. Preserve the original preparation.','invalid_native_contract',undefined,method==='POST',original);}
 }
 async function authority(scope:string,saved?:Context):Promise<Context>{
  const frame=await http('/account') as {data?:{company?:{id?:unknown};api_key?:{id?:unknown;environment?:unknown;scopes?:unknown}}},c=frame?.data?.company,k=frame?.data?.api_key;
  const company=id(c?.id),credential=id(k?.id),scopes=k?.scopes;
  if(k?.environment!=='live'||!Array.isArray(scopes)||scopes.some(s=>typeof s!=='string')||!['account:read',scope].every(s=>scopes.includes(s)||scopes.includes('*'))||saved&&(saved.company!==company||saved.credential!==credential||saved.environment!==k.environment))throw new WhatsAppError('The original native credential, realm or scope changed. Do not Send again.','credential_changed',403);
  return {company,credential,environment:'live',authModel:'api_key'};
 }
 const path=(d:ObjectData,suffix:string)=>'/crm/conversation/'+id(d.conversation_id)+'/messages/'+id(d.message_id)+'/whatsapp-cloud/'+suffix;
 const query=(d:ObjectData,revalidate=false)=>({purpose:d.purpose,...(d.template!==null?{template:JSON.stringify(d.template)}:{}),...(revalidate?{preparation_token:d.preparation_token}:{})});
 return {
  async prepare(input:unknown):Promise<IDataObject>{
   const d=closed(input,['conversation_id','message_id','purpose','template']);id(d.conversation_id);id(d.message_id);
   if(!['contact_request','marketing'].includes(String(d.purpose))||d.template!==null&&(typeof d.template!=='object'||Array.isArray(d.template)))throw new WhatsAppError('Select the actual purpose and approved template.','invalid_input');
   const context=await authority('conversations:write'),frame=await http(path(d,'preparation'),'GET',undefined,query(d)) as {data?:unknown},p=preparation(frame?.data);
   if(p.conversation_id!==d.conversation_id||p.message_id!==d.message_id||p.purpose!==d.purpose||JSON.stringify(p.template)!==JSON.stringify(d.template))throw new WhatsAppError('The preparation belongs to a different native draft.','invalid_native_contract');
   const original_wire=wire(p),saved:Snapshot={protocol:'factuarea-whatsapp-human-v1',preparation:p,original_wire,original_wire_sha256:hash(original_wire),context};
   return {id:p.effect_id as string,prepared_whatsapp_json:JSON.stringify(saved),preview:p as IDataObject,original_wire,original_wire_sha256:saved.original_wire_sha256,approval_snapshot_digest:p.snapshot_digest as string};
  },
  async send(savedValue:unknown,humanConfirmed:unknown,approvalDigest:unknown):Promise<IDataObject>{
   const s=snapshot(savedValue),d=s.preparation;
   if(humanConfirmed!==true||approvalDigest!==d.snapshot_digest)throw new WhatsAppError('An actual person must approve this exact recipient, body, purpose and template preview before Send.','human_confirmation_required');
   await authority('conversations:write',s.context);
   const current=preparation((await http(path(d,'preparation'),'GET',undefined,query(d,true)) as {data?:unknown}).data);
   if(JSON.stringify(current)!==JSON.stringify(d))throw new WhatsAppError('The preparation changed. Preserve the original human approval and do not Send.','preparation_changed',409);
   const response=await http(path(d,'send'),'POST',s.original_wire,undefined,String(savedValue));
   try{return {id:d.effect_id as string,...receipt((response as {data?:unknown}).data) as IDataObject,original_wire:s.original_wire,prepared_whatsapp_json:String(savedValue)};}catch{throw new WhatsAppError('The provider did not confirm this original. Use Original GET without another Send.','unconfirmed_delivery',undefined,true,String(savedValue));}
  },
  async original(savedValue:unknown):Promise<IDataObject>{
   const s=snapshot(savedValue),d=s.preparation;await authority('conversations:read',s.context);
   const frame=await http(path(d,'original'),'GET',undefined,{original_wire:s.original_wire}) as {data?:unknown},o=closed(frame?.data,['state','conversation_id','message_id','effect_id','original_wire_hash','preparation_digest','receipt']);
   if(o.state!=='confirmed'||o.conversation_id!==d.conversation_id||o.message_id!==d.message_id||o.effect_id!==d.effect_id||o.original_wire_hash!==s.original_wire_sha256||o.preparation_digest!==d.snapshot_digest)throw new WhatsAppError('This original is not confirmed or differs from the saved preparation. No state permits another Send.','original_unconfirmed',undefined,true,String(savedValue));
   return {id:d.effect_id as string,...o as IDataObject,receipt:receipt(o.receipt) as IDataObject,original_wire:s.original_wire};
  },
 };
}
