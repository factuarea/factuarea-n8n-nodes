import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Synthetic HTTP fixtures only. This process never contacts a native backend.
export const key = 'fact_test_' + 'b'.repeat(24);
export const bearer = 'dev2n8n-installed-oauth-fixture';
export const refreshed = 'dev2n8n-installed-refreshed-fixture';
export const company = '019251c0-0000-7000-8000-000000000091';
export const credential = '019251c0-0000-7000-8000-000000000092';
export const client = '019251c0-0000-7000-8000-000000000093';
const scopes = ['account:read', 'crm_access_context:read', 'crm_leads:write', 'crm_opportunities:write', 'crm_activities:write'];
const operations = ['crm_leads.create', 'crm_opportunities.create', 'crm_activities.create'];
export function startFakeApi(runtime) {
  const calls = [];
  let scenario = 'normal';
  let tokenWasRefreshed = false;
  let sequence = 100;
  const uuid = () => '019251c0-0000-7000-8000-' + String(++sequence).padStart(12, '0');
  const server = https.createServer({key: fs.readFileSync(runtime + '/tls/key.pem'), cert: fs.readFileSync(runtime + '/tls/cert.pem')}, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const wire = Buffer.concat(chunks).toString('utf8');
    const path = new URL(req.url, 'https://api.factuarea.com').pathname;
    const actual = req.headers.authorization;
    const oauth = actual === 'Bearer ' + bearer || actual === 'Bearer ' + refreshed;
    const accepted = actual === 'Bearer ' + key || oauth;
    const call = {method: req.method, path, auth_model: oauth ? 'oauth' : 'api_key', credential_match: accepted,
      key: req.headers['idempotency-key'] ?? null, wire, sha256: crypto.createHash('sha256').update(wire, 'utf8').digest('hex')};
    calls.push(call);
    const send = (status, data) => {res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data));};
    if (path === '/api/oauth/token') {
      // The real installed SDK must perform refresh; a fixture never calls it for the node.
      const form = new URLSearchParams(wire);
      if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== 'dev2n8n-refresh-fixture') return send(400, {error: 'invalid_grant'});
      tokenWasRefreshed = true;
      call.wire = '[synthetic token request omitted]';
      return send(200, {access_token: refreshed, refresh_token: 'dev2n8n-refresh-successor-fixture', token_type: 'Bearer', expires_in: 3600});
    }
    if (!accepted) return send(401, {error: {code: 'unauthorized', message: 'Synthetic credential denied.'}});
    if (scenario === 'refresh' && path === '/v1/crm/credential-context' && !tokenWasRefreshed) return send(401, {error: {code: 'expired_token'}});
    if (req.method === 'GET' && path === '/v1/account') return send(200, {data: {company: {id: company}, api_key: {id: credential, environment: 'test', scopes}}});
    if (req.method === 'GET' && path === '/v1/crm/credential-context') return send(200, {data: {company_id: company, credential_id: credential, client_id: client, environment: 'test', scopes, authorization_version: 'dev2n8n-c7-82'}});
    if (req.method === 'GET' && path === '/v1/crm/access-context') return send(200, {data: {
      scope: {mode: 'company', owner_ids: [], team_ids: [], authorization_version: 'dev2n8n-c7-82'},
      authorization_version: 'dev2n8n-c7-82', sandbox: true,
      availability: operations.map(operation => ({operation, available: scenario !== 'revoked', sandbox_policy: 'allow_local'})),
    }});
    if (req.method === 'POST' && ['/v1/crm/leads', '/v1/crm/opportunity', '/v1/crm/crmactivity'].includes(path)) {
      if (typeof call.key !== 'string') return send(400, {error: {code: 'missing_original_key'}});
      const body = JSON.parse(wire);
      call.body = body;
      if (path === '/v1/crm/leads' && /error(?:422|429|503)/.test(call.key)) {
        const status = Number(call.key.match(/error(422|429|503)/)[1]);
        if (status === 429) res.setHeader('Retry-After', '3');
        return send(status, {error: {code: status === 422 ? 'validation_failed' : 'fixture_unconfirmed', message: 'Synthetic HTTP error.', details: {errors: {email: ['Synthetic invalid email.']}}}});
      }
      const id = uuid(); call.result_id = id;
      if (path.endsWith('/crmactivity')) return send(201, {data: {state: 'confirmed', effect_id: uuid(), activity_id: id, activity: null}});
      return send(201, {data: {id, version: 1, confirmed: true}});
    }
    return send(404, {error: {code: 'fixture_route_not_allowed'}});
  });
  return {
    server, calls,
    reset(value = 'normal') {calls.length = 0; scenario = value; tokenWasRefreshed = false;},
    async listen() {await new Promise((resolve, reject) => {server.once('error', reject); server.listen(443, '127.0.0.1', resolve);});},
    async close() {await new Promise(resolve => server.close(resolve));},
  };
}
