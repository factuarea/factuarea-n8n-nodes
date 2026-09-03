#!/usr/bin/env node
/**
 * Refuses to run the test suite unless both halves of it are actually there.
 *
 * WHY THIS EXISTS, MEASURED RATHER THAN IMAGINED.
 *
 * `npm test` runs `node --test dist/test/*.test.js test/*.test.mjs`. The
 * compiled half lives in `dist/`, which is generated and git-ignored, so it is
 * absent on a fresh clone and after any `rm -rf dist`. With it absent, the run
 * observed on Node 22 and 24 was:
 *
 *     $ rm -rf dist && npm test
 *     ...
 *     ℹ fail 0
 *     $ echo $?
 *     0
 *
 * A small minority of the suite ran — all of it from the two `.mjs` gate files —
 * and the command reported success. Nothing in the output said that the compiled
 * tests, the large majority, had not been looked for. The shell expands an
 * unmatched pattern to nothing on those runtimes, and Node's test runner treats
 * "no files matched this pattern" as a quiet non-event.
 *
 * The two counts this paragraph used to give were correct when it was written
 * and wrong within one change; they are left out for the same reason the check
 * below counts nothing.
 *
 * A suite that finds no files and reports success is a guardrail that protects
 * nothing while reading as protection, which is the defect class this project
 * refuses to ship. The remedy is not to make the pattern cleverer: it is to say
 * out loud what the suite expects to find, and to stop if it is not there.
 *
 * The check is deliberately about PRESENCE, not about a count. Freezing "there
 * are twelve test files" here would mean editing this script every time a test
 * file is added, and a number nobody maintains is a number that gets bumped
 * without being read.
 */

import { readdirSync } from 'node:fs';

/** @type {Array<{ directory: string, suffix: string, describes: string }>} */
const EXPECTED = [
	{
		directory: 'dist/test',
		suffix: '.test.js',
		describes: 'the compiled TypeScript tests',
	},
	{
		directory: 'test',
		suffix: '.test.mjs',
		describes: 'the gate tests, which run straight from the source tree',
	},
];

/**
 * @param {string} directory
 * @param {string} suffix
 * @returns {number}
 */
function countFiles(directory, suffix) {
	try {
		return readdirSync(directory).filter((name) => name.endsWith(suffix)).length;
	} catch {
		return 0;
	}
}

const missing = EXPECTED.filter(({ directory, suffix }) => countFiles(directory, suffix) === 0);

if (missing.length > 0) {
	for (const { directory, suffix, describes } of missing) {
		console.error(
			`assert-test-files: found no ${suffix} files in ${directory}/ — ${describes}.`,
		);
	}

	console.error(
		'assert-test-files: refusing to run a suite that would report success without running them. Run `npm run build` first.',
	);
	process.exit(1);
}

const summary = EXPECTED.map(
	({ directory, suffix }) => `${countFiles(directory, suffix)} in ${directory}/`,
).join(', ');

console.log(`assert-test-files: OK — ${summary}.`);
