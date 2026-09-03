/**
 * Tests for the `Factuarea-Signature` header reader.
 *
 * Written against the header format frozen in `src/contract.ts`, which was read
 * off the emitter and not invented. The two cases that matter most are the
 * rotation-window header — two candidates, both returned, in order — and the six
 * failure reasons, which are asserted one by one because collapsing them into
 * "it failed" would let the parser return the wrong reason forever without a
 * single test noticing.
 *
 * Results are compared as whole objects rather than field by field. A test that
 * only checked `reason` would pass on a result that also, wrongly, carried a
 * timestamp; comparing the whole shape pins both the success case and the
 * failure case to exactly the fields the contract declares.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSignatureHeader } from '../src/verify/parseSignatureHeader';

/** A plausible unix timestamp in seconds, and its literal spelling. */
const TIMESTAMP = 1_767_225_600;
const TIMESTAMP_TEXT = '1767225600';

/** Two 64-character lowercase hex digests, the shape the emitter produces. */
const CURRENT_SIGNATURE = 'a'.repeat(64);
const PREVIOUS_SIGNATURE = 'b'.repeat(64);

test('a header with one signature yields the timestamp and that signature', () => {
	const result = parseSignatureHeader(
		`t=${TIMESTAMP_TEXT},v1=${CURRENT_SIGNATURE}`,
	);

	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: [CURRENT_SIGNATURE],
	});
});

test('a rotation-window header yields both signatures, in order of appearance', () => {
	const result = parseSignatureHeader(
		`t=${TIMESTAMP_TEXT},v1=${CURRENT_SIGNATURE},v1=${PREVIOUS_SIGNATURE}`,
	);

	// Order matters and is asserted: the emitter puts the current secret first
	// and the previous one second, and a reader that kept only the first would
	// refuse every legitimate delivery for the whole rotation window.
	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: [CURRENT_SIGNATURE, PREVIOUS_SIGNATURE],
	});
});

test('an unknown pair alongside a valid signature is ignored, not rejected', () => {
	// The day the emitter adds a field, an already-installed copy of this node
	// has to keep working. This is that day, simulated.
	const result = parseSignatureHeader(
		`t=${TIMESTAMP_TEXT},v2=future,v1=${CURRENT_SIGNATURE},scheme=hmac-sha256`,
	);

	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: [CURRENT_SIGNATURE],
	});
});

test('whitespace around the commas is tolerated', () => {
	const result = parseSignatureHeader(
		` t=${TIMESTAMP_TEXT} , v1=${CURRENT_SIGNATURE} , v1=${PREVIOUS_SIGNATURE} `,
	);

	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: [CURRENT_SIGNATURE, PREVIOUS_SIGNATURE],
	});
});

test('candidates are returned unfiltered, length included', () => {
	// The length filter belongs to the verifier, which needs it to keep
	// `timingSafeEqual` from throwing. If it ever migrates into the parser, this
	// test is what says so.
	const result = parseSignatureHeader(`t=${TIMESTAMP_TEXT},v1=short,v1=`);

	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: ['short', ''],
	});
});

test('an absent header fails with "missing"', () => {
	assert.deepEqual(parseSignatureHeader(undefined), {
		ok: false,
		reason: 'missing',
	});
});

test('a blank header fails with "empty"', () => {
	assert.deepEqual(parseSignatureHeader(''), { ok: false, reason: 'empty' });
	assert.deepEqual(parseSignatureHeader('   '), { ok: false, reason: 'empty' });
});

test('a header with no readable pair fails with "malformed"', () => {
	assert.deepEqual(parseSignatureHeader('not-a-signature-header'), {
		ok: false,
		reason: 'malformed',
	});
	// A pair whose key is empty is not readable either.
	assert.deepEqual(parseSignatureHeader('=value,,  '), {
		ok: false,
		reason: 'malformed',
	});
});

test('readable pairs without a timestamp fail with "no_timestamp"', () => {
	assert.deepEqual(parseSignatureHeader(`v1=${CURRENT_SIGNATURE}`), {
		ok: false,
		reason: 'no_timestamp',
	});
});

test('a non-numeric timestamp fails with "invalid_timestamp"', () => {
	assert.deepEqual(
		parseSignatureHeader(`t=not-a-number,v1=${CURRENT_SIGNATURE}`),
		{ ok: false, reason: 'invalid_timestamp' },
	);

	// An empty value is not a base-10 integer either.
	assert.deepEqual(parseSignatureHeader(`t=,v1=${CURRENT_SIGNATURE}`), {
		ok: false,
		reason: 'invalid_timestamp',
	});

	// Spellings `Number()` would happily accept, which is why it is not used on
	// its own: each of these would otherwise become a timestamp nobody sent.
	for (const spelling of ['1e9', '0x64', 'Infinity', '1767225600.5']) {
		assert.deepEqual(
			parseSignatureHeader(`t=${spelling},v1=${CURRENT_SIGNATURE}`),
			{ ok: false, reason: 'invalid_timestamp' },
			`expected ${spelling} to be rejected as a timestamp`,
		);
	}

	// Digits, but more of them than a double holds exactly. Rounding would hand
	// the tolerance check a value the header does not carry.
	assert.deepEqual(
		parseSignatureHeader(`t=99999999999999999999,v1=${CURRENT_SIGNATURE}`),
		{ ok: false, reason: 'invalid_timestamp' },
	);
});

test('a header with no v1 pair fails with "no_signatures"', () => {
	assert.deepEqual(parseSignatureHeader(`t=${TIMESTAMP_TEXT}`), {
		ok: false,
		reason: 'no_signatures',
	});

	// Unknown pairs alone do not make a signature.
	assert.deepEqual(parseSignatureHeader(`t=${TIMESTAMP_TEXT},v2=future`), {
		ok: false,
		reason: 'no_signatures',
	});
});

test('the first timestamp wins when a second one is appended', () => {
	// A repeated `t=` is an unknown pair by the tolerance rule. Honouring the
	// last one would let an appended pair override the timestamp the rest of the
	// header was built around.
	const result = parseSignatureHeader(
		`t=${TIMESTAMP_TEXT},v1=${CURRENT_SIGNATURE},t=1`,
	);

	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: [CURRENT_SIGNATURE],
	});
});

test('a value containing an equals sign is kept whole', () => {
	const result = parseSignatureHeader(`t=${TIMESTAMP_TEXT},v1=a=b`);

	assert.deepEqual(result, {
		ok: true,
		timestamp: TIMESTAMP,
		signatures: ['a=b'],
	});
});

test('no input makes the parser throw', () => {
	// The emitter treats a 4xx as a permanent failure and a 5xx as retryable. A
	// thrown exception here would surface as a 5xx, so a header that can never
	// become valid would be retried with backoff instead of being refused once.
	const hostileInputs: Array<string | undefined> = [
		undefined,
		'',
		' ',
		',,,,',
		'=',
		'==',
		't',
		't=',
		'v1',
		'v1=',
		't=1,v1',
		't=1,v1=a=b',
		'%',
		'a'.repeat(100_000),
		`t=${TIMESTAMP_TEXT},${'v1=x,'.repeat(1000)}`,
	];

	for (const input of hostileInputs) {
		assert.doesNotThrow(
			() => parseSignatureHeader(input),
			`parsing ${JSON.stringify(input)} must not throw`,
		);
	}
});
