import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SHA256_HEX_DIGEST_LENGTH } from '../src/contract';
import { verifySignature } from '../src/verify/verifySignature';

/**
 * Shape of `test/vectors/signature-vectors.json`.
 *
 * The vectors were produced with the same algorithm as the emitter and then
 * recomputed by instantiating the emitter class itself — see the file's own
 * `generatedWith` and `verifiedAgainstEmitter` fields. Regenerate one with:
 *
 *   node -e 'const{createHmac}=require("node:crypto");
 *            const[s,t,b]=process.argv.slice(1);
 *            process.stdout.write(createHmac("sha256",s).update(t+"."+b).digest("hex")+"\n")' \
 *     "<secret>" "<timestamp>" "<rawBody>"
 */
interface SignatureVector {
	name: string;
	description: string;
	timestamp: number;
	rawBody: string;
	header: string;
	expect: 'accept' | 'reject';
	expectedReason?: string;
	matchingCandidateIndex?: number;
	reserialisationChangesBytes?: boolean;
}

interface SignatureVectorFile {
	secret: string;
	rotatedSecret: string;
	vectors: SignatureVector[];
}

/**
 * The vectors are read from disk rather than imported, because the compiled test
 * and the source test do not sit at the same depth: `dist/test/` reaches the
 * repository's `test/vectors/` two levels up, a test run straight from `test/`
 * reaches it alongside itself. Both candidates are tried and a miss is a loud
 * failure naming them, never a silent skip.
 */
function loadVectorFile(): SignatureVectorFile {
	const candidates = [
		join(__dirname, 'vectors', 'signature-vectors.json'),
		join(__dirname, '..', '..', 'test', 'vectors', 'signature-vectors.json'),
	];
	const found = candidates.find((path) => existsSync(path));

	if (found === undefined) {
		throw new Error(`signature vectors not found. Looked in: ${candidates.join(', ')}`);
	}

	return JSON.parse(readFileSync(found, 'utf8')) as SignatureVectorFile;
}

const vectorFile = loadVectorFile();

/** Fails loudly when a vector is renamed, instead of silently testing nothing. */
function vectorNamed(name: string): SignatureVector {
	const vector = vectorFile.vectors.find((candidate) => candidate.name === name);

	if (vector === undefined) {
		const known = vectorFile.vectors.map((candidate) => candidate.name).join(', ');
		throw new Error(`vector "${name}" is missing from the vector file. Present: ${known}`);
	}

	return vector;
}

/** Every `v1=` value of a header, in order of appearance. */
function candidatesOf(header: string): string[] {
	return header
		.split(',')
		.filter((pair) => pair.startsWith('v1='))
		.map((pair) => pair.slice('v1='.length));
}

function headerWith(timestamp: number, signatures: string[]): string {
	return [`t=${timestamp}`, ...signatures.map((signature) => `v1=${signature}`)].join(',');
}

describe('verifySignature', () => {
	it('accepts a delivery whose single candidate was signed with the stored secret', () => {
		const vector = vectorNamed('valid_single');

		const result = verifySignature(vector.rawBody, vector.header, vectorFile.secret);

		if (!result.ok) {
			assert.fail(`expected the golden signature to verify, got reason "${result.reason}"`);
		}
		assert.equal(result.timestamp, vector.timestamp);
		assert.deepEqual(result.signatures, candidatesOf(vector.header));
	});

	it('rejects a delivery whose signature was altered by one byte', () => {
		const vector = vectorNamed('tampered_single');

		const result = verifySignature(vector.rawBody, vector.header, vectorFile.secret);

		if (result.ok) {
			assert.fail('a signature altered by one byte must not verify');
		}
		assert.equal(result.reason, 'no_match');
	});

	it('accepts a rotation-window header whose SECOND candidate is the matching one', () => {
		const vector = vectorNamed('rotation_second_matches');
		const candidates = candidatesOf(vector.header);
		assert.equal(candidates.length, 2, 'the rotation vector must carry two candidates');

		const result = verifySignature(vector.rawBody, vector.header, vectorFile.secret);

		if (!result.ok) {
			assert.fail(
				`a delivery signed inside the rotation grace window must verify, got "${result.reason}"`,
			);
		}
		assert.equal(result.timestamp, vector.timestamp);

		// Proves the acceptance above came from the SECOND candidate: the first one
		// alone is rejected. Without this, a verifier that accepted anything would
		// pass the assertion above.
		const firstOnly = verifySignature(
			vector.rawBody,
			headerWith(vector.timestamp, [candidates[0] as string]),
			vectorFile.secret,
		);
		assert.equal(firstOnly.ok, false);

		// And the outcome does not depend on the position of the matching candidate,
		// which is what "every candidate is compared" means in practice.
		const swapped = verifySignature(
			vector.rawBody,
			headerWith(vector.timestamp, [...candidates].reverse()),
			vectorFile.secret,
		);
		assert.equal(swapped.ok, true);
	});

	it('accepts the raw body and REJECTS the same body serialised again', () => {
		const vector = vectorNamed('reserialisation_changes_bytes');
		const reserialised = JSON.stringify(JSON.parse(vector.rawBody));

		// Without this the test would be vacuous: a body whose reserialised form is
		// byte-identical would make the rejection below impossible to fail.
		assert.notEqual(
			reserialised,
			vector.rawBody,
			'this vector only means something while reserialising it changes the bytes',
		);

		const onRawBody = verifySignature(vector.rawBody, vector.header, vectorFile.secret);
		if (!onRawBody.ok) {
			assert.fail(`the raw body must verify, got reason "${onRawBody.reason}"`);
		}

		const onReserialised = verifySignature(reserialised, vector.header, vectorFile.secret);
		if (onReserialised.ok) {
			assert.fail(
				'the reserialised body verified: the raw body was replaced somewhere, and every real delivery carrying a \\uXXXX escape — which is every one with an accented character in it — would be rejected in production',
			);
		}
		assert.equal(onReserialised.reason, 'no_match');
	});

	it('discards a candidate of the wrong length instead of throwing', () => {
		const vector = vectorNamed('valid_single');
		const valid = candidatesOf(vector.header)[0] as string;

		// A short candidate next to the good one: `timingSafeEqual` would throw on it
		// if the length filter were removed, so reaching an acceptance proves the
		// filter ran and ran first.
		const withShortCandidate = verifySignature(
			vector.rawBody,
			headerWith(vector.timestamp, ['deadbeef', valid]),
			vectorFile.secret,
		);
		assert.equal(withShortCandidate.ok, true);

		// Nothing left to compare once the filter has run: distinct from "compared
		// and none matched", because the cause is the header and not the secret.
		const onlyShortCandidates = verifySignature(
			vector.rawBody,
			headerWith(vector.timestamp, ['deadbeef', '']),
			vectorFile.secret,
		);
		if (onlyShortCandidates.ok) {
			assert.fail('candidates that are not digest-length must never verify');
		}
		assert.equal(onlyShortCandidates.reason, 'no_candidates');

		// Digest-length but not hex, and not even ASCII. It survives the length filter
		// on purpose: the comparison has to encode it one byte per code unit, because
		// encoding it as UTF-8 would produce 128 bytes and make `timingSafeEqual`
		// throw — the crash the filter exists to prevent, reintroduced one line later.
		const nonAscii = 'ñ'.repeat(SHA256_HEX_DIGEST_LENGTH);
		assert.equal(nonAscii.length, SHA256_HEX_DIGEST_LENGTH);
		const withNonAsciiCandidate = verifySignature(
			vector.rawBody,
			headerWith(vector.timestamp, [nonAscii]),
			vectorFile.secret,
		);
		if (withNonAsciiCandidate.ok) {
			assert.fail('a non-hex candidate must never verify');
		}
		assert.equal(withNonAsciiCandidate.reason, 'no_match');
	});

	it('accepts no signature at all when the stored secret is empty', () => {
		for (const vector of vectorFile.vectors) {
			const result = verifySignature(vector.rawBody, vector.header, '');

			if (result.ok) {
				assert.fail(
					`vector "${vector.name}" verified against an EMPTY secret: a node that lost its secret would accept anything signed with the empty key`,
				);
			}
			assert.equal(result.reason, 'no_match');
		}
	});

	it('propagates the header parser reason instead of relabelling it', () => {
		const vector = vectorNamed('valid_single');

		const missing = verifySignature(vector.rawBody, undefined, vectorFile.secret);
		if (missing.ok) {
			assert.fail('a delivery with no signature header must never verify');
		}
		assert.equal(missing.reason, 'missing');

		const noSignatures = verifySignature(
			vector.rawBody,
			`t=${vector.timestamp}`,
			vectorFile.secret,
		);
		if (noSignatures.ok) {
			assert.fail('a header carrying no candidate must never verify');
		}
		assert.equal(noSignatures.reason, 'no_signatures');
	});

	it('hashes a Buffer byte for byte, and agrees with the string form on every vector', () => {
		// The trigger hands over the Buffer n8n gave it, so THIS is the path every
		// real delivery takes. Both forms are checked against each other on every
		// vector because a divergence would not look like a bug: it would look like
		// the node rejecting all traffic with a correct-looking signature.
		for (const vector of vectorFile.vectors) {
			const asBuffer = verifySignature(
				Buffer.from(vector.rawBody, 'utf8'),
				vector.header,
				vectorFile.secret,
			);
			const asString = verifySignature(vector.rawBody, vector.header, vectorFile.secret);

			assert.deepEqual(
				asBuffer,
				asString,
				`vector "${vector.name}" verifies differently as bytes and as a string`,
			);
		}
	});

	it('does not round-trip the bytes through UTF-8, which a string cannot avoid', () => {
		// The one case where the two forms MUST differ, and the reason the Buffer
		// overload exists. A byte sequence that is not valid UTF-8 survives as
		// itself in a Buffer; decoded to a string it becomes U+FFFD, and encoding
		// that back writes EF BF BD where other bytes were. The digest is then
		// computed over bytes nobody signed.
		const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
		const timestamp = 1767225600;
		const secret = vectorFile.secret;
		const digest = createHmac('sha256', secret)
			.update(`${timestamp}.`, 'utf8')
			.update(invalidUtf8)
			.digest('hex');
		const header = `t=${timestamp},v1=${digest}`;

		const asBuffer = verifySignature(invalidUtf8, header, secret);
		if (!asBuffer.ok) {
			assert.fail(`the bytes that were signed must verify, got reason "${asBuffer.reason}"`);
		}

		// And the proof that this is not a vacuous assertion: the decoded form,
		// which is what the node would hash if it stringified the body first, does
		// NOT verify.
		const asString = verifySignature(invalidUtf8.toString('utf8'), header, secret);
		if (asString.ok) {
			assert.fail('the UTF-8 round trip left the bytes unchanged: this test proves nothing as written');
		}
		assert.equal(asString.reason, 'no_match');
	});
});
