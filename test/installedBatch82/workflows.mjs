import {key, bearer, company, credential, client} from './fake-api.mjs';

export function credentials() {
  return [
    {id: 'dev2n8nApi82', name: 'Dev2 n8n synthetic API', type: 'factuareaApi', data: {apiKey: key, baseUrl: 'https://api.factuarea.com/v1'}},
    {id: 'dev2n8nHeader82', name: 'Dev2 n8n local webhook header', type: 'httpHeaderAuth', data: {name: 'X-Dev2n8n-Fixture', value: 'localhost-fixture-only'}},
    {id: 'dev2n8nOAuth82', name: 'Dev2 n8n synthetic OAuth', type: 'factuareaCrmOAuth2Api', data: {
      issuer: 'https://api.factuarea.com', baseUrl: 'https://api.factuarea.com/v1', clientId: client, clientSecret: 'dev2n8n-synthetic-client-secret',
      grantType: 'pkce', authentication: 'header', authUrl: 'https://api.factuarea.com/api/oauth/authorize', accessTokenUrl: 'https://api.factuarea.com/api/oauth/token',
      scope: 'crm_access_context.read crm_leads.write crm_opportunities.write crm_activities.write',
      crmScopes: ['crm_leads.write', 'crm_opportunities.write', 'crm_activities.write'],
      oauthTokenData: {access_token: bearer, refresh_token: 'dev2n8n-refresh-fixture', token_type: 'Bearer', expires_in: 3600},
    }},
  ];
}
export function configuredRecipe(original, oauth = false) {
  const recipe = structuredClone(original);
  recipe.id = oauth ? 'dev2n8nOAuthRecipe82' : 'dev2n8nKeyRecipe82';
  recipe.name = 'Dev2 n8n installed fixture ' + (oauth ? 'OAuth' : 'API key');
  recipe.active = false;
  for (const node of recipe.nodes) {
    if (node.type === 'n8n-nodes-factuarea.factuareaCrm') {
      node.parameters.authentication = oauth ? 'oauth2' : 'apiKey';
      node.credentials = oauth ? {factuareaCrmOAuth2Api: {id: 'dev2n8nOAuth82', name: 'Dev2 n8n synthetic OAuth'}} : {factuareaApi: {id: 'dev2n8nApi82', name: 'Dev2 n8n synthetic API'}};
    }
    if (node.name === 'Inbound') {
      node.parameters.path = oauth ? 'dev2n8n-oauth82' : 'dev2n8n-key82';
      node.webhookId = oauth ? 'dev2n8n-oauth-webhook82' : 'dev2n8n-key-webhook82';
      node.credentials = {httpHeaderAuth: {id: 'dev2n8nHeader82', name: 'Dev2 n8n local webhook header'}};
    }
    if (node.name === 'Prepare Create Opportunity') {
      node.parameters.pipelineId = '019251c0-0000-7000-8000-000000000094';
      node.parameters.stageId = '019251c0-0000-7000-8000-000000000095';
    }
    if (node.name === 'Prepare Create Follow-Up') node.parameters.body = "={{ {type: 'task', title: 'Follow up', timezone: 'Europe/Madrid', due_at: '2026-10-11T10:00:00Z'} }}";
  }
  return recipe;
}
export function perItemWorkflow() {
  return {id: 'dev2n8nItems82', name: 'Dev2 n8n installed per-item fixture', active: false, settings: {executionOrder: 'v1'}, nodes: [
    {id: 'dev2n8n-items-in', name: 'Request', type: 'n8n-nodes-base.webhook', typeVersion: 2.1, position: [0,0], webhookId: 'dev2n8n-items-webhook82', parameters: {httpMethod: 'POST', path: 'dev2n8n-items82', responseMode: 'responseNode', options: {}}},
    {id: 'dev2n8n-items-split', name: 'Inbound', type: 'n8n-nodes-base.splitOut', typeVersion: 1, position: [200,0], parameters: {fieldToSplitOut: 'body.items', include: 'noOtherFields', options: {destinationFieldName: 'body'}}},
    {id: 'dev2n8n-items-prepare', name: 'Prepare Items', type: 'n8n-nodes-factuarea.factuareaCrm', typeVersion: 1, position: [400,0], onError: 'continueRegularOutput', parameters: {resource: 'lead', operation: 'prepareCreate', authentication: 'apiKey', environment: 'sandbox', body: "={{ {name: $json.body.name, email: $json.body.email, source: 'manual'} }}", idempotencyKey: "={{ 'installed:' + $json.body.eventId + ':lead' }}"}, credentials: {factuareaApi: {id: 'dev2n8nApi82', name: 'Dev2 n8n synthetic API'}}},
    {id: 'dev2n8n-items-submit', name: 'Submit Items', type: 'n8n-nodes-factuarea.factuareaCrm', typeVersion: 1, position: [600,0], onError: 'continueRegularOutput', parameters: {resource: 'lead', operation: 'create', authentication: 'apiKey', environment: 'sandbox', prepared: '={{ $json.prepared }}'}, credentials: {factuareaApi: {id: 'dev2n8nApi82', name: 'Dev2 n8n synthetic API'}}},
    {id: 'dev2n8n-items-response', name: 'Respond Items', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, position: [800,0], parameters: {respondWith: 'json', responseBody: '={{ $input.all().map(item => item.json) }}', options: {responseCode: 200}}},
  ], connections: {
    Request: {main: [[{node:'Inbound',type:'main',index:0}]]},
    Inbound: {main: [[{node:'Prepare Items',type:'main',index:0}]]},
    'Prepare Items': {main: [[{node:'Submit Items',type:'main',index:0}]]},
    'Submit Items': {main: [[{node:'Respond Items',type:'main',index:0}]]},
  }, pinData: {}};
}
