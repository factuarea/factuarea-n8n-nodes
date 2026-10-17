// Generates test/vectors/account-envelope-vectors.json: signed ACCOUNT envelopes.
//
// Envelope key order and values follow AccountWebhookEnvelopeFactory.php:66-79; the body is the
// compact JSON of that array (json_encode with JSON_UNESCAPED_SLASHES; every value here is ASCII, so
// JSON.stringify yields the same bytes). The header follows HmacSignatureGenerator::sign():
// `t=<unix>,v1=<hex>[,v1=<hex>]`, HMAC-SHA256 over `<unix>.<rawBody>`, lowercase hex.
// Secrets and timestamps are fixed, so the output is byte for byte deterministic.
//
// Usage: node scripts/generate-account-envelope-vectors.mjs
// It needs no OpenAPI document: every value is fixed in this file.
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'test',
	'vectors',
	'account-envelope-vectors.json',
);
const COMMAND = 'node scripts/generate-account-envelope-vectors.mjs';

const SECRET = 'whsec_a1c0ffee00000000000000000000aa01';
const OTHER_SECRET = 'whsec_b2d1ffee00000000000000000000bb02';
const NEW_SECRET = 'whsec_c3e2ffee00000000000000000000cc03';

const ACCOUNT_ID = '019251c0-0000-7000-8000-00000000ac01';
const COMPANY_A = '019251c0-0000-7000-8000-00000000ca01';
const COMPANY_B = '019251c0-0000-7000-8000-00000000cb02';
const T = 1767225600;

function envelope({ id, type, created, relationship, companyId, data }) {
	return {
		id,
		type,
		api_version: '2026-01-01',
		created,
		livemode: true,
		test: false,
		correlation_id: null,
		account: { id: ACCOUNT_ID },
		account_relationship: relationship,
		company_id: companyId,
		data,
	};
}

const hmac = (secret, timestamp, raw) =>
	createHmac('sha256', secret).update(`${timestamp}.${raw}`, 'utf8').digest('hex');

function vector({ name, description, timestamp, env, signWith, expect, extra = {} }) {
	const rawBody = JSON.stringify(env);
	const header = `t=${timestamp},${signWith.map((s) => `v1=${hmac(s, timestamp, rawBody)}`).join(',')}`;
	return { name, description, timestamp, rawBody, header, expect, ...extra };
}

const vectors = [
	vector({
		name: 'valid_account_event',
		description:
			'A delivery about a tax id of the account itself (relationship own), signed with the secret the node holds. The verifier must accept it and the item must carry account, relationship and company_id.',
		timestamp: T,
		env: envelope({
			id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e01',
			type: 'invoice.paid',
			created: T,
			relationship: 'own',
			companyId: COMPANY_A,
			data: { invoice: { id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e0f', number: 'F2026-0001' } },
		}),
		signWith: [SECRET],
		expect: 'accept',
		extra: { companyId: COMPANY_A, relationship: 'own' },
	}),
	vector({
		name: 'signed_with_other_secret',
		description:
			'The same kind of delivery signed with a secret the node does not hold. The verifier must reject it with no_match and nothing may be emitted.',
		timestamp: T + 60,
		env: envelope({
			id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e02',
			type: 'invoice.created',
			created: T + 60,
			relationship: 'own',
			companyId: COMPANY_A,
			data: { invoice: { id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e1f', number: 'F2026-0002' } },
		}),
		signWith: [OTHER_SECRET],
		expect: 'reject',
		extra: { expectedReason: 'no_match', companyId: COMPANY_A, relationship: 'own' },
	}),
	vector({
		name: 'rotation_second_signature_matches',
		description:
			'Rotation grace window: the emitter signs with the new secret and then with the previous one. The node still holds the previous secret, which is the SECOND candidate, so the verifier must keep reading after a first candidate that does not match.',
		timestamp: T + 120,
		env: envelope({
			id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e03',
			type: 'invoice.paid',
			created: T + 120,
			relationship: 'managed',
			companyId: COMPANY_A,
			data: { invoice: { id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e2f', number: 'F2026-0003' } },
		}),
		signWith: [NEW_SECRET, SECRET],
		expect: 'accept',
		extra: { matchingCandidateIndex: 1, companyId: COMPANY_A, relationship: 'managed' },
	}),
	vector({
		name: 'nif_event_with_company_id',
		description:
			'An account.nif_added delivery about ANOTHER tax id of the account (company_id differs from the one in the valid vector). With a company filter set to the first company it must be acknowledged and dropped; with the filter set to this one it must be emitted.',
		timestamp: T + 180,
		env: envelope({
			id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e04',
			type: 'account.nif_added',
			created: T + 180,
			relationship: 'own',
			companyId: COMPANY_B,
			data: { company: { id: COMPANY_B } },
		}),
		signWith: [SECRET],
		expect: 'accept',
		extra: { companyId: COMPANY_B, relationship: 'own' },
	}),
	vector({
		name: 'member_added_without_company_id',
		description:
			'An account.member_added delivery: an event of the account itself, so company_id is null in the envelope. It must always be emitted, whatever the company filter says.',
		timestamp: T + 240,
		env: envelope({
			id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e05',
			type: 'account.member_added',
			created: T + 240,
			relationship: 'own',
			companyId: null,
			data: { member: { id: '0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4e5f', role: 'admin' } },
		}),
		signWith: [SECRET],
		expect: 'accept',
		extra: { companyId: null, relationship: 'own' },
	}),
];

const file = {
	$meta: {
		description:
			'Signed ACCOUNT webhook envelopes for the trigger tests. Each rawBody is the compact JSON of the envelope emitted by AccountWebhookEnvelopeFactory (id, type, api_version, created, livemode, test, correlation_id, account, account_relationship, company_id, data) and each header is what HmacSignatureGenerator::sign() builds. Secrets are synthetic fixtures. Do not edit by hand: regenerate with the command below.',
		emitter_envelope: 'Factuarea backend, AccountWebhookEnvelopeFactory (envelope keys and their order)',
		emitter_envelope_serialisation:
			'Factuarea backend, AccountWebhookEnvelopeFactory (json_encode with JSON_UNESCAPED_SLASHES)',
		emitter_signature: 'Factuarea backend, HmacSignatureGenerator (sign)',
		emitter_headers: 'Factuarea backend, DeliverAccountWebhookCommandHandler (delivery headers)',
		signed_material: '`${timestamp}` + "." + rawBody, HMAC-SHA256, lowercase hex',
		header_format: 't=<unix>,v1=<hex>[,v1=<hex>]',
		generated_with: COMMAND,
		determinism:
			'Secrets, ids and timestamps are fixed in the generator, so running it again rewrites the same bytes.',
		verification_note:
			'That verifySignature accepts every vector marked accept, and rejects the others with the stated reason, is checked by the package test suite.',
	},
	secret: SECRET,
	otherSecret: OTHER_SECRET,
	newSecret: NEW_SECRET,
	accountId: ACCOUNT_ID,
	companyA: COMPANY_A,
	companyB: COMPANY_B,
	vectors,
};

writeFileSync(OUT, JSON.stringify(file, null, '\t') + '\n');
console.log(`wrote ${vectors.length} vectors to ${OUT}`);
