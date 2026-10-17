#!/usr/bin/env node
/**
 * Extracts `components.schemas.AccountEventType.enum` from the Factuarea public
 * API OpenAPI document and writes `test/vectors/account-event-types.json`, the
 * vector `test/accountEventCatalog.test.ts` compares the node's fixed list with.
 *
 * Usage:
 *
 *   node scripts/extract-account-event-types.mjs <path-to-openapi.json>
 *
 * The document is an argument because it lives outside this repository. The
 * vector records its SHA-256 and the SHA-256 of its canonical form (object keys
 * sorted at every level, compact JSON), so a later run against a changed
 * document produces a visibly different vector.
 *
 * Exit codes: 0 written, 1 usage or unreadable document, 3 the schema is not
 * the expected list of 15 `account.*` names.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'test',
	'vectors',
	'account-event-types.json',
);
const COMMAND = 'node scripts/extract-account-event-types.mjs <path-to-openapi.json>';
const EXPECTED_COUNT = 15;

const source = process.argv[2];

if (source === undefined) {
	console.error(`usage: ${COMMAND}`);
	process.exit(1);
}

let bytes;

try {
	bytes = readFileSync(source);
} catch (error) {
	console.error(`cannot read ${source}: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** The value with the keys of every object sorted, so the digest ignores key order. */
function canonical(value) {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}

	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])]),
		);
	}

	return value;
}

const document = JSON.parse(bytes.toString('utf8'));
const events = document.components?.schemas?.AccountEventType?.enum;

if (
	!Array.isArray(events) ||
	events.length !== EXPECTED_COUNT ||
	!events.every((name) => typeof name === 'string' && /^account\./.test(name))
) {
	console.error(
		`AccountEventType.enum is not the expected list of ${EXPECTED_COUNT} account.* names`,
	);
	process.exit(3);
}

const vector = {
	$meta: {
		description:
			'The fifteen account.* event types, extracted from components.schemas.AccountEventType.enum of the frozen public API document. Do not edit by hand: regenerate with the extraction command.',
		source: 'the frozen Factuarea public API OpenAPI document (openapi-public.json)',
		source_sha256: sha256(bytes),
		source_canonical_digest: sha256(JSON.stringify(canonical(document))),
		schema_path: 'components.schemas.AccountEventType.enum',
		extraction_command: COMMAND,
	},
	events,
};

writeFileSync(OUT, JSON.stringify(vector, null, '\t') + '\n');
console.log(`wrote ${events.length} events to ${OUT}`);
