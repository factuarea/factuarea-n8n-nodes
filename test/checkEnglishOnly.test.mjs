/**
 * Tests for the English-only gate (`scripts/check-english-only.mjs`).
 *
 * The gate is the only thing standing between the package's declared English
 * exception and the Spanish everyone here writes by default, so what is tested
 * is its BEHAVIOUR through the command line — exit code and printed report —
 * and not its internals: the gate is meant to be copied unchanged into the two
 * sibling repositories of this epic, and a test bound to its internals would
 * not survive the copy.
 *
 * This file is written in `.mjs` on purpose. It runs on plain Node with no
 * build step, which is what lets it exercise a script that has no build step
 * either, and it keeps the Spanish fixtures out of `src/` and `docs/` — the
 * only two trees the gate is pointed at. The gate deliberately does not scan
 * `test/`; if it did, these fixtures would make it fail on itself.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = fileURLToPath(new URL('../scripts/check-english-only.mjs', import.meta.url));

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_MISCONFIGURED = 2;

/** A Spanish tax term that legitimately survives translation and DOES trip the heuristics. */
const SPANISH_TAX_TERM = 'Declaración responsable';

/**
 * Builds a throwaway workspace, runs the gate inside it and returns everything
 * the caller could assert on. Running with `cwd` set to the workspace is what
 * makes the reported paths relative and therefore predictable.
 */
function runGate({ files = {}, allowlist, targets = ['src'] }) {
	const workspace = mkdtempSync(path.join(tmpdir(), 'english-only-gate-'));
	try {
		for (const [relativePath, contents] of Object.entries(files)) {
			const absolutePath = path.join(workspace, relativePath);
			mkdirSync(path.dirname(absolutePath), { recursive: true });
			writeFileSync(absolutePath, contents, 'utf8');
		}

		const argv = [GATE, ...targets];
		if (allowlist !== undefined) {
			const allowlistPath = path.join(workspace, 'allowlist.json');
			writeFileSync(
				allowlistPath,
				typeof allowlist === 'string' ? allowlist : JSON.stringify(allowlist, null, 2),
				'utf8',
			);
			argv.push('--allowlist', allowlistPath);
		}

		const result = spawnSync(process.execPath, argv, { cwd: workspace, encoding: 'utf8' });
		return {
			status: result.status,
			output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
		};
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
}

/** An allowlist that grants nothing, so a case can prove the gate without exceptions. */
const NO_EXCEPTIONS = {};

describe('english-only gate', () => {
	test('a Spanish parameter description fails, naming the file, the line and the string', () => {
		const { status, output } = runGate({
			allowlist: NO_EXCEPTIONS,
			files: {
				'src/properties.ts': [
					"export const NAME = 'Delivery destination';",
					'',
					"export const DESCRIPTION = 'Descripción del destino de entrega';",
					'',
				].join('\n'),
			},
		});

		assert.equal(status, EXIT_FINDINGS);
		assert.ok(
			output.includes('src/properties.ts:3:'),
			`the report must name the file and the LINE of the finding, got:\n${output}`,
		);
		assert.ok(
			output.includes('Descripción del destino de entrega'),
			`the report must quote the offending string, got:\n${output}`,
		);
	});

	test('a Spanish error message inside a comment fails too', () => {
		const { status, output } = runGate({
			allowlist: NO_EXCEPTIONS,
			files: {
				'src/errors.ts': [
					'/**',
					' * ¿Qué hacer cuando la firma no coincide?',
					' */',
					"export const SIGNATURE_MISMATCH = 'Signature mismatch.';",
					'',
				].join('\n'),
			},
		});

		assert.equal(status, EXIT_FINDINGS);
		assert.ok(
			output.includes('src/errors.ts:2:'),
			`a docblock line must be reported at its own line number, got:\n${output}`,
		);
	});

	test('Spanish prose in the documentation fails, and a fenced code block does not', () => {
		const { status, output } = runGate({
			allowlist: NO_EXCEPTIONS,
			targets: ['README.md'],
			files: {
				'README.md': [
					'# Factuarea Trigger',
					'',
					'```bash',
					"echo 'una cadena en español dentro de un bloque de código'",
					'```',
					'',
					'Este nodo arranca un flujo de trabajo.',
					'',
				].join('\n'),
			},
		});

		assert.equal(status, EXIT_FINDINGS);
		assert.ok(
			output.includes('README.md:7:'),
			`the prose line must be reported, got:\n${output}`,
		);
		assert.ok(
			!output.includes('README.md:4:'),
			`a fenced code block must not be inspected, got:\n${output}`,
		);
	});

	test('an English parameter description passes', () => {
		const { status, output } = runGate({
			allowlist: NO_EXCEPTIONS,
			files: {
				'src/properties.ts': [
					'/**',
					' * Properties of the trigger node, shown in the n8n editor.',
					' */',
					"export const NAME = 'Delivery destination';",
					'',
					"export const DESCRIPTION = 'The HTTPS address Factuarea posts every signed event to.';",
					'',
				].join('\n'),
			},
		});

		assert.equal(status, EXIT_OK, `expected a clean run, got:\n${output}`);
	});

	test('a term listed in the allowlist passes', () => {
		const files = {
			'src/properties.ts': `export const HELP = 'Fetches the ${SPANISH_TAX_TERM} filed for the company.';\n`,
		};

		const withoutException = runGate({ files, allowlist: NO_EXCEPTIONS });
		assert.equal(
			withoutException.status,
			EXIT_FINDINGS,
			'control: without the exception this string must be reported, otherwise the next assertion proves nothing',
		);

		const withException = runGate({
			files,
			allowlist: {
				'Spanish tax term with no English equivalent; translating it would name a filing that does not exist.': [
					SPANISH_TAX_TERM,
				],
			},
		});

		assert.equal(
			withException.status,
			EXIT_OK,
			`expected the allowlisted term to pass, got:\n${withException.output}`,
		);
	});

	test('an allowlisted term whitens itself and not the Spanish around it', () => {
		const { status, output } = runGate({
			allowlist: {
				'Spanish tax term with no English equivalent; translating it would name a filing that does not exist.': [
					SPANISH_TAX_TERM,
				],
			},
			files: {
				'src/properties.ts': `export const HELP = '${SPANISH_TAX_TERM} de la empresa';\n`,
			},
		});

		assert.equal(
			status,
			EXIT_FINDINGS,
			`an exception must not be a free pass for the sentence wrapped around it, got:\n${output}`,
		);
		assert.ok(
			output.includes('Spanish function word'),
			`the residue after removing the term must still be inspected, got:\n${output}`,
		);
	});

	test('an allowlist entry without a reason fails the gate itself', () => {
		const { status, output } = runGate({
			allowlist: `{\n  "": ["${SPANISH_TAX_TERM}"]\n}\n`,
			files: { 'src/properties.ts': "export const NAME = 'Delivery destination';\n" },
		});

		assert.equal(
			status,
			EXIT_MISCONFIGURED,
			`an exception without a written reason must not be accepted, got:\n${output}`,
		);
		assert.ok(
			/empty reason/i.test(output),
			`the failure must say what is wrong with the allowlist, got:\n${output}`,
		);
	});

	test('an allowlist entry whose value is not a list fails the gate itself', () => {
		const { status, output } = runGate({
			allowlist: { 'Product name.': 'Factuarea' },
			files: { 'src/properties.ts': "export const NAME = 'Delivery destination';\n" },
		});

		assert.equal(status, EXIT_MISCONFIGURED, `expected a configuration failure, got:\n${output}`);
		assert.ok(/not a list/i.test(output), `the failure must name the offending reason, got:\n${output}`);
	});

	test('a malformed allowlist fails the gate itself instead of running with no exceptions', () => {
		const { status, output } = runGate({
			allowlist: '{ this is not json',
			files: { 'src/properties.ts': `export const HELP = '${SPANISH_TAX_TERM}';\n` },
		});

		assert.equal(status, EXIT_MISCONFIGURED, `expected a configuration failure, got:\n${output}`);
		assert.ok(/not valid JSON/i.test(output), `the failure must say the file is unreadable, got:\n${output}`);
	});

	test('a path that does not exist yet is skipped with a warning, not treated as a failure', () => {
		const { status, output } = runGate({
			allowlist: NO_EXCEPTIONS,
			targets: ['src', 'docs', 'README.md', 'CHANGELOG.md'],
			files: { 'src/properties.ts': "export const NAME = 'Delivery destination';\n" },
		});

		assert.equal(status, EXIT_OK, `a not-yet-written document must not fail the gate, got:\n${output}`);
		assert.ok(/skipping README\.md/.test(output), `the skip must be announced, got:\n${output}`);
		assert.ok(/skipping CHANGELOG\.md/.test(output), `the skip must be announced, got:\n${output}`);
	});

	test('the gate refuses to run with no paths instead of reporting a clean tree', () => {
		const { status, output } = runGate({ targets: [], allowlist: NO_EXCEPTIONS });

		assert.equal(status, EXIT_MISCONFIGURED, `expected a configuration failure, got:\n${output}`);
		assert.ok(/No paths given/i.test(output), `the failure must explain the invocation, got:\n${output}`);
	});
});
