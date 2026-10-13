import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {startFakeApi, key, bearer, refreshed} from './fake-api.mjs';
import {credentials, configuredRecipe, perItemWorkflow} from './workflows.mjs';

const runtime = process.env.DEV2N8N_RUNTIME;
assert.equal(runtime, '/dev2n8n-runtime');
const origin = 'http://127.0.0.1:17282';
const call = promisify(execFile);
const fake = startFakeApi(runtime);
const expected = JSON.parse(fs.readFileSync(runtime + '/original.workflow.json', 'utf8'));
let engine, cookie = '', owner, ws;
const summary = {engine_version: '2.42.6', runtime_node: process.version, fake_backend_only: true, network: 'none', cases: [], imports: []};
function privateJson(name, data) {fs.writeFileSync(runtime + '/' + name, JSON.stringify(data, null, 2) + '\n', {mode: 0o600});}
async function cli(name, args) {
  const result = await call('n8n', args, {timeout: 60000, maxBuffer: 10 * 1024 * 1024});
  fs.writeFileSync(runtime + '/' + name + '.log', result.stdout + result.stderr, {mode: 0o600});
  return result;
}
async function api(path, method = 'GET', body) {
  const response = await fetch(origin + path, {method, headers: {'Content-Type': 'application/json', Cookie: cookie, Origin: origin, 'push-ref': 'dev2n8n82'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000)});
  const text = await response.text();
  let data; try {data = JSON.parse(text);} catch {data = text;}
  return {status: response.status, data, cookies: response.headers.getSetCookie()};
}
async function importWorkflow(name, workflow) {
  privateJson(name + '.json', workflow);
  await cli(name + '-import', ['import:workflow', '--input=' + runtime + '/' + name + '.json', '--userId=' + owner]);
  summary.imports.push({name, id: workflow.id ?? null, via: 'native import:workflow'});
}
async function executeWebhook(workflowId, path, body, trigger = 'Inbound') {
  const start = await api('/rest/workflows/' + workflowId + '/run', 'POST', {triggerToStartFrom: {name: trigger}});
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.equal(start.data.data?.waitingForWebhook, true, JSON.stringify(start.data));
  const response = await fetch(origin + '/webhook-test/' + path, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Dev2n8n-Fixture': 'localhost-fixture-only'}, body: JSON.stringify(body), signal: AbortSignal.timeout(45000)});
  const data = await response.json();
  for (const secret of [key, bearer, refreshed, 'dev2n8n-synthetic-client-secret']) assert.equal(JSON.stringify(data).includes(secret), false);
  return {status: response.status, data};
}
async function record(name, action) {
  fake.reset();
  const result = await action();
  summary.cases.push({name, result: 'passed', calls: structuredClone(fake.calls)});
  privateJson('installed-result.json', summary);
  return result;
}
before(async () => {
  await fake.listen();
  const log = fs.openSync(runtime + '/engine.log', 'w', 0o600);
  engine = spawn('n8n', ['start'], {stdio: ['ignore', log, log]});
  fs.closeSync(log);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (engine.exitCode !== null) throw new Error('Native n8n startup failed: inspect private engine.log');
    try {
      const r = await fetch(origin + '/healthz/readiness');
      const settings = await api('/rest/settings');
      if (r.status === 200 && settings.status === 200 && typeof settings.data === 'object') {ready = true;break;}
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  assert.equal(ready, true, 'Native engine did not become healthy on loopback.');
  const setup = await api('/rest/owner/setup', 'POST', {email: 'dev2n8n@example.invalid', firstName: 'Dev2n8n', lastName: 'Fixture', password: 'Dev2n8n-Local-Fixture-Only-82!'});
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  privateJson('owner-setup-public-shape.json', {status: setup.status, body_type: typeof setup.data, keys: typeof setup.data === 'object' ? Object.keys(setup.data) : [], cookie_count: setup.cookies.length});
  owner = (setup.data.data ?? setup.data).id;
  cookie = setup.cookies.map(value => value.split(';')[0]).join('; ');
  assert.ok(owner && cookie);
  const types = await api('/types/nodes.json');
  assert.equal(types.status, 200);
  assert.ok(JSON.stringify(types.data).includes('n8n-nodes-factuarea.factuareaCrm'), 'Native engine did not load the actually installed community node.');
  privateJson('credentials.fixture.json', credentials());
  await cli('credentials-import', ['import:credentials', '--input=' + runtime + '/credentials.fixture.json', '--userId=' + owner]);
  const require = createRequire('/usr/local/lib/node_modules/n8n/package.json');
  const WebSocket = require('ws');
  ws = new WebSocket(origin.replace('http:', 'ws:') + '/rest/push?pushRef=dev2n8n82', {headers: {Cookie: cookie, Origin: origin}});
  await new Promise((resolve, reject) => {ws.once('open', resolve);ws.once('error', reject);});
  // The original has no host-owned workflow ID. The current CLI requires one.
  // Use the actual editor save/import carrier, which allocates that ID natively.
  const imported = await api('/rest/workflows', 'POST', expected);
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const originalId = imported.data.data.id;
  assert.ok(originalId);
  privateJson('original-native-import-receipt.json', {status: imported.status, workflow_id: originalId, carrier: 'POST /rest/workflows', input: 'original.workflow.json', active: imported.data.data.active});
  await cli('original-export', ['export:workflow', '--id=' + originalId, '--output=' + runtime + '/original.native-export.json']);
  summary.imports.push({name: 'original recipe', id: originalId, via: 'actual native editor import/save and native CLI export'});
  await importWorkflow('configured-key', configuredRecipe(expected));
  await importWorkflow('configured-oauth', configuredRecipe(expected, true));
  await importWorkflow('per-item', perItemWorkflow());
}, {timeout: 150000});
after(async () => {
  if (ws) ws.close();
  if (engine && engine.exitCode === null) {
    engine.kill('SIGTERM');
    await Promise.race([new Promise(resolve => engine.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 6000))]);
    if (engine.exitCode === null) engine.kill('SIGKILL');
  }
  await fake.close();
  privateJson('installed-result.json', summary);
});

test('native importer/exporter retains the real inactive recipe nodes, graph and absence of credentials', async () => record('real native import/export', async () => {
  const exported = JSON.parse(fs.readFileSync(runtime + '/original.native-export.json', 'utf8'));
  const original = exported.find(row => row.name === expected.name);
  assert.ok(original);
  assert.equal(original.active, false);
  const normalized = structuredClone(original.nodes);
  // The native importer allocates a host webhook ID, separate from event/entity IDs.
  for (const node of normalized) if (node.name === 'Inbound') {
    assert.match(node.webhookId, /^[0-9a-f-]{36}$/);
    delete node.webhookId;
  }
  assert.deepEqual(normalized, expected.nodes);
  assert.deepEqual(original.connections, expected.connections);
  assert.ok(original.nodes.every(node => node.credentials === undefined));
  assert.equal(fake.calls.length, 0);
}));
for (const oauth of [false, true]) test('installed native recipe links confirmed owner UUIDs using ' + (oauth ? 'actual OAuth helper' : 'genuine API-key helper'), async () => record('recipe ' + (oauth ? 'OAuth' : 'API key'), async () => {
  const response = await executeWebhook(oauth ? 'dev2n8nOAuthRecipe82' : 'dev2n8nKeyRecipe82', oauth ? 'dev2n8n-oauth82' : 'dev2n8n-key82', {eventId: oauth ? 'oauth-success82' : 'key-success82', name: 'Dev2 n8n ☕', email: 'fixture@example.invalid'});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.completed, true);
  const posts = fake.calls.filter(x => x.method === 'POST');
  assert.equal(posts.length, 3);
  const [lead, opportunity, activity] = posts;
  assert.equal(opportunity.body.lead_id, lead.result_id);
  assert.equal(activity.body.target.id, opportunity.result_id);
  assert.equal(response.data.leadId, lead.result_id);
  assert.equal(response.data.opportunityId, opportunity.result_id);
  assert.equal(response.data.activityId, activity.result_id);
  assert.equal(opportunity.body.amount, '125.0000');
  assert.equal(activity.body.timezone, 'Europe/Madrid');
  assert.ok(fake.calls.every(x => x.credential_match && x.auth_model === (oauth ? 'oauth' : 'api_key')));
  assert.ok(fake.calls.some(x => x.path === (oauth ? '/v1/crm/credential-context' : '/v1/account')));
}));
for (const status of [422, 429, 503]) test('installed recipe HTTP ' + status + ' stops after one POST without false completion or later effects', async () => record('recipe HTTP ' + status, async () => {
  const response = await executeWebhook('dev2n8nKeyRecipe82', 'dev2n8n-key82', {eventId: 'error' + status, name: 'Synthetic failure', email: 'failure@example.invalid'});
  assert.equal(response.status, 409, JSON.stringify(response.data));
  assert.notEqual(response.data.completed, true);
  const posts = fake.calls.filter(x => x.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, '/v1/crm/leads');
}));
test('installed engine preserves per-item pairing: successful first item and rejected second item', async () => record('native per-item success/error', async () => {
  const response = await executeWebhook('dev2n8nItems82', 'dev2n8n-items82', {items: [
    {eventId: 'item-success82', name: 'First synthetic item', email: 'first@example.invalid'},
    {eventId: 'error422', name: 'Second synthetic item', email: 'second@example.invalid'},
  ]}, 'Request');
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.ok(Array.isArray(response.data));assert.equal(response.data.length, 2);
  assert.equal(response.data[0]._factuarea.confirmed, true);
  assert.ok(response.data[1].error);assert.notEqual(response.data[1]._factuarea?.confirmed, true);
  assert.equal(fake.calls.filter(x => x.method === 'POST').length, 2);
  assert.equal(fake.calls.find(x => x.key?.includes('item-success82')).body.name, 'First synthetic item');
  assert.equal(fake.calls.find(x => x.key?.includes('error422')).body.name, 'Second synthetic item');
}));
test('actual current-authority rejection prevents all installed recipe mutations', async () => record('native current-authority denial', async () => {
  fake.reset('revoked');
  const response = await executeWebhook('dev2n8nKeyRecipe82', 'dev2n8n-key82', {eventId: 'revoked82', name: 'Denied fixture', email: 'denied@example.invalid'});
  assert.equal(response.status, 409);
  assert.equal(fake.calls.filter(x => x.method === 'POST').length, 0);
}));
