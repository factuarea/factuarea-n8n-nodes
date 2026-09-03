#!/usr/bin/env node
/**
 * Package constraints gate — licence, runtime dependencies, environment, file
 * system and manifest shape.
 *
 * ## What this gate reads, and why it is not the source tree
 *
 * n8n's community-node verification audits the PUBLISHED PACKAGE, not this
 * repository. So this gate audits the package too: it builds the tarball exactly
 * as `npm publish` would, extracts it, and reads what came out. A source-tree
 * scan would miss an environment read introduced by the compiler, by a template,
 * or by a file that `src/` does not show, and would flag things that never ship.
 * The repository already applies this principle to its other guardrails: measure
 * the effect, never the intention.
 *
 * ## Why `npm pack` to a directory and `tar`, and not `npm pack --dry-run --json`
 *
 * `--dry-run --json` lists the file NAMES that would ship. Three of the four
 * checks here need the CONTENT — the licence text, the compiled JavaScript, the
 * node's own description — so a listing is not enough. We pack for real into a
 * temporary directory, extract with `tar`, audit the extracted tree and delete
 * it. `--ignore-scripts` is passed on purpose: the gate must never trigger a
 * build, both because a build is not what publishing audits and because several
 * agents share one `dist/` in this repository and a gate that compiles would
 * collide with whoever is compiling.
 *
 * ## Why this script may use `node:fs` and `node:child_process`
 *
 * They are development tooling, not shipped code. The gate analyses `dist/` and
 * `scripts/` is excluded from the tarball by `.npmignore`, so this file is never
 * part of the artefact it audits and can never read itself as an offender.
 *
 * ## Usage
 *
 *   node scripts/check-package-constraints.mjs
 *       Packs this project and audits the resulting artefact. This is what CI
 *       and `npm run lint:package` run.
 *
 *   node scripts/check-package-constraints.mjs <dir>
 *       Audits an ALREADY EXTRACTED artefact directory — one holding
 *       `package.json`, the licence file and `dist/**`. The test harness uses
 *       this form to feed the gate synthetic artefacts without packing anything.
 *
 * Exit code 0 when the artefact satisfies every constraint, 1 otherwise. Every
 * failure names the file, and the line as well whenever the finding has one.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');

/** The one licence the package may declare. n8n's verification requires it. */
const REQUIRED_LICENCE = 'MIT';

/**
 * Filenames accepted as the licence file, in order of preference. `npm` itself
 * accepts any of these, so the gate cannot insist on one spelling.
 */
const LICENCE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md', 'LICENCE.txt'];

/**
 * Two markers the MIT licence text always carries. Both are required: the title
 * alone appears in files that merely mention MIT, and the permission sentence
 * alone appears in several permissive licences derived from it.
 */
const MIT_MARKERS = [/\bMIT\s+Licen[cs]e\b/i, /permission is hereby granted,\s*free of charge/i];

/**
 * Modules the published artefact may not reach for, ENUMERATED and keyed by the
 * reason. The list grows one entry at a time and is never replaced by a pattern:
 * a pattern would silently bless whatever new module happens to match it, which
 * is the mechanism by which a guardrail becomes decorative.
 */
const FORBIDDEN_MODULES = {
	'reads and writes the file system': ['fs', 'node:fs', 'fs/promises', 'node:fs/promises'],
	'spawns a process, which reaches both the file system and the environment': [
		'child_process',
		'node:child_process',
	],
	'is the process itself, and with it the whole environment': ['process', 'node:process'],
};

/** Specifier -> reason, flattened from the table above. */
const FORBIDDEN_MODULE_REASONS = new Map(
	Object.entries(FORBIDDEN_MODULES).flatMap(([reason, specifiers]) =>
		specifiers.map((specifier) => [specifier, reason]),
	),
);

/**
 * Reaching the environment: `process.env`, `process["env"]`, `process['env']`.
 * The bracket forms are here because a minifier or a hand-written obfuscation
 * would otherwise walk straight past a check that only knows the dot form.
 */
const ENVIRONMENT_ACCESS = /process\s*(?:\.\s*env\b|\[\s*(['"])env\1\s*\])/;

/**
 * Module references, in every form the compiled artefact can carry: CommonJS
 * `require`, static `import ... from`, dynamic `import()` and re-`export from`.
 */
const MODULE_REFERENCES = [
	/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	/\bfrom\s*['"]([^'"]+)['"]/g,
	/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** Extensions the gate reads as executable code. Declarations do not execute. */
const EXECUTABLE_EXTENSIONS = ['.js', '.cjs', '.mjs'];

/**
 * Runs the gate. Returns the list of problems; an empty list means the artefact
 * is clean.
 *
 * @param {string} artefactRoot Directory holding the extracted artefact.
 * @returns {{problems: Array<{file: string, line?: number, message: string}>, scannedFiles: number}}
 */
function auditArtefact(artefactRoot) {
	const problems = [];
	const report = (file, message, line) => problems.push({ file, message, line });

	const manifestPath = path.join(artefactRoot, 'package.json');
	if (!fs.existsSync(manifestPath)) {
		report('package.json', 'the artefact does not contain a manifest, so there is nothing to publish.');
		return { problems, scannedFiles: 0 };
	}

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (error) {
		report('package.json', `the manifest is not valid JSON: ${error.message}`);
		return { problems, scannedFiles: 0 };
	}

	checkLicence(artefactRoot, manifest, report);
	checkRuntimeDependencies(manifest, report);
	checkManifestShape(artefactRoot, manifest, report);

	const executableFiles = collectExecutableFiles(artefactRoot);
	for (const file of executableFiles) {
		scanForEnvironmentAndFileSystem(artefactRoot, file, report);
	}

	return { problems, scannedFiles: executableFiles.length };
}

/**
 * The declared licence is MIT and the licence file says the same thing. Both
 * halves matter: a manifest that says MIT over an Apache text is a package whose
 * users are told one thing and given another.
 */
function checkLicence(artefactRoot, manifest, report) {
	if (manifest.license !== REQUIRED_LICENCE) {
		const declared = manifest.license === undefined ? 'nothing' : JSON.stringify(manifest.license);
		report(
			'package.json',
			`"license" declares ${declared}; the package must declare "${REQUIRED_LICENCE}". n8n's verification requires it.`,
		);
	}

	const licenceFile = LICENCE_FILENAMES.find((name) => fs.existsSync(path.join(artefactRoot, name)));
	if (licenceFile === undefined) {
		report(
			'LICENSE',
			`the artefact carries no licence file; it must ship the "${REQUIRED_LICENCE}" licence text alongside the manifest.`,
		);
		return;
	}

	const text = fs.readFileSync(path.join(artefactRoot, licenceFile), 'utf8');
	const missingMarker = MIT_MARKERS.find((marker) => !marker.test(text));
	if (missingMarker !== undefined) {
		report(
			licenceFile,
			`the licence file does not read as the ${REQUIRED_LICENCE} licence, so it does not match the licence the manifest declares.`,
		);
	}
}

/**
 * The runtime dependency list is empty. Everything the node needs from n8n is a
 * peer or a development dependency; a runtime dependency is surface the official
 * analyser inspects and the installer downloads into every n8n instance.
 */
function checkRuntimeDependencies(manifest, report) {
	const dependencies = manifest.dependencies ?? {};
	if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) {
		report('package.json', '"dependencies" must be an object, and an empty one.');
		return;
	}

	const names = Object.keys(dependencies);
	for (const name of names) {
		report(
			'package.json',
			`"dependencies" must be empty; it declares the runtime dependency "${name}" (${dependencies[name]}). Move it to "peerDependencies" or "devDependencies", or drop it.`,
		);
	}
}

/**
 * The manifest declares exactly one node and exactly one credential, the files
 * it points at exist in the artefact, and the node is a TRIGGER.
 *
 * ## How "is a trigger" is decided, and why it is read and not executed
 *
 * Requiring the compiled node would need `n8n-workflow` resolvable from inside
 * the extracted artefact, and it is a PEER dependency: it is not there. The load
 * would fail for a reason that has nothing to do with the property being
 * audited, so the gate reads the compiled file as text instead. Three signals,
 * all required, each with its own message:
 *
 *   1. `description.group` includes `'trigger'` — this is what n8n itself reads
 *      to decide a node is a trigger, so it is the decisive one;
 *   2. the declared path ends in `Trigger.node.js` — n8n's own naming
 *      convention, and the signal a human reads first;
 *   3. the description declares `webhooks` or `polling` — a trigger with
 *      neither has no way to start a workflow.
 */
function checkManifestShape(artefactRoot, manifest, report) {
	const n8n = manifest.n8n ?? {};
	if (typeof n8n !== 'object' || n8n === null || Array.isArray(n8n)) {
		report('package.json', '"n8n" must be an object declaring the package\'s nodes and credentials.');
		return;
	}

	const nodes = checkSingleEntry(n8n.nodes, 'n8n.nodes', 'node', report);
	checkSingleEntry(n8n.credentials, 'n8n.credentials', 'credential', report);

	for (const [key, entries] of [
		['n8n.nodes', Array.isArray(n8n.nodes) ? n8n.nodes : []],
		['n8n.credentials', Array.isArray(n8n.credentials) ? n8n.credentials : []],
	]) {
		entries.forEach((entry, index) => {
			if (typeof entry !== 'string') {
				report('package.json', `"${key}[${index}]" must be a path into the published files.`);
				return;
			}
			if (!fs.existsSync(path.join(artefactRoot, entry))) {
				report(
					'package.json',
					`"${key}[${index}]" points at "${entry}", which the artefact does not contain. The manifest promises a file that never ships.`,
				);
			}
		});
	}

	if (nodes === undefined) {
		return;
	}

	checkNodeIsTrigger(artefactRoot, nodes, report);
}

/**
 * Exactly one entry in the given manifest list. Returns the entry when the list
 * holds exactly one string, and `undefined` otherwise. Every entry beyond the
 * first is named, because "the gate fails" without saying WHICH node was added
 * leaves the reader to diff the manifest by hand.
 */
function checkSingleEntry(value, key, label, report) {
	if (!Array.isArray(value)) {
		report('package.json', `"${key}" must be an array declaring exactly one ${label}.`);
		return undefined;
	}

	if (value.length === 0) {
		report('package.json', `"${key}" declares no ${label}; the package must declare exactly one.`);
		return undefined;
	}

	if (value.length > 1) {
		for (const added of value.slice(1)) {
			report(
				'package.json',
				`"${key}" must declare exactly one ${label}; it declares ${value.length}. Added entry: "${added}". n8n's verification allows one third-party service per package.`,
			);
		}
		return undefined;
	}

	return typeof value[0] === 'string' ? value[0] : undefined;
}

/** See the three signals documented on `checkManifestShape`. */
function checkNodeIsTrigger(artefactRoot, nodePath, report) {
	if (!nodePath.endsWith('Trigger.node.js')) {
		report(
			'package.json',
			`"n8n.nodes[0]" points at "${nodePath}", whose name does not end in "Trigger.node.js". This package publishes a trigger and nothing else.`,
		);
	}

	const absolute = path.join(artefactRoot, nodePath);
	if (!fs.existsSync(absolute)) {
		return; // Already reported as a missing file.
	}

	const source = stripComments(fs.readFileSync(absolute, 'utf8'));

	const group = /\bgroup\s*:\s*\[([^\]]*)\]/.exec(source);
	if (group === null || !/['"]trigger['"]/.test(group[1])) {
		report(
			nodePath,
			"the node's description does not declare `group` containing 'trigger'; that field is what n8n reads to treat a node as a trigger.",
		);
	}

	if (!/\bwebhooks\s*:/.test(source) && !/\bpolling\s*:/.test(source)) {
		report(
			nodePath,
			"the node's description declares neither `webhooks` nor `polling`, so it has no way to start a workflow.",
		);
	}
}

/**
 * Reads one executable file of the artefact looking for environment reads and
 * for references to the forbidden modules, and reports each finding with its
 * line.
 *
 * The scan is LEXICAL, and deliberately so: it reads what the artefact says, not
 * what it means. Comments are removed first — the compiler already strips them
 * (`removeComments` in `tsconfig.json`), and doing it again costs nothing and
 * covers a file that arrives some other way. A `process.env` inside a string
 * literal would still be reported. That is the safe direction: a false red is
 * read and dismissed by a human, a false green ships.
 */
function scanForEnvironmentAndFileSystem(artefactRoot, absolutePath, report) {
	const relative = path.relative(artefactRoot, absolutePath);
	const lines = stripComments(fs.readFileSync(absolutePath, 'utf8')).split('\n');

	lines.forEach((line, index) => {
		const lineNumber = index + 1;

		if (ENVIRONMENT_ACCESS.test(line)) {
			report(
				relative,
				'reads the environment through `process.env`. The published node must take every value from its credential and its parameters.',
				lineNumber,
			);
		}

		for (const specifier of moduleSpecifiersOn(line)) {
			const reason = classifySpecifier(specifier);
			if (reason !== undefined) {
				report(relative, `imports "${specifier}", which ${reason}.`, lineNumber);
			}
		}
	});
}

/** Every module specifier referenced on one line, in any of the four forms. */
function moduleSpecifiersOn(line) {
	const specifiers = [];
	for (const pattern of MODULE_REFERENCES) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(line)) !== null) {
			specifiers.push(match[1]);
		}
	}
	return specifiers;
}

/** The reason a specifier is forbidden, or `undefined` when it is allowed. */
function classifySpecifier(specifier) {
	const exact = FORBIDDEN_MODULE_REASONS.get(specifier);
	if (exact !== undefined) {
		return exact;
	}

	// Sub-paths of the file-system module, such as `fs/promises/x`.
	if (specifier.startsWith('fs/') || specifier.startsWith('node:fs/')) {
		return 'reads and writes the file system';
	}

	return undefined;
}

/**
 * Removes comments while PRESERVING the line count, so every finding still
 * reports the line the reader will open.
 *
 * Only comments that occupy WHOLE LINES are removed — a block comment spanning
 * entire lines, and a line whose first non-blank characters are `//`. A trailing
 * comment on a line of code survives, so a `// reads process.env` written after
 * a statement is still reported. That asymmetry is deliberate: stripping
 * comments anywhere would mean treating `"/*"` inside a string literal as the
 * start of one and blanking the code that follows, which is a FALSE GREEN. A
 * false red is read and dismissed by a human; a false green ships.
 *
 * THE BODY IS "ANYTHING THAT IS NOT A CLOSE", NEVER A LAZY `[\s\S]*?`. Laziness
 * is per MATCH, not per line: on a line that opens with a block comment and ends
 * with one, `[\s\S]` matches `*` and `/` as well, so the engine runs past the
 * FIRST close and takes the LAST one, blanking the code between them. Measured
 * against the previous form, this single line left the gate at exit 0:
 *
 *     |*! banner *|const fs = require("node:fs");exports.k = process.env.X;|*end*|
 *
 * (with `|` standing for the solidus this comment cannot spell). Two forbidden
 * accesses — the file system and the environment — reported as a clean artefact,
 * which is the exact defect class a gate exists to prevent. `(?:[^*]|\*(?!\/))*`
 * cannot cross a close, so that line now survives stripping whole and both
 * accesses are reported on their real line.
 */
function stripComments(source) {
	const withoutBlocks = source.replace(
		/^[ \t]*\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*$/gm,
		(block) => '\n'.repeat((block.match(/\n/g) ?? []).length),
	);
	return withoutBlocks
		.split('\n')
		.map((line) => (line.trimStart().startsWith('//') ? '' : line))
		.join('\n');
}

/** Every executable file in the artefact, as absolute paths, depth first. */
function collectExecutableFiles(root) {
	const found = [];
	const pending = [root];

	while (pending.length > 0) {
		const current = pending.pop();
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				pending.push(absolute);
			} else if (entry.isFile() && EXECUTABLE_EXTENSIONS.includes(path.extname(entry.name))) {
				found.push(absolute);
			}
		}
	}

	return found.sort();
}

/**
 * Packs the project the way `npm publish` would and extracts the tarball.
 * Returns the extracted root and the cleanup that removes the staging area.
 */
function packAndExtract(projectRoot) {
	const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'factuarea-n8n-package-gate-'));
	const cleanup = () => fs.rmSync(stage, { recursive: true, force: true });

	const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--pack-destination', stage], {
		cwd: projectRoot,
		encoding: 'utf8',
	});
	if (packed.error !== undefined || packed.status !== 0) {
		cleanup();
		throw new Error(`\`npm pack\` failed: ${packed.error?.message ?? packed.stderr.trim()}`);
	}

	const tarballs = fs.readdirSync(stage).filter((name) => name.endsWith('.tgz'));
	if (tarballs.length !== 1) {
		cleanup();
		throw new Error(`\`npm pack\` produced ${tarballs.length} tarballs; expected exactly one.`);
	}

	const extracted = path.join(stage, 'extracted');
	fs.mkdirSync(extracted);
	const untarred = spawnSync('tar', ['-xzf', path.join(stage, tarballs[0]), '-C', extracted], { encoding: 'utf8' });
	if (untarred.error !== undefined || untarred.status !== 0) {
		cleanup();
		throw new Error(`\`tar\` failed to extract the tarball: ${untarred.error?.message ?? untarred.stderr.trim()}`);
	}

	// npm always lays the tarball out under a single `package/` directory.
	return { root: path.join(extracted, 'package'), cleanup };
}

function main(argv) {
	const explicitArtefact = argv[2];

	let artefactRoot;
	let cleanup = () => {};
	let origin;

	if (explicitArtefact !== undefined) {
		artefactRoot = path.resolve(explicitArtefact);
		origin = `already-extracted artefact at ${artefactRoot}`;
		if (!fs.existsSync(artefactRoot) || !fs.statSync(artefactRoot).isDirectory()) {
			process.stderr.write(`check-package-constraints: "${explicitArtefact}" is not a directory.\n`);
			return 1;
		}
	} else {
		try {
			const packedArtefact = packAndExtract(PROJECT_ROOT);
			artefactRoot = packedArtefact.root;
			cleanup = packedArtefact.cleanup;
			origin = `artefact packed from ${PROJECT_ROOT}`;
		} catch (error) {
			process.stderr.write(`check-package-constraints: ${error.message}\n`);
			return 1;
		}
	}

	try {
		const { problems, scannedFiles } = auditArtefact(artefactRoot);

		if (problems.length === 0) {
			process.stdout.write(
				`check-package-constraints: OK — ${scannedFiles} executable file(s) audited in the ${origin}.\n`,
			);
			return 0;
		}

		const lines = problems
			.map(({ file, line, message }) => `  ${line === undefined ? file : `${file}:${line}`}: ${message}`)
			.sort();

		process.stderr.write(
			`check-package-constraints: ${problems.length} problem(s) in the ${origin}.\n\n${lines.join('\n')}\n`,
		);
		return 1;
	} finally {
		cleanup();
	}
}

process.exitCode = main(process.argv);
