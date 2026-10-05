import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { ILoadOptionsFunctions } from 'n8n-workflow';

import { DEFAULT_API_BASE_URL } from '../src/contract';
import { ACCOUNT_EVENT_CATALOG } from '../src/nodes/FactuareaTrigger/accountEventCatalog';
import {
	ERROR_EVENT_CATALOG_UNAVAILABLE,
	ERROR_INSUFFICIENT_SCOPE,
} from '../src/errors';
import { loadEventOptions } from '../src/nodes/FactuareaTrigger/loadEventOptions';
import type { FactuareaHttpRequestOptions } from '../src/client/types';

/**
 * The picker is exercised through a double of `ILoadOptionsFunctions` carrying
 * only the two members this function touches: `getCredentials` and
 * `helpers.httpRequest`.
 *
 * The double stops at the HTTP helper rather than at the client, which means the
 * REAL client runs inside every case below. That is deliberate: the
 * available-only filter lives in the client and this module delegates to it, so
 * a double of the client would assert that the delegation happens while proving
 * nothing about what the user ends up seeing. Driving the real one pins the
 * guarantee the requirement actually states — an announced-but-not-emitted event
 * is not offered — wherever the filter happens to live.
 */

const API_KEY = 'fk_live_thisisnotarealkey';

interface Double {
	readonly context: ILoadOptionsFunctions;
	readonly calls: FactuareaHttpRequestOptions[];
}

/** One programmed answer: what the helper resolves with, or what it throws. */
type Programmed = { readonly resolve: unknown } | { readonly reject: unknown };

/** A full HTTP answer, the shape the helper returns under `returnFullResponse`. */
function answer(statusCode: number, body: unknown): Programmed {
	return { resolve: { statusCode, body, headers: {} } };
}

/** A catalogue answer carrying the entries in the `data` envelope. */
function catalogue(...entries: unknown[]): Programmed {
	return answer(200, { data: entries });
}

/** One catalogue entry, in the shape `GET /v1/event-catalog` returns. */
function entry(name: string, status: 'available' | 'coming_soon'): unknown {
	return {
		name,
		category: name.split('.')[0],
		description: `Description of ${name}.`,
		status,
	};
}

/**
 * A load-options context whose helper answers from a queue, in order.
 *
 * Typed through `as unknown as ILoadOptionsFunctions` because the interface
 * carries dozens of members this function never reaches, and implementing them
 * to satisfy the compiler would say that they matter. What the double DOES carry
 * is exactly what the module is allowed to use: if someone adds a call to
 * `getNode()` or to another helper, these tests fail with a missing member
 * instead of quietly passing.
 */
function loadOptionsDouble(
	credentials: Record<string, unknown>,
	...programmed: Programmed[]
): Double {
	const calls: FactuareaHttpRequestOptions[] = [];
	const queue = [...programmed];

	const context = {
		getCredentials: async () => credentials,
		helpers: {
			httpRequest: async (options: FactuareaHttpRequestOptions) => {
				calls.push(options);
				const next = queue.shift();

				if (next === undefined) {
					throw new Error('The double was called more times than it was programmed for.');
				}

				if ('reject' in next) {
					throw next.reject;
				}

				return next.resolve;
			},
		},
	} as unknown as ILoadOptionsFunctions;

	return { context, calls };
}

/** A double with the ordinary credential of a production account. */
function withCatalogue(...programmed: Programmed[]): Double {
	return loadOptionsDouble({ apiKey: API_KEY, baseUrl: DEFAULT_API_BASE_URL }, ...programmed);
}

/**
 * The only call the double received.
 *
 * `noUncheckedIndexedAccess` makes `calls[0]` possibly undefined, and asserting
 * the count here means every test that reads a call has also pinned how many
 * requests filling the picker made.
 */
function onlyCall(double: Double): FactuareaHttpRequestOptions {
	assert.equal(double.calls.length, 1, 'filling the picker should perform exactly one request');
	const [call] = double.calls;
	assert.ok(call !== undefined);

	return call;
}

describe('loadEventOptions — what the picker offers', () => {
	it('offers only the events the catalogue declares available', async () => {
		const double = withCatalogue(
			catalogue(
				entry('invoice.paid', 'available'),
				entry('order.received', 'coming_soon'),
				entry('quote.accepted', 'available'),
			),
		);

		const options = await loadEventOptions.call(double.context);

		// An announced-but-not-emitted event is refused with 422 by the creation
		// call, so offering it would produce an error about a value the node
		// itself had suggested.
		assert.deepEqual(
			options.map((option) => option.name),
			['invoice.paid', 'quote.accepted'],
		);
	});

	it('reads the catalogue with the credential of the node', async () => {
		const double = withCatalogue(catalogue(entry('invoice.paid', 'available')));

		await loadEventOptions.call(double.context);

		const call = onlyCall(double);
		assert.equal(call.method, 'GET');
		assert.equal(call.url, `${DEFAULT_API_BASE_URL}/event-catalog`);
		assert.equal(call.headers['Authorization'], `Bearer ${API_KEY}`);
	});

	it('asks for the catalogue on the ROOT, with no company segment', async () => {
		const double = withCatalogue(catalogue(entry('invoice.paid', 'available')));

		await loadEventOptions.call(double.context);

		const call = onlyCall(double);

		// The three webhook-endpoint routes carry `companies/{company}`; this one
		// must not. The catalogue enumerates what the product can emit, the API
		// publishes it at the root of the version, and a prefixed request is a
		// 404 that empties the picker for every workflow at once. The loader also
		// reads no company parameter, so there is nothing here that could grow
		// one by accident.
		assert.doesNotMatch(call.url, /companies/, call.url);
		assert.equal(call.url.endsWith('/v1/event-catalog'), true, call.url);
	});

	it('fills the picker while the Company ID field is still empty', async () => {
		// The double answers no node parameter at all, which is exactly what a
		// node with nothing configured yet looks like. Filling the picker anyway
		// is the behaviour that lets the user pick events and company in either
		// order, and it holds only while this loader stays on the root route.
		const double = withCatalogue(catalogue(entry('invoice.paid', 'available')));

		const options = await loadEventOptions.call(double.context);

		assert.deepEqual(
			options.map((option) => option.value),
			['invoice.paid'],
		);
	});

	it('sends the base URL of the credential when it is not the production one', async () => {
		const double = loadOptionsDouble(
			{ apiKey: API_KEY, baseUrl: 'https://sandbox.factuarea.test/v1' },
			catalogue(entry('invoice.paid', 'available')),
		);

		await loadEventOptions.call(double.context);

		assert.equal(onlyCall(double).url, 'https://sandbox.factuarea.test/v1/event-catalog');
	});

	it('carries the name as the value and the catalogue description as the hint', async () => {
		const double = withCatalogue(catalogue(entry('invoice.paid', 'available')));

		const [option] = await loadEventOptions.call(double.context);

		assert.ok(option !== undefined);
		// The value is what reaches `enabled_events` on activation, so it has to
		// be the catalogue name verbatim and not a prettified label.
		assert.equal(option.name, 'invoice.paid');
		assert.equal(option.value, 'invoice.paid');
		assert.equal(option.description, 'Description of invoice.paid.');
	});
});

describe('loadEventOptions — ordering', () => {
	it('orders the options by name whatever order the catalogue returns them in', async () => {
		const double = withCatalogue(
			catalogue(
				entry('quote.accepted', 'available'),
				entry('invoice.paid', 'available'),
				entry('client.created', 'available'),
			),
		);

		const options = await loadEventOptions.call(double.context);

		assert.deepEqual(
			options.map((option) => option.value),
			['client.created', 'invoice.paid', 'quote.accepted'],
		);
	});

	it('produces the same order for the same catalogue however it is shuffled', async () => {
		const names = ['quote.accepted', 'invoice.paid', 'client.created', 'invoice.sent'];

		// The comparison is pinned to `'en'` so the order does not depend on the
		// host locale: two n8n instances rendering the same catalogue differently
		// is a support ticket nobody can reproduce.
		const first = await loadEventOptions.call(
			withCatalogue(catalogue(...names.map((name) => entry(name, 'available')))).context,
		);
		const second = await loadEventOptions.call(
			withCatalogue(catalogue(...[...names].reverse().map((name) => entry(name, 'available'))))
				.context,
		);

		assert.deepEqual(
			first.map((option) => option.value),
			second.map((option) => option.value),
		);
		assert.deepEqual(
			first.map((option) => option.value),
			['client.created', 'invoice.paid', 'invoice.sent', 'quote.accepted'],
		);
	});
});

describe('loadEventOptions — a failure never becomes a fallback list', () => {
	it('reports the frozen catalogue message when the request does not reach Factuarea', async () => {
		const double = withCatalogue({ reject: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

		await assert.rejects(
			loadEventOptions.call(double.context),
			(error: unknown) => error instanceof Error && error.message === ERROR_EVENT_CATALOG_UNAVAILABLE,
		);
	});

	it('reports the frozen catalogue message when the API answers with a failure', async () => {
		const double = withCatalogue(
			answer(500, { error: { type: 'api_error', code: 'internal_error', message: 'Error interno.' } }),
		);

		await assert.rejects(
			loadEventOptions.call(double.context),
			(error: unknown) => error instanceof Error && error.message === ERROR_EVENT_CATALOG_UNAVAILABLE,
		);
	});

	it('reports the frozen catalogue message when the credential carries no API key', async () => {
		const double = loadOptionsDouble({ baseUrl: DEFAULT_API_BASE_URL });

		await assert.rejects(
			loadEventOptions.call(double.context),
			(error: unknown) => error instanceof Error && error.message === ERROR_EVENT_CATALOG_UNAVAILABLE,
		);
		assert.equal(double.calls.length, 0, 'an unusable credential must not reach the network');
	});

	it('lets the missing-scope message through unchanged, because it names the remedy', async () => {
		const double = withCatalogue(
			answer(403, {
				error: { type: 'invalid_request_error', code: 'insufficient_scope', message: 'Permisos insuficientes.' },
			}),
		);

		// The only failure that is NOT collapsed into the catalogue message:
		// `ERROR_INSUFFICIENT_SCOPE` says to grant the key `events:read`, and
		// "the catalogue could not be loaded" would send the user to check
		// connectivity instead.
		await assert.rejects(
			loadEventOptions.call(double.context),
			(error: unknown) => error instanceof Error && error.message === ERROR_INSUFFICIENT_SCOPE,
		);
	});

	it('never answers a failure with options', async () => {
		const double = withCatalogue({ reject: new Error('boom') });

		// The whole point of reading the catalogue live: a hand-written fallback
		// list would offer events the API refuses to subscribe to, and the user
		// would meet that refusal later and somewhere else.
		const outcome = await loadEventOptions.call(double.context).then(
			(options) => ({ resolved: options }),
			(error: unknown) => ({ error }),
		);

		assert.ok('error' in outcome, 'a failed catalogue read must not resolve with a list');
	});
});

/**
 * Gives a double the node parameter the picker reads to know the mode.
 *
 * The picker asks `getCurrentNodeParameter('listenOn')`, which is the value as
 * the editor shows it right now, saved or not. A double without it stands for a
 * node whose mode was never saved, which must read as company mode.
 */
function inMode(double: Double, listenOn: unknown): Double {
	(
		double.context as unknown as { getCurrentNodeParameter: (name: string) => unknown }
	).getCurrentNodeParameter = (name: string) => (name === 'listenOn' ? listenOn : undefined);

	return double;
}

describe('loadEventOptions — account mode offers the account events as well', () => {
	it('offers the available catalogue events plus the fifteen account events', async () => {
		const double = inMode(
			withCatalogue(
				catalogue(
					entry('invoice.paid', 'available'),
					entry('order.received', 'coming_soon'),
					entry('quote.accepted', 'available'),
				),
			),
			'account',
		);

		const options = await loadEventOptions.call(double.context);
		const values = options.map((option) => option.value);

		assert.deepEqual(
			[...values].sort(),
			['invoice.paid', 'quote.accepted', ...ACCOUNT_EVENT_CATALOG].sort(),
		);
		assert.equal(values.filter((value) => String(value).startsWith('account.')).length, 15);
		// The announced-but-not-emitted rule still holds in this mode.
		assert.equal(values.includes('order.received'), false);
	});

	it('still reads the catalogue on the root, with no company and no account segment', async () => {
		const double = inMode(withCatalogue(catalogue(entry('invoice.paid', 'available'))), 'account');

		await loadEventOptions.call(double.context);

		const call = onlyCall(double);
		assert.equal(call.url, `${DEFAULT_API_BASE_URL}/event-catalog`);
		assert.doesNotMatch(call.url, /companies|accounts/, call.url);
	});

	it('orders the merged list by name and describes every option', async () => {
		const double = inMode(
			withCatalogue(catalogue(entry('quote.accepted', 'available'), entry('client.created', 'available'))),
			'account',
		);

		const options = await loadEventOptions.call(double.context);
		const names = options.map((option) => option.name);

		assert.deepEqual(names, [...names].sort((left, right) => left.localeCompare(right, 'en')));
		for (const option of options) {
			assert.equal(option.name, option.value);
			assert.ok((option.description ?? '').length > 0, `${option.name} has no description`);
		}
	});

	it('offers a name once even if the catalogue were to list it', async () => {
		const double = inMode(
			withCatalogue(catalogue(entry('account.member_added', 'available'))),
			'account',
		);

		const options = await loadEventOptions.call(double.context);

		assert.equal(options.filter((option) => option.value === 'account.member_added').length, 1);
		assert.equal(options.length, 15);
	});

	it('does not turn a failed catalogue read into a list of account events only', async () => {
		const double = inMode(withCatalogue({ reject: new Error('boom') }), 'account');

		await assert.rejects(
			loadEventOptions.call(double.context),
			(error: unknown) => error instanceof Error && error.message === ERROR_EVENT_CATALOG_UNAVAILABLE,
		);
	});
});

describe('loadEventOptions — company mode never offers an account event', () => {
	for (const [label, mode] of [
		['company', 'company'],
		['no mode saved', undefined],
		['an unknown mode', 'something-else'],
	] as const) {
		it(`offers no name starting with account. with ${label}`, async () => {
			const double = inMode(
				withCatalogue(catalogue(entry('invoice.paid', 'available'), entry('quote.accepted', 'available'))),
				mode,
			);

			const options = await loadEventOptions.call(double.context);

			// A company endpoint rejects every `account.*` name with 422, so offering
			// one would be an option the node cannot activate.
			assert.deepEqual(
				options.map((option) => option.value),
				['invoice.paid', 'quote.accepted'],
			);
			assert.equal(
				options.some((option) => String(option.value).startsWith('account.')),
				false,
			);
		});
	}
});
