// Read only the native encrypted export of this new private fixture instance.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const requireEngine = createRequire('/usr/local/lib/node_modules/n8n/package.json');
const {unzipSync} = requireEngine('fflate');
const {Cipher} = requireEngine('n8n-core');
const cipher = new Cipher({encryptionKey: process.env.N8N_ENCRYPTION_KEY});
const files = unzipSync(fs.readFileSync('/dev2n8n-runtime/dev2n8n-native-entities/entities.zip'));
const decode = name => cipher.decryptWithInstanceKey(Buffer.from(files[name]).toString('utf8').trim()).trim().split('\n').map(line => JSON.parse(line));
const entities = decode('executionentity.jsonl');
const data = decode('executiondata.jsonl');
const perItem = entities.find(row => row.workflowId === 'dev2n8nItems82');
assert.ok(perItem, 'Native execution export lacks the per-item workflow.');
const raw = data.find(row => String(row.executionId) === String(perItem.id));
assert.ok(raw);
const run = requireEngine('flatted').parse(raw.data);
const items = run.resultData.runData['Submit Items'][0].data.main[0];
assert.equal(items.length, 2);
assert.deepEqual(items.map(item => item.pairedItem), [{item: 0}, {item: 1}]);
assert.equal(items[0].json._factuarea.confirmed, true);
assert.ok(items[1].json.error);
const observations = {
  native_export_carrier: 'n8n export:entities --includeExecutionHistoryDataTables',
  decryption: 'actual installed n8n-core Cipher, private fixture key only',
  execution_id: String(perItem.id),
  workflow_id: perItem.workflowId,
  paired_items: items.map(item => item.pairedItem),
  first_item_confirmed: items[0].json._factuarea.confirmed,
  second_item_has_error: Boolean(items[1].json.error),
  original_keys: items.map(item => item.json._factuarea?.idempotencyKey ?? item.json.error?.original?.idempotencyKey ?? null),
};
fs.writeFileSync('/dev2n8n-runtime/native-pairing-observation.json', JSON.stringify(observations, null, 2) + '\n', {mode: 0o600});
console.log('Native encrypted execution export verified two original item pairings.');
