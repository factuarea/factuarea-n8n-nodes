import type {IExecuteFunctions,INodeType,INodeTypeDescription,INodeExecutionData,IDataObject} from 'n8n-workflow';
import {createMetaClient,MetaError} from './client';
import {META_ROUTES,object} from './contract';
import type {MetaOperation} from './contract';
const operations={options:'List Original Connections',mapping:'Read Published Mapping',inspect:'Inspect Original Fields',publishMapping:'Publish Reviewed Mapping',prepareOAuth:'Prepare Human Authorization',completeOAuth:'Complete Original Credentials',publishConsent:'Request Reviewed Consent'};
const records=['mapping','inspect','publishMapping','publishConsent'],forms=['mapping','inspect','publishMapping'],human=['prepareOAuth','publishMapping','publishConsent'];
export class FactuareaMeta implements INodeType {
 description:INodeTypeDescription={displayName:'Factuarea Meta CRM',name:'factuareaMeta',icon:'file:../FactuareaCrm/factuarea.svg',group:['transform'],version:1,description:'Seven original human Meta carriers with native CAS; unavailable App Review never activates Capture',defaults:{name:'Factuarea Meta CRM'},inputs:['main'],outputs:['main'],credentials:[{name:'factuareaApi',required:true,displayOptions:{show:{authentication:['apiKey']}}},{name:'factuareaCrmOAuth2Api',required:true,displayOptions:{show:{authentication:['oauth2']}}}],properties:[
 {displayName:'Authentication',name:'authentication',type:'options',default:'apiKey',options:[{name:'Genuine Factuarea API Key',value:'apiKey'},{name:'Native Factuarea OAuth2',value:'oauth2'}]},
 {displayName:'Operation',name:'operation',type:'options',default:'options',options:Object.entries(operations).map(([value,name])=>({name,value}))},
 {displayName:'Original Connection UUID',name:'connection_uuid',type:'string',required:true,default:'',displayOptions:{show:{operation:records}}},
 {displayName:'Published Capture Form UUID',name:'form_uuid',type:'string',required:true,default:'',displayOptions:{show:{operation:forms}}},
 {displayName:'Native Closed Choices (JSON)',name:'input_json',type:'json',required:true,default:'{}',displayOptions:{show:{operation:['inspect','publishMapping','prepareOAuth','publishConsent']}},description:'Preserve actual provider credential, remote IDs, field types/options and nullable CAS from Inspect. No tenant, actor, grants or secrets.'},
 {displayName:'Original State and Code (Private JSON)',name:'oauth_private_json',type:'string',typeOptions:{password:true},required:true,default:'',displayOptions:{show:{operation:['completeOAuth']}},description:'Only original state/code from the human callback; no tokens or client-family input'},
 {displayName:'A Person Confirmed These Exact Choices',name:'confirmed',type:'boolean',required:true,default:false,displayOptions:{show:{operation:human}},description:'Authorization, mapping and native capture consent require separate confirmation. Credentials do not approve App Review.'},
 ]};
 async execute(this:IExecuteFunctions):Promise<INodeExecutionData[][]>{const output:INodeExecutionData[]=[];for(let i=0;i<this.getInputData().length;i++)try{
  const operation=String(this.getNodeParameter('operation',i)) as MetaOperation;if(!Object.hasOwn(META_ROUTES,operation))throw new MetaError('invalid_operation');if(META_ROUTES[operation].method!=='GET'&&this.getNode().retryOnFail===true)throw new MetaError('unsafe_write_retry');
  const authentication=this.getNodeParameter('authentication',i,'apiKey');if(!['apiKey','oauth2'].includes(String(authentication)))throw new MetaError('invalid_native_authentication');const type=authentication==='oauth2'?'factuareaCrmOAuth2Api':'factuareaApi',credentials=await this.getCredentials(type);
  const token=authentication==='oauth2'?object(credentials.oauthTokenData).access_token:credentials.apiKey;
  if(typeof token!=='string'||!token||token.length>8192||/[\x00-\x20\x7f]/.test(token)||authentication==='apiKey'&&!/^fact_live_[A-Za-z0-9]{24}$/.test(token))throw new MetaError('invalid_native_credential');
  if(authentication==='oauth2'){const url=new URL(String(credentials.issuer));if(url.protocol!=='https:'||url.origin!==credentials.issuer||url.username||url.password)throw new MetaError('invalid_native_issuer');}
  const client=createMetaClient(async options=>{if(this.getExecutionCancelSignal()?.aborted)throw new MetaError('execution_cancelled');if(options.method!=='GET'){const current=await this.getCredentials(type),actual=authentication==='oauth2'?object(current.oauthTokenData).access_token:current.apiKey;if(actual!==token)throw new MetaError('native_credential_changed',403);return this.helpers.httpRequest({...options,headers:{...options.headers,Authorization:'Bearer '+token}});}return this.helpers.httpRequestWithAuthentication.call(this,type,options);},{baseUrl:credentials.baseUrl,authModel:authentication==='oauth2'?'oauth2':'api_key',clientId:credentials.clientId});
  const values:IDataObject={};if(records.includes(operation))values.connection_uuid=this.getNodeParameter('connection_uuid',i) as string;if(forms.includes(operation))values.form_uuid=this.getNodeParameter('form_uuid',i) as string;
  if(!['options','mapping'].includes(operation)){const raw=this.getNodeParameter(operation==='completeOAuth'?'oauth_private_json':'input_json',i);values.input_json=typeof raw==='string'?raw:JSON.stringify(raw);}
  if(human.includes(operation))values.confirmed=this.getNodeParameter('confirmed',i,false) as boolean;
  const result=await client.execute(operation,values);output.push({json:result,pairedItem:{item:i}});
 }catch(error){const safe=error instanceof MetaError?error:new MetaError('meta_native_item_failed');if(!this.continueOnFail())throw safe;output.push({json:{error:safe.toJSON()},pairedItem:{item:i}});}return [output];}
}
