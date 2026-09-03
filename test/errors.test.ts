import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { NODE_ERRORS } from '../src/errors';
import type { NodeErrorKey } from '../src/errors';

/**
 * The error catalogue, held to the three promises its own header makes.
 *
 * `src/errors.ts` states that every message names the CAUSE and the NEXT STEP,
 * that no message may carry a secret or anything derived from one, and — by
 * enumerating the catalogue in `NODE_ERRORS` — that the list is walkable rather
 * than rediscovered. A header that says all that and a file that nothing checks
 * is a promise, not a guarantee.
 *
 * The fourth test is the one that earns this file. A message can satisfy every
 * rule above and be reachable by NOBODY, which is what happened to
 * `ERROR_SIGNATURE_MISMATCH_WITHIN_TOLERANCE`: it was written, catalogued,
 * explained in three docblocks and quoted in `docs/LIMITATIONS.md`, and the
 * trigger discarded the verification result that would have produced it. Every
 * reader of this package was told the node says something it could not say. So
 * each constant is required to appear in production code OUTSIDE `errors.ts`,
 * and outside comments — the same defect in any future message fails here.
 */

/**
 * The SOURCE tree, found from wherever this test is running.
 *
 * The compiled copy runs from `dist/test/` and the sources sit two levels up;
 * run straight from `test/` they sit alongside. Both candidates are tried and a
 * miss is a loud failure naming them — never a skip, because a scan that finds
 * no files would report every message as reachable and pass.
 */
function sourceRoot(): string {
	const candidates = [
		path.join(__dirname, '..', 'src'),
		path.join(__dirname, '..', '..', 'src'),
	];
	const found = candidates.find((candidate) => existsSync(path.join(candidate, 'errors.ts')));

	if (found === undefined) {
		throw new Error(`the source tree was not found. Looked in: ${candidates.join(', ')}`);
	}

	return found;
}

const SOURCE_ROOT = sourceRoot();
const CATALOGUE = path.join(SOURCE_ROOT, 'errors.ts');

/** Every `.ts` under `src/`, depth first. */
function sourceFiles(root: string): string[] {
	const found: string[] = [];
	const pending = [root];

	while (pending.length > 0) {
		const current = pending.pop();

		if (current === undefined) {
			break;
		}

		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);

			if (entry.isDirectory()) {
				pending.push(absolute);
			} else if (entry.isFile() && absolute.endsWith('.ts')) {
				found.push(absolute);
			}
		}
	}

	return found.sort();
}

/**
 * The file with its comments and its string literals removed.
 *
 * Both have to go, and for opposite reasons. A comment MENTIONING a constant is
 * exactly what a dead message looks like — `errors.ts` names all of them in
 * prose, and so does every docblock that explains one — so counting a comment as
 * a use is the failure this file exists to prevent. String literals go because
 * a message quoted into a message would be a use of the TEXT and not of the
 * constant, and because dropping them makes the scan blind to any apostrophe
 * that could otherwise be read as opening a quote.
 *
 * A small lexer rather than a regular expression: the same lazy-block-comment
 * trap that shipped a false green in `scripts/check-package-constraints.mjs`
 * lives here too, and this scan decides whether a message is dead.
 */
function executableText(source: string): string {
	let out = '';
	let index = 0;

	while (index < source.length) {
		const two = source.slice(index, index + 2);

		if (two === '//') {
			while (index < source.length && source[index] !== '\n') {
				index += 1;
			}
			continue;
		}

		if (two === '/*') {
			index += 2;
			while (index < source.length && source.slice(index, index + 2) !== '*/') {
				index += 1;
			}
			index += 2;
			continue;
		}

		const character = source[index];

		if (character === "'" || character === '"' || character === '`') {
			const quote = character;
			index += 1;
			while (index < source.length && source[index] !== quote) {
				index += source[index] === '\\' ? 2 : 1;
			}
			index += 1;
			// A space, so `x='a'+y` does not become `x=+y` and glue two names.
			out += ' ';
			continue;
		}

		out += character;
		index += 1;
	}

	return out;
}

/**
 * The same text with its import statements dropped.
 *
 * An import is not a use. Deleting the one line that produces a message while
 * leaving `import { ERROR_… }` at the top of the file is the most likely way
 * this defect comes back — nothing in the build complains, because
 * `noUnusedLocals` is not on — and a scan that counted the import would call
 * that message reachable and go green over exactly the bug it was written for.
 *
 * Safe as a regular expression only because string literals are already gone,
 * so no semicolon can hide inside one.
 */
function withoutImports(source: string): string {
	return source.replace(/\bimport\b[^;]*;/g, ' ');
}

/** The exported name of one catalogue entry, from its key. */
function constantNameOf(key: NodeErrorKey): string {
	return `ERROR_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

const KEYS = Object.keys(NODE_ERRORS) as NodeErrorKey[];

/** Words that turn "what failed" into "what to do about it". */
const NEXT_STEP_WORDS = [
	'activate',
	'check',
	'create',
	'deactivate',
	'delete',
	'expose',
	'give',
	'make sure',
	'open',
	'reopen',
	'run',
	'select',
	'update',
	'then',
];

describe('the error catalogue', () => {
	it('is not empty and every entry is a non-empty English message', () => {
		assert.ok(KEYS.length > 0, 'a catalogue with no entries would pass every test below');

		for (const key of KEYS) {
			const message = NODE_ERRORS[key];

			assert.equal(typeof message, 'string');
			assert.ok(message.trim().length > 40, `${key} is too short to name a cause and a step`);
			// The package is English-only by declared exception
			// (`docs/ENGLISH-ONLY.md`). Accented characters are the cheapest signal
			// that a Spanish message slipped in; the dedicated gate does the rest.
			assert.doesNotMatch(message, /[áéíóúñ¿¡]/i, `${key} does not read as English`);
		}
	});

	it('tells the user what to do next, not only what failed', () => {
		for (const key of KEYS) {
			const message = NODE_ERRORS[key].toLowerCase();
			const hasNextStep = NEXT_STEP_WORDS.some((word) => message.includes(word));

			assert.ok(
				hasNextStep,
				`${key} names a failure and no remedy: a message the user cannot act on is the same as no message`,
			);
		}
	});

	it('never carries a secret, a key or a digest', () => {
		for (const key of KEYS) {
			const message = NODE_ERRORS[key];

			// Not the values — this file has none — but the SHAPES that would mean
			// one had been interpolated. A message reaches the n8n execution log,
			// which is stored, screenshotted and pasted into support tickets.
			assert.doesNotMatch(message, /[0-9a-f]{32,}/i, `${key} contains something shaped like a digest`);
			assert.doesNotMatch(message, /whsec_\w/i, `${key} contains something shaped like a signing secret`);
			assert.doesNotMatch(message, /\bfact_(test|live)_\w/i, `${key} contains something shaped like an API key`);
			assert.doesNotMatch(message, /\bfk_(test|live)_\w/i, `${key} contains something shaped like an API key`);
		}
	});

	it('has no message that production code cannot reach', () => {
		const production = sourceFiles(SOURCE_ROOT)
			.filter((file) => file !== CATALOGUE)
			.map((file) => withoutImports(executableText(readFileSync(file, 'utf8'))))
			.join('\n');

		assert.ok(production.length > 0, 'the scan read nothing: it would report every message as reachable');

		const unreachable = KEYS.map(constantNameOf).filter(
			(name) => !new RegExp(`\\b${name}\\b`).test(production),
		);

		assert.deepEqual(
			unreachable,
			[],
			'these messages are catalogued, documented and used by nothing: a message no code path can produce is a promise to the reader that the node never keeps',
		);
	});

	it('reads neither a comment nor an import as a use', () => {
		// The test above is only worth its runtime if the two ways of MENTIONING a
		// constant without producing it do not count. Both are the likely shapes of
		// the defect: `errors.ts` and several callers name every message in prose,
		// and deleting a use while leaving its import compiles without a word.
		const mentionsOnly = withoutImports(
			executableText(
				[
					"import { ERROR_SOMETHING_MADE_UP } from '../errors';",
					'/* produces ERROR_SOMETHING_MADE_UP */',
					'// and ERROR_SOMETHING_MADE_UP again',
					'const x = 1;',
				].join('\n'),
			),
		);

		assert.doesNotMatch(mentionsOnly, /ERROR_SOMETHING_MADE_UP/);
		assert.match(mentionsOnly, /const x = 1;/);
	});
});
