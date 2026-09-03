import { createHmac, timingSafeEqual } from 'node:crypto';

import { SHA256_HEX_DIGEST_LENGTH } from '../contract';
import { parseSignatureHeader, type SignatureHeaderFailureReason } from './parseSignatureHeader';

/**
 * Outcome of verifying one delivery against the secret this node holds.
 *
 * The failure reasons are the parser's own, widened with two of this module's:
 *
 *   `no_candidates`  the header parsed, but every `v1=` was discarded by the
 *                    length filter — nothing was ever compared. It points at a
 *                    malformed or future header format, NOT at a wrong secret.
 *   `no_match`       candidates of the right length were compared and none of
 *                    them matched. It points at the secret.
 *
 * They are kept apart because they need different fixes, and collapsing them
 * would send whoever reads the failure looking for the wrong thing.
 */
export type SignatureVerification =
	| { ok: true; timestamp: number; signatures: string[] }
	| { ok: false; reason: SignatureHeaderFailureReason | 'no_candidates' | 'no_match' };

/**
 * Verifies a Factuarea delivery: HMAC-SHA256 over `<timestamp>.<rawBody>`,
 * compared against every candidate in the signature header in constant time.
 *
 * ## The raw body is not negotiable
 *
 * `rawBody` MUST be the bytes as they arrived on the wire. Passing
 * `JSON.stringify(JSON.parse(rawBody))` — or any object that was parsed and
 * serialised again — silently breaks every verification, and what breaks it is
 * `\uXXXX`. PHP's `json_encode` escapes every non-ASCII character that way
 * unless told otherwise, and this emitter does not tell it: measured,
 * `RecordEventCommandHandler` passes `JSON_UNESCAPED_SLASHES` and NOT
 * `JSON_UNESCAPED_UNICODE`, so a URL arrives with its solidus intact while an
 * accented letter — every client name in this market has one — arrives as the
 * six ASCII characters of its escape. `JSON.stringify` writes the letter back,
 * the bytes change, and the digest no longer matches the one computed over what
 * was actually sent: a legitimate delivery looks forged.
 *
 * The `\/` escape that this argument is usually told with is `json_encode`'s
 * DEFAULT, not this emitter's output; the golden vector carries one anyway,
 * because a verifier that survives the wider case survives the real one too. No
 * claim here rests on it.
 *
 * The symptom is "the node rejects everything" with no clue why, which is why
 * `test/vectors/signature-vectors.json` carries a vector whose body changes
 * under reserialisation and the test asserts the reserialised form is REJECTED.
 *
 * ## Why every candidate is compared
 *
 * The header carries one `v1=` normally and TWO during the emitter's secret
 * rotation grace window: the same body signed with the current secret and with
 * the previous one. A verifier that reads the first candidate and stops rejects
 * legitimate deliveries for the whole window, so all of them are evaluated —
 * and evaluated the same way, so the number of comparisons does not depend on
 * which one matches.
 *
 * ## Frozen decisions
 *
 * - An EMPTY secret matches nothing and returns `no_match`. It is rejected by an
 *   explicit guard rather than left to fail the comparison on its own: an empty
 *   secret means the node has no secret (the endpoint was never created, or the
 *   static data was lost), and without the guard anyone who guessed that could
 *   sign a body with the empty key and be accepted. `no_match` rather than
 *   `no_candidates` because the header was fine — the secret is what is missing.
 * - `signatures` on success is the parser's list VERBATIM: every `v1=` in order
 *   of appearance, including any the length filter discarded. This reports what
 *   ARRIVED, not what this function chose to compare, so the success value does
 *   not shift when the comparison's internals do.
 * - Candidates are compared exactly as received, without lowercasing. The
 *   emitter renders its digest in lowercase hex (measured), so normalising case
 *   would only widen what is accepted beyond the frozen contract.
 *
 * ## A `Buffer` is accepted, and it is the better thing to pass
 *
 * `rawBody` takes the bytes themselves or a string holding them. A caller that
 * HAS the buffer — the trigger does; n8n hands it one — should pass it, because
 * the string route costs a decode and an encode: `buffer.toString('utf8')`
 * replaces every byte sequence that is not valid UTF-8 with U+FFFD, and encoding
 * that back produces `EF BF BD` where other bytes were. For this emitter the
 * round trip is exact — `json_encode` output is always valid UTF-8 — so the
 * string form is correct today rather than merely close; passing the buffer
 * removes the dependency on that argument being true, which is worth more here
 * than in most places, since the failure it prevents is silent and total.
 *
 * The material is fed to the HMAC in two updates for the same reason. Building
 * `` `${timestamp}.${rawBody}` `` would stringify the buffer to get there,
 * putting back exactly the conversion this accepts a buffer to avoid.
 *
 * This function NEVER throws.
 *
 * @param rawBody Body bytes exactly as received, as a `Buffer` or a string.
 *                Never a reserialised object.
 * @param header  Raw `Factuarea-Signature` value, or `undefined` when absent.
 * @param secret  Plaintext signing secret this node stored at endpoint creation.
 */
export function verifySignature(
	rawBody: string | Buffer,
	header: string | undefined,
	secret: string,
): SignatureVerification {
	const parsed = parseSignatureHeader(header);

	if (!parsed.ok) {
		// A header this module cannot read is the parser's failure, reported with
		// the parser's own reason: re-labelling it here would hide which of the six
		// header defects actually occurred.
		return { ok: false, reason: parsed.reason };
	}

	if (secret === '') {
		return { ok: false, reason: 'no_match' };
	}

	// `timingSafeEqual` THROWS when the two buffers differ in length, so the length
	// filter is mandatory and has to run before any comparison. It leaks nothing:
	// the length of a SHA-256 hex digest is public, constant, and identical for
	// every secret, so discarding on it reveals nothing about the secret or the
	// expected digest.
	const comparable = parsed.signatures.filter(
		(candidate) => candidate.length === SHA256_HEX_DIGEST_LENGTH,
	);

	if (comparable.length === 0) {
		return { ok: false, reason: 'no_candidates' };
	}

	// Two updates, never one template string: concatenating would convert a
	// Buffer to a string to build it, which is the decode this signature accepts
	// a Buffer to avoid. Feeding the prefix and then the bytes hashes exactly what
	// arrived. A string `rawBody` takes the same path it always did, `utf8`.
	const hmac = createHmac('sha256', secret).update(`${parsed.timestamp}.`, 'utf8');

	const expected = (
		typeof rawBody === 'string' ? hmac.update(rawBody, 'utf8') : hmac.update(rawBody)
	).digest('hex');
	// `latin1` writes one byte per UTF-16 code unit, so a candidate that passed the
	// length filter is ALWAYS exactly SHA256_HEX_DIGEST_LENGTH bytes. `utf8` would
	// not: one non-ASCII character inside a 64-character candidate produces 65
	// bytes and makes `timingSafeEqual` throw — the very crash the filter above
	// exists to prevent. Both sides are encoded the same way, so a candidate that
	// is not hex simply fails to match.
	const expectedBuffer = Buffer.from(expected, 'latin1');

	// Counted, never short-circuited. `===`, `indexOf`, `includes`, `some()` and an
	// early `return` are all forbidden here: each of them stops at the first match
	// and makes the running time depend on WHICH candidate matched, which is the
	// timing leak this module exists to avoid. Adding to a counter forces every
	// iteration of the loop to run and every candidate to be compared.
	let matches = 0;

	for (const candidate of comparable) {
		matches += timingSafeEqual(expectedBuffer, Buffer.from(candidate, 'latin1')) ? 1 : 0;
	}

	if (matches === 0) {
		return { ok: false, reason: 'no_match' };
	}

	return { ok: true, timestamp: parsed.timestamp, signatures: parsed.signatures };
}
