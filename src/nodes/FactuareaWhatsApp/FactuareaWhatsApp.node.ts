import type {IExecuteFunctions,INodeType,INodeTypeDescription,INodeExecutionData,IDataObject} from 'n8n-workflow';
import {createWhatsAppClient,WhatsAppError} from './client';

export class FactuareaWhatsApp implements INodeType {
 description:INodeTypeDescription={displayName:'Factuarea WhatsApp',name:'factuareaWhatsApp',icon:'file:../FactuareaCrm/factuarea.svg',group:['transform'],version:1,description:'Prepare a native draft, obtain explicit human approval and Send once; recover only by Original GET',defaults:{name:'Factuarea WhatsApp'},inputs:['main'],outputs:['main'],credentials:[{name:'factuareaApi',required:true}],properties:[
  {displayName:'Operation',name:'operation',type:'options',default:'prepare',options:[{name:'Prepare Human Review',value:'prepare'},{name:'Send Approved Preparation',value:'send'},{name:'Read Original',value:'original'}]},
  {displayName:'Conversation ID',name:'conversation_id',type:'string',required:true,default:'',displayOptions:{show:{operation:['prepare']}}},
  {displayName:'Draft Message ID',name:'message_id',type:'string',required:true,default:'',displayOptions:{show:{operation:['prepare']}}},
  {displayName:'Purpose',name:'purpose',type:'options',required:true,default:'contact_request',options:[{name:'Contact Request',value:'contact_request'},{name:'Marketing',value:'marketing'}],displayOptions:{show:{operation:['prepare']}}},
  {displayName:'Approved Native Template Selection (JSON)',name:'template_json',type:'json',default:'null',displayOptions:{show:{operation:['prepare']}},description:'Optional actual approved provider selection; sender, recipient and body come from the native draft'},
  {displayName:'Saved WhatsApp Preparation',name:'prepared_whatsapp_json',type:'string',typeOptions:{rows:6},required:true,default:'',displayOptions:{show:{operation:['send','original']}}},
  {displayName:'A Person Approved This Exact Preview',name:'human_confirmed',type:'boolean',required:true,default:false,displayOptions:{show:{operation:['send']}},description:'Require an actual human review of recipient, body, purpose and template before this execution'},
  {displayName:'Approved Snapshot Digest',name:'approval_snapshot_digest',type:'string',required:true,default:'',displayOptions:{show:{operation:['send']}},description:'The retained digest belonging to the preview the person approved'},
 ]};
 async execute(this:IExecuteFunctions):Promise<INodeExecutionData[][]>{
  const output:INodeExecutionData[]=[];
  for(let i=0;i<this.getInputData().length;i++)try{
   const operation=String(this.getNodeParameter('operation',i));
   if(operation==='send'&&this.getNode().retryOnFail===true)throw new WhatsAppError('Disable Retry On Fail for Send. Uncertain results use only Original GET.','unsafe_write_retry');
   const credentials=await this.getCredentials('factuareaApi'),selected=credentials.apiKey;
   if(typeof selected!=='string'||!/^fact_live_[A-Za-z0-9]{24}$/.test(selected))throw new WhatsAppError('Use the genuine live native API key. The native owner denies external sandbox delivery.','invalid_credential');
   const api=createWhatsAppClient(async options=>{
    if(this.getExecutionCancelSignal()?.aborted)throw new WhatsAppError('The execution was cancelled before dispatch.','execution_cancelled');
    if(options.method==='POST'){
     if((await this.getCredentials('factuareaApi')).apiKey!==selected)throw new WhatsAppError('The original credential changed before Send. Preserve the preparation.','credential_changed',403);
     return this.helpers.httpRequest({...options,headers:{...options.headers,Authorization:'Bearer '+selected}});
    }
    return this.helpers.httpRequestWithAuthentication.call(this,'factuareaApi',options);
   },credentials.baseUrl);
   let result:IDataObject;
   if(operation==='prepare'){
    const raw=this.getNodeParameter('template_json',i,'null');let template:unknown;
    try{template=typeof raw==='string'?JSON.parse(raw):raw;}catch{throw new WhatsAppError('Use the native template selection JSON.','invalid_input');}
    result=await api.prepare({conversation_id:this.getNodeParameter('conversation_id',i),message_id:this.getNodeParameter('message_id',i),purpose:this.getNodeParameter('purpose',i),template});
   }else if(operation==='send')result=await api.send(this.getNodeParameter('prepared_whatsapp_json',i),this.getNodeParameter('human_confirmed',i,false),this.getNodeParameter('approval_snapshot_digest',i,''));
   else if(operation==='original')result=await api.original(this.getNodeParameter('prepared_whatsapp_json',i));
   else throw new WhatsAppError('Choose a native WhatsApp operation.','invalid_operation');
   output.push({json:result,pairedItem:{item:i}});
  }catch(error){const safe=error instanceof WhatsAppError?error:new WhatsAppError('This native WhatsApp item could not complete.','whatsapp_error');if(!this.continueOnFail())throw safe;output.push({json:{error:safe.toJSON()},pairedItem:{item:i}});}
  return [output];
 }
}
