/**
 * Reader of the `Factuarea-Signature` delivery header.
 *
 * The header is a comma-separated list of `key=value` pairs carrying exactly one
 * timestamp and ONE OR MORE candidate signatures:
 *
 *     t=<unix>,v1=<hex>
 *     t=<unix>,v1=<hex_current>,v1=<hex_previous>
 *
 * The second `v1=` appears while a rotated secret is still inside its grace
 * window: the emitter signs the same body with the current secret and with the
 * previous one (see `src/contract.ts`). This reader therefore returns EVERY
 * `v1=` value, in order of appearance. A reader that keeps the first one and
 * stops rejects legitimate deliveries for the whole rotation window, and does it
 * silently — the header is well formed, the body is untouched, and every
 * delivery is refused anyway.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not filter candidates and it does not compare anything. The length
 * filter belongs to the verifier, which needs it because `timingSafeEqual`
 * throws on buffers of different sizes; splitting that one decision across two
 * modules would leave neither of them able to state the rule on its own.
 *
 * Values are returned exactly as they arrived, trimmed of surrounding
 * whitespace and nothing else. No case folding: the emitter renders its digests
 * as lowercase hex, so normalising here would only teach the parser to accept a
 * shape the emitter does not produce, while hiding from the verifier that it
 * received one.
 *
 * ## Unknown pairs are ignored, never rejected
 *
 * A future emitter may add pairs this version does not know. A header carrying
 * one still parses, as long as it also carries a readable `t=` and at least one
 * `v1=`. Rejecting unknown pairs would break this node the day Factuarea adds a
 * field — an upgrade of the emitter that breaks every already-installed consumer
 * is the failure this rule exists to prevent.
 *
 * ## This function never throws
 *
 * Every failure is one of the six enumerated reasons below, returned as a value.
 * The caller is an HTTP handler answering an untrusted request, and the emitter
 * treats a 4xx as a permanent failure and a 5xx as retryable. An exception
 * thrown here would surface as a 5xx, so a header that can never become valid
 * would be retried with backoff instead of being refused once.
 */

/**
 * Why a header could not be read.
 *
 * The six cases are distinguished rather than collapsed into one because they
 * have different causes and different remedies: `missing` and `empty` point at
 * the proxy in front of n8n, `malformed` and `no_timestamp` at something that is
 * not a Factuarea delivery at all, `invalid_timestamp` at a corrupted value, and
 * `no_signatures` at an emitter format this version cannot read.
 */
export type SignatureHeaderFailureReason =
	/** The header was not present at all. */
	| 'missing'
	/** Present but blank. */
	| 'empty'
	/** No readable `key=value` pair. */
	| 'malformed'
	/** Readable pairs, but none of them is `t=`. */
	| 'no_timestamp'
	/** `t=` present but not a base-10 integer. */
	| 'invalid_timestamp'
	/** No `v1=` pair at all. */
	| 'no_signatures';

/**
 * The outcome of reading a header: either a timestamp with its candidates, or a
 * reason. Never an exception, and never a partial success.
 */
export type ParsedSignatureHeader =
	| { ok: true; timestamp: number; signatures: string[] }
	| { ok: false; reason: SignatureHeaderFailureReason };

/** Pair key carrying the unix timestamp (seconds) the signature was built over. */
const TIMESTAMP_KEY = 't';

/** Pair key carrying a candidate signature. Repeats during secret rotation. */
const SIGNATURE_KEY = 'v1';

/**
 * A base-10 integer and nothing else.
 *
 * `Number()` alone would not do: it accepts `1e3`, `0x10`, `Infinity` and
 * surrounding whitespace, so a timestamp that is not a base-10 integer would be
 * silently converted into one instead of being reported as invalid.
 */
const BASE_10_INTEGER = /^-?[0-9]+$/;

/**
 * Read a `Factuarea-Signature` header.
 *
 * The parameter is widened to `string | undefined` on purpose: an absent header
 * is one of the enumerated failure cases, so it must arrive as a value this
 * function can classify rather than forcing every caller to guard first and
 * invent its own answer for the absent case.
 */
export function parseSignatureHeader(
	header: string | undefined,
): ParsedSignatureHeader {
	if (header === undefined) {
		return { ok: false, reason: 'missing' };
	}

	if (header.trim() === '') {
		return { ok: false, reason: 'empty' };
	}

	let rawTimestamp: string | undefined;
	const signatures: string[] = [];
	let readablePairs = 0;

	for (const part of header.split(',')) {
		const separator = part.indexOf('=');
		if (separator < 0) {
			// No `=` at all: not a readable pair. Skipped rather than fatal, so a
			// single unreadable fragment cannot discard a header whose other pairs
			// are perfectly good.
			continue;
		}

		const key = part.slice(0, separator).trim();
		if (key === '') {
			continue;
		}

		// Split on the FIRST `=` only, so a value that contains one survives intact.
		const value = part.slice(separator + 1).trim();
		readablePairs += 1;

		if (key === TIMESTAMP_KEY) {
			// Exactly one `t=` is specified. If a second one appears it is an
			// unknown pair by the rule above, and the first one wins: picking the
			// last would let an appended pair override the timestamp the rest of
			// the header was built around.
			rawTimestamp ??= value;
			continue;
		}

		if (key === SIGNATURE_KEY) {
			// Pushed unfiltered, empty values included. Whether a candidate is the
			// right shape is the verifier's question, and it already has to answer
			// it for every other candidate.
			signatures.push(value);
		}
	}

	if (readablePairs === 0) {
		return { ok: false, reason: 'malformed' };
	}

	if (rawTimestamp === undefined) {
		return { ok: false, reason: 'no_timestamp' };
	}

	if (!BASE_10_INTEGER.test(rawTimestamp)) {
		return { ok: false, reason: 'invalid_timestamp' };
	}

	const timestamp = Number(rawTimestamp);
	if (!Number.isSafeInteger(timestamp)) {
		// Digits, but more of them than a double holds exactly. Returning the
		// rounded value would hand the tolerance check a number the header does
		// not carry, and the check would then pass or fail on a value nobody sent.
		return { ok: false, reason: 'invalid_timestamp' };
	}

	if (signatures.length === 0) {
		return { ok: false, reason: 'no_signatures' };
	}

	return { ok: true, timestamp, signatures };
}
