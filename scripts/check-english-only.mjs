#!/usr/bin/env node
/**
 * English-only gate.
 *
 * Fails when a user-facing string of this package is written in Spanish. The
 * package documents an explicit, bounded exception to the house rule of writing
 * user-facing text in Spanish — n8n verification and the markets this node
 * targets require English — and this gate is what keeps that exception from
 * quietly becoming a licence to ship Spanish.
 *
 * ## Usage
 *
 *     node scripts/check-english-only.mjs <path> [<path>...] [--allowlist <file>]
 *
 * Each `<path>` is a file or a directory. Directories are walked recursively,
 * skipping `node_modules`, `dist`, `coverage` and any dot-directory. A path
 * that does not exist is SKIPPED with a warning on stderr and does NOT fail the
 * run: the documentation files this gate is pointed at are written by a later
 * phase, and a gate that dies on a not-yet-written README teaches everyone to
 * stop running it. A path that exists but cannot be read IS an error: "I cannot
 * see it" must never be reported as "it is clean".
 *
 * File kinds:
 *   - `.ts` `.tsx` `.mts` `.cts` `.js` `.mjs` `.cjs` — only string literals
 *     (single-quoted, double-quoted and template) and comments/docblocks are
 *     inspected. Identifiers, keys and type names are code, not user-facing
 *     text, and flagging them would make the gate unusable.
 *   - `.md` `.mdx` — the whole text except code: fenced blocks (``` or ~~~) and
 *     inline code spans are removed before inspection.
 *   - every other extension is ignored.
 *
 * Output: one `file:line: <string>` line per finding, followed by an indented
 * line naming the markers that matched. Exit codes:
 *   - 0 — no findings.
 *   - 1 — at least one finding.
 *   - 2 — the gate could not run as configured: invalid allowlist (a reason
 *     that is empty, a value that is not a list of strings, malformed JSON), an
 *     explicitly requested allowlist file that is missing, no paths given, or a
 *     file that exists and cannot be read.
 *
 * ## Known limitation, stated on purpose
 *
 * This is a SPANISH detector, not a "not English" classifier. It looks for
 * marks that are unmistakably Spanish — the inverted opening marks `¿` and `¡`,
 * the acute-accented vowels and `ñ`, and a short list of function words — and
 * it will happily wave through German, Portuguese or nonsense. That is enough,
 * because the declared risk is not "some other language sneaks in": it is that
 * the English exception gets used to smuggle SPANISH back in, which is the one
 * language everyone working on this repository writes by default. Building a
 * real language classifier would mean a model or a dependency, and both cost
 * more than the risk they would cover.
 *
 * Two smaller limitations, so nobody reads a green run as more than it is.
 * First, a short Spanish sentence that carries no accent and none of the
 * function words below goes through: `Se ha producido un error` was measured
 * against this gate and is NOT reported, because `un` is not on the list and
 * nothing else in it is a marker. Longer prose almost always trips something.
 * Second, a Spanish character written as a JavaScript unicode escape inside a
 * string literal is not decoded, so it is not seen either.
 *
 * ## Portability, and why there is not a single import from this package
 *
 * The two sibling repositories of this epic — the WordPress plugin and the
 * Shopify app — need exactly this gate, and they are written in other
 * languages. This file is meant to be COPIED into them unchanged. That is why
 * it imports nothing from this package, reads no `package.json`, assumes no
 * directory layout beyond the paths handed to it on the command line, and uses
 * only Node built-ins with zero npm dependencies. The only thing it looks for
 * on its own is its default allowlist, resolved NEXT TO THIS FILE and never
 * from the working directory, so that copying the pair (script + allowlist)
 * keeps working from any cwd.
 *
 * Writing the gate once here and letting the other two repositories import it
 * was not an option — that would put their code in this change's scope — and
 * writing it three times would give three different rules within a month.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Spanish function words matched as WHOLE words, case-insensitively.
 *
 * The list is deliberately short and deliberately conservative: every entry has
 * to be a word that is unmistakably Spanish, because a false positive here is
 * paid by every future contributor as noise, and noisy gates get bypassed.
 *
 * `no` and `a` are NOT here even though both are extremely common Spanish
 * words: both are also ordinary English words, and including them would flag
 * most correct English sentences in the repository.
 *
 * Words such as `es`, `en` and `y` are left out for the same family of reasons:
 * `es` and `en` are the locale codes this project uses everywhere, and a single
 * letter matches far too much. The accent and `¿`/`¡` rules already catch most
 * Spanish prose; this list exists to catch the accent-free sentence that would
 * otherwise slip through, and almost every Spanish sentence contains at least
 * one of these eleven.
 */
const FUNCTION_WORDS = ['el', 'la', 'los', 'las', 'de', 'del', 'que', 'para', 'con', 'una', 'uno'];

/**
 * Word boundaries built by hand instead of `\b`.
 *
 * A hyphen counts as part of a word, so the English compounds `de-duplicate`
 * and `re-send`, and the delivery headers `Factuarea-Event-Id`, do not read as
 * the Spanish `de`. Letters are matched with `\p{L}` so that an accented
 * neighbour is a word character too, which `\b` would get wrong.
 */
const WORD_BOUNDARY_BEFORE = '(?<![\\p{L}\\p{N}_-])';
const WORD_BOUNDARY_AFTER = '(?![\\p{L}\\p{N}_-])';

const FUNCTION_WORD_PATTERN = new RegExp(
	`${WORD_BOUNDARY_BEFORE}(${FUNCTION_WORDS.join('|')})${WORD_BOUNDARY_AFTER}`,
	'giu',
);

/** Inverted opening marks exist in no other language this repository will ever hold. */
const SPANISH_PUNCTUATION_PATTERN = /[¿¡]/gu;

/**
 * The five acute-accented vowels (both cases) and `ñ`/`Ñ`.
 *
 * `ü` is not here: it is Spanish (`pingüino`) but it is also German, and no
 * word this repository needs carries it. `à`, `è` and `ò` are not here either —
 * they are Catalan and French, not the language this gate is aimed at.
 */
const SPANISH_LETTER_PATTERN = /[áéíóúÁÉÍÓÚñÑ]/gu;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.mdx']);
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage']);

const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_MISCONFIGURED = 2;

const MAX_REPORTED_STRING_LENGTH = 200;

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ALLOWLIST_PATH = path.join(SCRIPT_DIRECTORY, 'english-only-allowlist.json');

class GateConfigurationError extends Error {}

/* -------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* -------------------------------------------------------------------------- */

function parseArguments(argv) {
	const targets = [];
	let allowlistPath = null;
	let allowlistWasRequested = false;

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === '--allowlist') {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith('--')) {
				throw new GateConfigurationError('--allowlist needs a file path right after it.');
			}
			allowlistPath = value;
			allowlistWasRequested = true;
			index += 1;
			continue;
		}

		if (argument.startsWith('--allowlist=')) {
			const value = argument.slice('--allowlist='.length);
			if (value === '') {
				throw new GateConfigurationError('--allowlist needs a file path right after it.');
			}
			allowlistPath = value;
			allowlistWasRequested = true;
			continue;
		}

		if (argument === '--help' || argument === '-h') {
			return { help: true, targets: [], allowlistPath: null, allowlistWasRequested: false };
		}

		if (argument.startsWith('-')) {
			throw new GateConfigurationError(`Unknown option ${argument}.`);
		}

		targets.push(argument);
	}

	if (targets.length === 0) {
		throw new GateConfigurationError(
			'No paths given. Usage: node check-english-only.mjs <path> [<path>...] [--allowlist <file>]',
		);
	}

	return {
		help: false,
		targets,
		allowlistPath: allowlistPath ?? DEFAULT_ALLOWLIST_PATH,
		allowlistWasRequested,
	};
}

/* -------------------------------------------------------------------------- */
/* Allowlist                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Reads the allowlist and validates its shape.
 *
 * The shape is `{ "<reason>": ["<term>", ...] }` — the REASON is the key. That
 * is the whole point: an entry cannot exist without someone writing down why it
 * is there, because a bare list of allowed strings becomes, within a few
 * commits, a place to silence the gate rather than a record of decisions.
 *
 * An invalid allowlist is exit code 2 and never a silent fallback to "no
 * exceptions": that would turn a typo into either a flood of noise or, worse, a
 * green run whose exceptions nobody is applying.
 */
function loadAllowlist(allowlistPath, allowlistWasRequested) {
	let contents;
	try {
		contents = readFileSync(allowlistPath, 'utf8');
	} catch (error) {
		if (error && error.code === 'ENOENT' && !allowlistWasRequested) {
			process.stderr.write(
				`warning: no allowlist found next to the gate at ${allowlistPath}; running with no exceptions.\n`,
			);
			return [];
		}
		throw new GateConfigurationError(`Cannot read the allowlist at ${allowlistPath}: ${error.message}`);
	}

	let parsed;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw new GateConfigurationError(`The allowlist at ${allowlistPath} is not valid JSON: ${error.message}`);
	}

	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new GateConfigurationError(
			`The allowlist at ${allowlistPath} must be an object mapping a reason to a list of terms.`,
		);
	}

	const terms = [];
	for (const [reason, value] of Object.entries(parsed)) {
		if (reason.trim() === '') {
			throw new GateConfigurationError(
				`The allowlist at ${allowlistPath} has an entry with an empty reason. The reason is the key: an exception without a written reason is not an exception.`,
			);
		}
		if (!Array.isArray(value)) {
			throw new GateConfigurationError(
				`The allowlist at ${allowlistPath} maps the reason "${reason}" to something that is not a list of terms.`,
			);
		}
		for (const term of value) {
			if (typeof term !== 'string' || term === '') {
				throw new GateConfigurationError(
					`The allowlist at ${allowlistPath} has a non-string or empty term under the reason "${reason}".`,
				);
			}
			terms.push(term);
		}
	}

	// Longest first, so that "Declaración responsable" is removed as a whole
	// instead of being cut in half by a shorter entry that happens to overlap.
	terms.sort((left, right) => right.length - left.length);
	return terms;
}

/**
 * Removes every allowlisted term from a string before the heuristics run.
 *
 * An allowlisted term whitens ITSELF and nothing else: the rest of the string
 * is still inspected. Whitening the whole string would make one legitimate
 * proper noun a free pass for the Spanish sentence wrapped around it.
 *
 * Removal replaces the term with a space rather than with nothing, so that
 * cutting a term out of the middle of a word cannot glue its two halves into a
 * new word that then matches.
 */
function stripAllowlistedTerms(text, terms) {
	let result = text;
	for (const term of terms) {
		if (result.includes(term)) {
			result = result.split(term).join(' ');
		}
	}
	return result;
}

/* -------------------------------------------------------------------------- */
/* Source extraction                                                           */
/* -------------------------------------------------------------------------- */

const REGEX_CAN_FOLLOW = new Set([
	'(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^',
]);
const REGEX_CAN_FOLLOW_KEYWORD = new Set([
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'case',
]);

/**
 * Extracts the inspectable text of a source file: string literal contents and
 * comment bodies, one segment PER LINE so that every finding can name the line
 * it is on.
 *
 * This is a small lexer rather than a set of regular expressions because the
 * dangerous failure of a regex-based scanner is not noise, it is silence: a
 * quote inside a comment desynchronises the match and the rest of the file
 * stops being inspected, with the gate still reporting green. For the same
 * reason an unterminated single- or double-quoted string is closed at the end
 * of its line instead of swallowing everything after it.
 */
function extractSourceSegments(text) {
	const MODE_CODE = 0;
	const MODE_LINE_COMMENT = 1;
	const MODE_BLOCK_COMMENT = 2;
	const MODE_SINGLE_QUOTE = 3;
	const MODE_DOUBLE_QUOTE = 4;
	const MODE_TEMPLATE = 5;
	const MODE_REGEX = 6;

	const segments = [];
	let mode = MODE_CODE;
	let buffer = '';
	let bufferLine = 1;
	let line = 1;
	let index = 0;

	/** Brace depth of the `${ ... }` holes we are currently inside of. */
	const templateFrames = [];
	let braceDepth = 0;

	let previousSignificantChar = '';
	let previousWord = '';
	let currentWord = '';
	let regexInCharacterClass = false;

	const flush = () => {
		// A docblock line arrives as ` * text`; the leading marker is layout,
		// not text, and reporting it would put noise in front of every finding.
		const cleaned = mode === MODE_BLOCK_COMMENT ? buffer.replace(/^\s*\*+ ?/, '') : buffer;
		if (cleaned.trim() !== '') {
			segments.push({ line: bufferLine, text: cleaned });
		}
		buffer = '';
	};

	const startBuffer = () => {
		buffer = '';
		bufferLine = line;
	};

	const isWordChar = (character) => /[A-Za-z0-9_$]/.test(character);

	while (index < text.length) {
		const character = text[index];
		const next = text[index + 1];

		if (mode === MODE_CODE) {
			if (character === '\n') {
				line += 1;
				index += 1;
				continue;
			}

			if (isWordChar(character)) {
				currentWord += character;
			} else if (currentWord !== '') {
				previousWord = currentWord;
				currentWord = '';
			}

			if (character === '/' && next === '/') {
				mode = MODE_LINE_COMMENT;
				index += 2;
				startBuffer();
				continue;
			}
			if (character === '/' && next === '*') {
				mode = MODE_BLOCK_COMMENT;
				index += 2;
				startBuffer();
				continue;
			}
			if (character === '/') {
				const canBeRegex =
					previousSignificantChar === '' ||
					REGEX_CAN_FOLLOW.has(previousSignificantChar) ||
					(isWordChar(previousSignificantChar) && REGEX_CAN_FOLLOW_KEYWORD.has(previousWord));
				if (canBeRegex) {
					mode = MODE_REGEX;
					regexInCharacterClass = false;
					index += 1;
					continue;
				}
			}
			if (character === "'") {
				mode = MODE_SINGLE_QUOTE;
				index += 1;
				startBuffer();
				continue;
			}
			if (character === '"') {
				mode = MODE_DOUBLE_QUOTE;
				index += 1;
				startBuffer();
				continue;
			}
			if (character === '`') {
				mode = MODE_TEMPLATE;
				index += 1;
				startBuffer();
				continue;
			}
			if (character === '{') {
				braceDepth += 1;
			} else if (character === '}') {
				if (braceDepth === 0 && templateFrames.length > 0) {
					braceDepth = templateFrames.pop();
					mode = MODE_TEMPLATE;
					index += 1;
					startBuffer();
					continue;
				}
				braceDepth = Math.max(0, braceDepth - 1);
			}

			if (!/\s/.test(character)) {
				previousSignificantChar = character;
			}
			index += 1;
			continue;
		}

		if (mode === MODE_LINE_COMMENT) {
			if (character === '\n') {
				flush();
				line += 1;
				mode = MODE_CODE;
				previousSignificantChar = ';';
				index += 1;
				continue;
			}
			buffer += character;
			index += 1;
			continue;
		}

		if (mode === MODE_BLOCK_COMMENT) {
			if (character === '*' && next === '/') {
				flush();
				mode = MODE_CODE;
				previousSignificantChar = ';';
				index += 2;
				continue;
			}
			if (character === '\n') {
				flush();
				line += 1;
				bufferLine = line;
				index += 1;
				continue;
			}
			buffer += character;
			index += 1;
			continue;
		}

		if (mode === MODE_SINGLE_QUOTE || mode === MODE_DOUBLE_QUOTE) {
			const quote = mode === MODE_SINGLE_QUOTE ? "'" : '"';
			if (character === '\\') {
				buffer += character + (next ?? '');
				if (next === '\n') {
					line += 1;
				}
				index += 2;
				continue;
			}
			if (character === quote) {
				flush();
				mode = MODE_CODE;
				previousSignificantChar = quote;
				index += 1;
				continue;
			}
			if (character === '\n') {
				// Unterminated literal: recover at the newline instead of
				// swallowing the rest of the file.
				flush();
				line += 1;
				mode = MODE_CODE;
				previousSignificantChar = ';';
				index += 1;
				continue;
			}
			buffer += character;
			index += 1;
			continue;
		}

		if (mode === MODE_TEMPLATE) {
			if (character === '\\') {
				buffer += character + (next ?? '');
				if (next === '\n') {
					line += 1;
				}
				index += 2;
				continue;
			}
			if (character === '`') {
				flush();
				mode = MODE_CODE;
				previousSignificantChar = '`';
				index += 1;
				continue;
			}
			if (character === '$' && next === '{') {
				flush();
				templateFrames.push(braceDepth);
				braceDepth = 0;
				mode = MODE_CODE;
				previousSignificantChar = '{';
				index += 2;
				continue;
			}
			if (character === '\n') {
				flush();
				line += 1;
				bufferLine = line;
				index += 1;
				continue;
			}
			buffer += character;
			index += 1;
			continue;
		}

		if (mode === MODE_REGEX) {
			if (character === '\\') {
				index += 2;
				continue;
			}
			if (character === '\n') {
				// A regular expression literal cannot span lines: this was a
				// division after all. Recover instead of desynchronising.
				line += 1;
				mode = MODE_CODE;
				index += 1;
				continue;
			}
			if (character === '[') {
				regexInCharacterClass = true;
			} else if (character === ']') {
				regexInCharacterClass = false;
			} else if (character === '/' && !regexInCharacterClass) {
				mode = MODE_CODE;
				previousSignificantChar = ')';
				index += 1;
				continue;
			}
			index += 1;
			continue;
		}
	}

	flush();
	return segments;
}

/* -------------------------------------------------------------------------- */
/* Markdown extraction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Extracts the prose of a Markdown file: every line except code.
 *
 * Fenced blocks (``` and ~~~, closed by a fence of the same character and at
 * least the same length) are dropped whole, and inline code spans are removed
 * from the lines that survive. Indented code blocks are NOT dropped — telling
 * them apart from an indented list item needs a real Markdown parser, which
 * would be a dependency; a snippet that trips the gate goes inside a fence.
 */
function extractMarkdownSegments(text) {
	const lines = text.split(/\r?\n/);
	const segments = [];
	let fence = null;

	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(rawLine);

		if (fence !== null) {
			if (fenceMatch !== null && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length) {
				fence = null;
			}
			continue;
		}

		if (fenceMatch !== null) {
			fence = { character: fenceMatch[1][0], length: fenceMatch[1].length };
			continue;
		}

		const withoutInlineCode = rawLine.replace(/(`+)[^`]*?\1/g, ' ');
		if (withoutInlineCode.trim() !== '') {
			segments.push({ line: index + 1, text: withoutInlineCode });
		}
	}

	return segments;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

function findSpanishMarkers(text) {
	const markers = [];
	const seen = new Set();

	const collect = (pattern, label) => {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			const key = `${label}:${match[0]}`;
			if (!seen.has(key)) {
				seen.add(key);
				markers.push(`${label} "${match[0]}"`);
			}
			if (match[0] === '') {
				pattern.lastIndex += 1;
			}
		}
	};

	collect(SPANISH_PUNCTUATION_PATTERN, 'Spanish punctuation');
	collect(SPANISH_LETTER_PATTERN, 'Spanish letter');
	collect(FUNCTION_WORD_PATTERN, 'Spanish function word');

	return markers;
}

function formatReportedString(text) {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= MAX_REPORTED_STRING_LENGTH) {
		return collapsed;
	}
	return `${collapsed.slice(0, MAX_REPORTED_STRING_LENGTH)}…`;
}

/* -------------------------------------------------------------------------- */
/* Walking                                                                     */
/* -------------------------------------------------------------------------- */

function collectFiles(target, collected, warnings) {
	let stats;
	try {
		stats = statSync(target);
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			warnings.push(`skipping ${target}: it does not exist yet.`);
			return;
		}
		throw new GateConfigurationError(`Cannot inspect ${target}: ${error.message}`);
	}

	if (stats.isDirectory()) {
		let entries;
		try {
			entries = readdirSync(target, { withFileTypes: true });
		} catch (error) {
			throw new GateConfigurationError(`Cannot read the directory ${target}: ${error.message}`);
		}
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.isDirectory()) {
				if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) {
					continue;
				}
				collectFiles(path.join(target, entry.name), collected, warnings);
				continue;
			}
			collectFiles(path.join(target, entry.name), collected, warnings);
		}
		return;
	}

	const extension = path.extname(target).toLowerCase();
	if (SOURCE_EXTENSIONS.has(extension)) {
		collected.push({ filePath: target, kind: 'source' });
		return;
	}
	if (MARKDOWN_EXTENSIONS.has(extension)) {
		collected.push({ filePath: target, kind: 'markdown' });
	}
}

function displayPath(filePath) {
	const relative = path.relative(process.cwd(), filePath);
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		return filePath;
	}
	return relative;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

const HELP_TEXT = `English-only gate.

  node check-english-only.mjs <path> [<path>...] [--allowlist <file>]

Fails when a user-facing string is written in Spanish. Inspects string literals
and comments of .ts/.js sources and the prose of .md documents. Paths that do
not exist are skipped with a warning.

Exit codes: 0 clean, 1 findings, 2 the gate could not run as configured.
`;

function main(argv) {
	let options;
	try {
		options = parseArguments(argv);
	} catch (error) {
		if (error instanceof GateConfigurationError) {
			process.stderr.write(`english-only gate: ${error.message}\n`);
			return EXIT_MISCONFIGURED;
		}
		throw error;
	}

	if (options.help) {
		process.stdout.write(HELP_TEXT);
		return EXIT_OK;
	}

	let allowlistTerms;
	const collected = [];
	const warnings = [];
	try {
		allowlistTerms = loadAllowlist(options.allowlistPath, options.allowlistWasRequested);
		for (const target of options.targets) {
			collectFiles(target, collected, warnings);
		}
	} catch (error) {
		if (error instanceof GateConfigurationError) {
			process.stderr.write(`english-only gate: ${error.message}\n`);
			return EXIT_MISCONFIGURED;
		}
		throw error;
	}

	for (const warning of warnings) {
		process.stderr.write(`warning: ${warning}\n`);
	}

	const findings = [];
	for (const { filePath, kind } of collected) {
		let contents;
		try {
			contents = readFileSync(filePath, 'utf8');
		} catch (error) {
			process.stderr.write(`english-only gate: cannot read ${displayPath(filePath)}: ${error.message}\n`);
			return EXIT_MISCONFIGURED;
		}

		const segments = kind === 'source' ? extractSourceSegments(contents) : extractMarkdownSegments(contents);
		for (const segment of segments) {
			const inspectable = stripAllowlistedTerms(segment.text, allowlistTerms);
			const markers = findSpanishMarkers(inspectable);
			if (markers.length > 0) {
				findings.push({
					filePath: displayPath(filePath),
					line: segment.line,
					text: formatReportedString(segment.text),
					markers,
				});
			}
		}
	}

	if (findings.length === 0) {
		process.stdout.write(
			`english-only gate: no Spanish found in ${collected.length} file(s).\n`,
		);
		return EXIT_OK;
	}

	for (const finding of findings) {
		process.stdout.write(`${finding.filePath}:${finding.line}: ${finding.text}\n`);
		process.stdout.write(`    markers: ${finding.markers.join(', ')}\n`);
	}
	process.stdout.write(
		`english-only gate: ${findings.length} finding(s). Rewrite the text in English, or add the term to ${displayPath(options.allowlistPath)} under a written reason if it is a proper noun or a Spanish tax term that has to stay.\n`,
	);
	return EXIT_FINDINGS;
}

process.exitCode = main(process.argv.slice(2));
