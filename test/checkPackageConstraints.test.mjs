/**
 * Tests for the package constraints gate.
 *
 * The gate is exercised the way CI exercises it: as a CHILD PROCESS, asserting
 * on its exit code and on what it wrote. Importing its functions would test the
 * parts and leave the contract that actually matters — "exit 1 and name the
 * offender" — untested, and that contract is the whole point of a gate.
 *
 * Every artefact here is SYNTHETIC but one: a temporary directory holding a
 * `package.json`, a licence file and a minimal `dist/**`. The gate accepts an
 * already-extracted artefact directory as its argument precisely so these tests
 * mostly never have to pack anything — packing reads `dist/`, which several
 * agents share in this repository, and it is slow enough to be felt on every
 * case.
 *
 * The one exception is the last case, which packs the REAL package. A rule that
 * only ever meets artefacts written by its own tests can be confidently wrong
 * about the artefact that ships, so one case measures the real one.
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

/**
 * The gate's grouping threshold and span, restated here ON PURPOSE.
 *
 * They are not imported — the gate is a script, not a module, and importing it
 * would run it. Restating them is what turns them into numbers fixed BY PROOF:
 * raising the threshold in the gate alone turns the two cases below red, so the
 * change has to be made deliberately and in both places, which is the point.
 * Read from the gate they would be a comment nobody checks.
 */
const EVENT_NAME_GROUP_THRESHOLD = 3;
const EVENT_NAME_GROUP_SPAN_LINES = 5;

/**
 * One compiled file holding the given names as an array of literals.
 *
 * The names themselves are written INLINE at each call. A shared constant with
 * every event name in it would be the very list the gate forbids, sitting in
 * the file that tests the gate.
 */
function eventListing(names) {
	const entries = names.map((name) => `    '${name}',`);

	return ['"use strict";', 'exports.EVENTS = [', ...entries, '];', ''].join('\n');
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

	it('rejects a frozen list of event names and names the file and the line', () => {
		// The selector is filled from the live catalogue. A list written into the
		// artefact offers names the API rejects as soon as one is renamed, and it
		// ties the catalogue to the published version — which is the promise the
		// package makes in its documentation and cannot keep with a list inside.
		const root = artefact('frozen-event-list', (manifest, files) => {
			files['dist/src/events.js'] = eventListing([
				'invoice.created',
				'invoice.sent',
				'sales_order.confirmed',
			]);
		});

		const { status, output } = runGate(root);

		assert.equal(status, 1, `the gate accepted a frozen list of event names:\n${output}`);
		// The file AND the line the list starts on, so the finding is actionable.
		assert.match(output, /dist\/src\/events\.js:3:/);
		assert.match(output, /invoice\.created/);
		// Counted in the final summary, like every other finding of this gate.
		assert.match(output, /1 problem\(s\)/);
	});

	it('accepts a single event named in an error message', () => {
		// The other side of the same rule. Naming ONE event where the reader needs
		// it is legitimate and common, and a gate that reported it would be
		// switched off by the first person it stopped — a gate nobody runs
		// protects nothing.
		const root = artefact('single-event-mention', (manifest, files) => {
			files['dist/src/errors.js'] = [
				'"use strict";',
				"exports.message = 'Subscribe to invoice.created before activating this workflow.';",
				"exports.name = 'invoice.created';",
				'',
			].join('\n');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 0, `the gate read a single event mention as a list:\n${output}`);
	});

	it('does not read the same event name repeated as a list', () => {
		// A name said three times is one name said three times. The gate counts
		// DISTINCT names, because what makes a list a list is that it enumerates
		// the catalogue, not that it is long.
		const root = artefact('repeated-event-name', (manifest, files) => {
			files['dist/src/retry.js'] = [
				'"use strict";',
				"exports.first = 'goods_receipt.posted';",
				"exports.second = 'goods_receipt.posted';",
				"exports.third = 'goods_receipt.posted';",
				'',
			].join('\n');
		});

		const { status, output } = runGate(root);

		assert.equal(status, 0, `the gate read one repeated name as a list:\n${output}`);
	});

	it('fixes the grouping threshold by proof: one name below it passes, one above it fails', () => {
		// Two artefacts that differ by exactly one line. The threshold is then a
		// number this suite holds, not a number somebody reads off the gate and
		// trusts: move it in the gate alone and this case goes red.
		const names = ['purchase_order.approved', 'goods_receipt.posted', 'stock_transfer.dispatched'];
		assert.equal(
			names.length,
			EVENT_NAME_GROUP_THRESHOLD,
			'this case needs exactly threshold-many names',
		);

		const below = runGate(
			artefact('threshold-below', (manifest, files) => {
				files['dist/src/events.js'] = eventListing(names.slice(0, EVENT_NAME_GROUP_THRESHOLD - 1));
			}),
		);
		assert.equal(below.status, 0, `the gate reported a group below its threshold:\n${below.output}`);

		const above = runGate(
			artefact('threshold-above', (manifest, files) => {
				files['dist/src/events.js'] = eventListing(names);
			}),
		);
		assert.equal(above.status, 1, `the gate accepted a group at its threshold:\n${above.output}`);
		assert.match(above.output, /dist\/src\/events\.js:3:/);
	});

	it('does not group event names that sit further apart than the span', () => {
		// The other half of "in proximity". Threshold-many names in one file, each
		// beyond the span from the next, are prose about different things and not
		// a list; what makes a list is that they are written together.
		const scattered = ['"use strict";'];
		for (const name of ['fulfilment.prepared', 'fulfilment.handed_over', 'fulfilment.delivered']) {
			scattered.push(`exports.note = 'Factuarea emits ${name} on its own.';`);
			scattered.push(`exports.name = '${name}';`);
			scattered.push(...Array.from({ length: EVENT_NAME_GROUP_SPAN_LINES + 1 }, () => ''));
		}

		const root = artefact('scattered-event-names', (manifest, files) => {
			files['dist/src/notes.js'] = `${scattered.join('\n')}\n`;
		});

		const { status, output } = runGate(root);

		assert.equal(status, 0, `the gate grouped names that sit far apart:\n${output}`);
	});

	it('accepts the real package, packed the way npm would publish it', () => {
		// The ONLY case here that packs, and the counter-proof that the event-list
		// rule does not start red on a false positive: the package as it stands
		// has to pass. A rule that only ever meets artefacts written by its own
		// tests can be confidently wrong about the one that ships.
		//
		// Measured on 2026-09-17: the packed artefact carries 14 executable files
		// and not one event-name literal, so the rule starts green on the package
		// it is added to rather than on a promise that it would.
		//
		// It needs `dist/src` on disk — the gate packs with `--ignore-scripts` and
		// never builds. `npm test` runs `assert-test-files` first, which already
		// refuses a suite without a build, and both workflows build before
		// testing, so inside the suite the compiled tree is always there.
		assert.ok(
			fs.existsSync(path.resolve(HERE, '..', NODE_PATH)),
			`${NODE_PATH} is missing. Run \`npm run build\` first: this case packs the ` +
				'project, and there would be nothing compiled to audit.',
		);

		const result = spawnSync(process.execPath, [GATE], { encoding: 'utf8' });
		const output = `${result.stdout}${result.stderr}`;

		assert.equal(result.status, 0, `the gate rejected the real package:\n${output}`);
		// The summary says how many executable files it read, so a run that
		// audited nothing cannot read as a pass.
		assert.match(output, /OK — \d+ executable file\(s\) audited/);
	});
});
