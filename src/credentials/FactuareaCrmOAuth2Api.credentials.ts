import type { ICredentialType, INodeProperties, ICredentialTestRequest } from 'n8n-workflow';

/** Native CRM OAuth credential, separate from the genuine Factuarea API-key trigger credential. */
export class FactuareaCrmOAuth2Api implements ICredentialType {
 name = 'factuareaCrmOAuth2Api';
 displayName = 'Factuarea CRM OAuth2';
 documentationUrl = 'https://docs.factuarea.com/guides/n8n';
 extends = ['oAuth2Api'];
 properties: INodeProperties[] = [
  {displayName: 'Issuer', name: 'issuer', type: 'string', required: true, default: '', description: 'The actual HTTPS origin of the registered native Factuarea OAuth deployment'},
  {displayName: 'Grant Type', name: 'grantType', type: 'hidden', default: 'pkce'},
  {displayName: 'Authorization URL', name: 'authUrl', type: 'hidden', default: '={{$credentials.issuer}}/api/oauth/authorize'},
  {displayName: 'Access Token URL', name: 'accessTokenUrl', type: 'hidden', default: '={{$credentials.issuer}}/api/oauth/token'},
  {displayName: 'Authentication', name: 'authentication', type: 'hidden', default: 'header'},
  {displayName: 'CRM Operations', name: 'crmScopes', type: 'multiOptions', required: true, default: ['crm_leads.write'], options: ['crm_leads.read','crm_leads.write','crm_opportunities.read','crm_opportunities.write','crm_activities.read','crm_activities.write','crm_pipelines.read','crm_contact_people.read','crm_connections.write'].map(value => ({name: value, value})), description: 'Select only native operation scopes required by this workflow. Credential context read is always included.'},
  {displayName: 'Scope', name: 'scope', type: 'hidden', default: "={{ ['crm_access_context.read', ...$credentials.crmScopes].join(' ') }}"},
  {displayName: 'Base URL', name: 'baseUrl', type: 'hidden', default: 'https://api.factuarea.com/v1'},
 ];
 test: ICredentialTestRequest = {request: {method: 'GET', url: 'https://api.factuarea.com/v1/crm/credential-context', headers: {Accept: 'application/json'}}};
}
