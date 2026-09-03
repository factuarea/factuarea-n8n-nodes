/**
 * Tests for the package constraints gate.
 *
 * The gate is exercised the way CI exercises it: as a CHILD PROCESS, asserting
 * on its exit code and on what it wrote. Importing its functions would test the
 * parts and leave the contract that actually matters — "exit 1 and name the
 * offender" — untested, and that contract is the whole point of a gate.
 *
 * Every artefact here is SYNTHETIC: a temporary directory holding a
 * `package.json`, a licence file and a minimal `dist/**`. The gate accepts an
 * already-extracted artefact directory as its argument precisely so these tests
 * never have to pack anything — packing would compile, and several agents share
 * one `dist/` in this repository.
 *
 * This file is `.mjs` and not TypeScript on purpose: it drives a plain Node
 * script and needs no compilation, so it runs before `dist/` exists.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE = path.resolve(HERE, '..', 'scripts', 'check-package-constraints.mjs');

const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'factuarea-n8n-package-gate-test-'));
after(() => fs.rmSync(WORKSPACE, { recursive: true, force: true }));

const NODE_PATH = 'dist/src/nodes/FactuareaTrigger/FactuareaTrigger.node.js';
const CREDENTIAL_PATH = 'dist/src/credentials/FactuareaApi.credentials.js';

const MIT_LICENCE = `MIT License

Copyright (c) 2026 Factuarea

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
`;

const APACHE_LICENCE = `Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License").
`;

/** A compiled trigger node as `tsc` emits it: no comments, CommonJS. */
const TRIGGER_NODE_SOURCE = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FactuareaTrigger = void 0;
class FactuareaTrigger {
    constructor() {
        this.description = {
            displayName: 'Factuarea Trigger',
            name: 'factuareaTrigger',
            group: ['trigger'],
            version: 1,
            inputs: [],
            outputs: ['main'],
            webhooks: [{ name: 'default', httpMethod: 'POST', path: 'webhook' }],
            properties: [],
        };
    }
}
exports.FactuareaTrigger = FactuareaTrigger;
`;

const CREDENTIAL_SOURCE = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FactuareaApi = void 0;
class FactuareaApi {
    constructor() {
        this.name = 'factuareaApi';
        this.displayName = 'Factuarea API';
        this.properties = [];
    }
}
exports.FactuareaApi = FactuareaApi;
`;

/** The manifest of an artefact that satisfies every constraint. */
function cleanManifest() {
	return {
		name: 'n8n-nodes-factuarea',
		version: '0.1.0',
		license: 'MIT',
		main: 'dist/src/index.js',
		dependencies: {},
		peerDependencies: { 'n8n-workflow': '*' },
		devDependencies: { typescript: '^5.9.0' },
		n8n: {
			n8nNodesApiVersion: 1,
			credentials: [CREDENTIAL_PATH],
			nodes: [NODE_PATH],
		},
	};
}

/** The files of an artefact that satisfies every constraint. */
function cleanFiles() {
	return {
		LICENSE: MIT_LICENCE,
		[NODE_PATH]: TRIGGER_NODE_SOURCE,
		[CREDENTIAL_PATH]: CREDENTIAL_SOURCE,
	};
}

/**
 * Materialises one synthetic artefact and returns its root.
 *
 * @param {string} name Directory name, used only to make a failure readable.
 * @param {(manifest: object, files: Record<string, string>) => void} mutate
 *   Turns the clean artefact into the one this case needs. The clean artefact is
 *   the baseline on purpose: each case then differs from a passing package by
 *   exactly the one thing it is testing.
 */
function artefact(name, mutate = () => {}) {
	const manifest = cleanManifest();
	const files = cleanFiles();
	mutate(manifest, files);

	const root = path.join(WORKSPACE, name);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

	for (const [relative, content] of Object.entries(files)) {
		const absolute = path.join(root, relative);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, content);
	}

	return root;
}

/** Runs the gate against an extracted artefact directory. */
function runGate(root) {
	const result = spawnSync(process.execPath, [GATE, root], { encoding: 'utf8' });
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('check-package-constraints', () => {
	it('accepts an artefact that satisfies every constraint', () => {
		const { status, output } = runGate(artefact('clean'));

		assert.equal(status, 0, `the gate rejected a clean artefact:\n${output}`);
		assert.match(output, /OK/);
	});

	it('rejects a runtime dependency and names it', () => {
		const root = artefact('runtime-dependency', (manifest) => {
			manifest.dependencies = { axios: '^1.7.0' };
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted a runtime dependency:\n${output}`);
		assert.match(output, /axios/);
		assert.match(output, /dependencies/);
	});

	it('rejects a licence that is not MIT and names both the manifest and the licence file', () => {
		const root = artefact('other-licence', (manifest, files) => {
			manifest.license = 'Apache-2.0';
			files.LICENSE = APACHE_LICENCE;
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted a non-MIT licence:\n${output}`);
		assert.match(output, /Apache-2\.0/);
		assert.match(output, /package\.json/);
		assert.match(output, /LICENSE/);
	});

	it('rejects a read of the environment and names the file and the line', () => {
		const root = artefact('environment-access', (manifest, files) => {
			files['dist/src/client/httpClient.js'] = [
				'"use strict";',
				'Object.defineProperty(exports, "__esModule", { value: true });',
				'const baseUrl = process.env.FACTUAREA_BASE_URL;',
				'exports.baseUrl = baseUrl;',
				'',
			].join('\n');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted a read of the environment:\n${output}`);
		assert.match(output, /dist\/src\/client\/httpClient\.js:3:/);
		assert.match(output, /process\.env/);
	});

	it('rejects an extra node in the manifest and names the added entry', () => {
		const extraNode = 'dist/src/nodes/Factuarea/Factuarea.node.js';
		const root = artefact('extra-node', (manifest, files) => {
			manifest.n8n.nodes = [NODE_PATH, extraNode];
			files[extraNode] = TRIGGER_NODE_SOURCE;
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted a second node:\n${output}`);
		assert.match(output, /Factuarea\.node\.js/);
		assert.match(output, /exactly one node/);
	});

	it('rejects an import of the file system and names the file and the line', () => {
		// The other half of the same constraint as the environment case: the
		// requirement forbids reaching the environment AND the file system, and a
		// gate that only caught one of them would read as green while shipping the
		// other.
		const root = artefact('file-system-access', (manifest, files) => {
			files['dist/src/cache.js'] = [
				'"use strict";',
				'const node_fs_1 = require("node:fs");',
				'exports.read = () => node_fs_1.readFileSync("/tmp/cache.json", "utf8");',
				'',
			].join('\n');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted an import of the file system:\n${output}`);
		assert.match(output, /dist\/src\/cache\.js:2:/);
		assert.match(output, /node:fs/);
	});

	it('rejects a node that is not a trigger', () => {
		// The manifest can declare exactly one node and still publish an action
		// node, which is the shape n8n's verification refuses.
		const root = artefact('not-a-trigger', (manifest, files) => {
			manifest.n8n.nodes = ['dist/src/nodes/Factuarea/Factuarea.node.js'];
			files['dist/src/nodes/Factuarea/Factuarea.node.js'] = TRIGGER_NODE_SOURCE.replace(
				"group: ['trigger']",
				"group: ['transform']",
			).replace(/\s+webhooks: \[[^\]]*\],/, '');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted a node that is not a trigger:\n${output}`);
		assert.match(output, /trigger/);
	});

	it('does not read a mention of the environment inside a comment as an access', () => {
		// The compiler strips comments, but a file can arrive some other way, and a
		// gate that reported its own explanatory comment would be turned off by the
		// first person who hit it.
		const root = artefact('commented-mention', (manifest, files) => {
			files['dist/src/notes.js'] = [
				'"use strict";',
				'// This node never reads process.env; every value comes from the credential.',
				'/* Not even require("node:fs"), which the gate forbids. */',
				'exports.note = true;',
				'',
			].join('\n');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 0, `the gate read a comment as an access:\n${output}`);
	});

	it('reads code written between two block comments on one line as an access', () => {
		// The other side of the comment rule, and the one that shipped broken.
		// A minifier's banner, a bundler's `/*#__PURE__*/` marker and a hand-rolled
		// one-liner all produce a line that OPENS with a block comment and ENDS
		// with one. With a lazy body (`[\s\S]*?`) the strip ran from the first
		// opener to the LAST closer and blanked the code in between: the two
		// accesses below were invisible and the gate exited 0. A gate that reports
		// a clean artefact for a file reading the environment and the file system
		// is worse than no gate, because its green is read as proof.
		const root = artefact('code-between-comments', (manifest, files) => {
			files['dist/src/inlined.js'] = [
				'"use strict";',
				'/*! bundled */const node_fs_1 = require("node:fs");exports.k = process.env.SECRET;/* end */',
				'',
			].join('\n');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate blanked code between two comments:\n${output}`);
		// Named on its real line, both accesses, so the failure is actionable and
		// not merely non-zero.
		assert.match(output, /dist\/src\/inlined\.js:2:/);
		assert.match(output, /node:fs/);
		assert.match(output, /process\.env/);
	});
});
