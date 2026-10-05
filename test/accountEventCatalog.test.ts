import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ACCOUNT_EVENT_CATALOG } from '../src/nodes/FactuareaTrigger/accountEventCatalog';

/**
 * Shape of `test/vectors/account-event-types.json`: the fifteen names extracted
 * from `components.schemas.AccountEventType.enum` of the frozen public API
 * document, with the document's digest and the extraction command in `$meta`.
 */
interface AccountEventVectorFile {
	$meta: {
		source: string;
		source_sha256: string;
		source_canonical_digest: string;
		schema_path: string;
		extraction_command: string;
	};
	events: string[];
}

/**
 * Read from disk rather than imported, because the compiled test and the source
 * test do not sit at the same depth: `dist/test/` reaches the repository's
 * `test/vectors/` two levels up. Both candidates are tried and a miss is a loud
 * failure naming them, never a silent skip.
 */
function loadVector(): AccountEventVectorFile {
	const candidates = [
		join(__dirname, 'vectors', 'account-event-types.json'),
		join(__dirname, '..', '..', 'test', 'vectors', 'account-event-types.json'),
	];
	const found = candidates.find((path) => existsSync(path));

	if (found === undefined) {
		throw new Error(`account event vector not found. Looked in: ${candidates.join(', ')}`);
	}

	return JSON.parse(readFileSync(found, 'utf8')) as AccountEventVectorFile;
}

const vector = loadVector();

describe('accountEventCatalog — the fixed list follows the contract', () => {
	it('matches the vector extracted from the frozen document, naming what differs', () => {
		const listed = new Set<string>(ACCOUNT_EVENT_CATALOG);
		const expected = new Set<string>(vector.events);

		const extra = [...listed].filter((name) => !expected.has(name));
		const missing = [...expected].filter((name) => !listed.has(name));

		// The failure names the event, not a length: "differs" would send the
		// reader to diff two arrays by eye.
		assert.deepEqual(extra, [], `the package lists events the contract does not: ${extra.join(', ')}`);
		assert.deepEqual(missing, [], `the package lacks events the contract has: ${missing.join(', ')}`);
	});

	it('keeps the order of the contract and lists no name twice', () => {
		assert.deepEqual([...ACCOUNT_EVENT_CATALOG], vector.events);
		assert.equal(new Set(ACCOUNT_EVENT_CATALOG).size, ACCOUNT_EVENT_CATALOG.length);
	});

	it('lists fifteen names, every one in the account namespace', () => {
		assert.equal(ACCOUNT_EVENT_CATALOG.length, 15);

		for (const name of ACCOUNT_EVENT_CATALOG) {
			assert.match(name, /^account\.[a-z_]+$/, name);
		}
	});

	it('carries the provenance of the vector, so a stale one is recognisable', () => {
		assert.match(vector.$meta.source_sha256, /^[0-9a-f]{64}$/);
		assert.match(vector.$meta.source_canonical_digest, /^[0-9a-f]{64}$/);
		assert.equal(vector.$meta.schema_path, 'components.schemas.AccountEventType.enum');
		assert.match(vector.$meta.extraction_command, /scripts\/extract-account-event-types\.mjs/);
		assert.match(vector.$meta.source, /openapi-public\.json/);
	});
});
