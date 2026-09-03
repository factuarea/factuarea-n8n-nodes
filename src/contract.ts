/**
 * Frozen delivery contract between Factuarea and this trigger node.
 *
 * Everything in this file was READ OFF THE EMITTER, not invented. The emitter
 * lives in the Factuarea monorepo and is the only source of truth; if it ever
 * changes, this file changes first and every other module follows.
 *
 * Measured 2026-09-02 against:
 *   - `backend/app/Webhooks/Domain/Service/HmacSignatureGenerator.php`
 *     (signature header format and signed material)
 *   - `backend/app/Webhooks/Application/Command/DeliverWebhook/DeliverWebhookCommandHandler.php`
 *     (the exact header names put on the wire)
 *   - `backend/app/Webhooks/Application/Command/RecordEvent/RecordEventCommandHandler.php`
 *     (the exact shape of the event body)
 *   - `backend/config/public_api.php` (public API domain)
 *
 * ## Signature header format
 *
 * The emitter sends a single header whose value is a comma-separated list of
 * `key=value` pairs:
 *
 *     Factuarea-Signature: t=<unix>,v1=<hex>
 *     Factuarea-Signature: t=<unix>,v1=<hex_current>,v1=<hex_previous>
 *
 * There is exactly one `t=` and **one OR MORE** `v1=`. The second `v1=` appears
 * while a rotated secret is still inside its grace window: the emitter signs the
 * same body with the current secret AND with the previous one. A verifier that
 * reads the first `v1=` and stops rejects legitimate deliveries for the whole
 * rotation window, so every candidate has to be evaluated.
 *
 * A future emitter may add pairs this node does not know. Unknown pairs are
 * IGNORED, never treated as an error: rejecting them would break the node the
 * day Factuarea adds a field.
 *
 * ## Signed material
 *
 * The HMAC-SHA256 input is the timestamp, a literal dot, and the raw body:
 *
 *     signedPayload = `${t}` + "." + rawBody
 *     signature     = HMAC-SHA256(signedPayload, secret)   // lowercase hex
 *
 * The `t` used to build the material is the same value carried in `t=`, so it is
 * read from the header and never taken from the local clock.
 *
 * ## Re-serialising the body invalidates every signature
 *
 * `rawBody` means the bytes that arrived on the wire. The emitter signs the exact
 * JSON string it sends, produced with `JSON_UNESCAPED_SLASHES`. Parsing that JSON
 * and serialising the resulting object again changes separators, key escaping and
 * slash escaping, so a body that is byte-for-byte legitimate becomes a signature
 * that never matches. The failure mode is silent and total: the node rejects
 * 100% of deliveries and nothing in the message explains why.
 *
 * Therefore: read the raw body, verify the raw body, and if the runtime cannot
 * supply it, FAIL with `ERROR_RAW_BODY_UNAVAILABLE` instead of reconstructing it.
 *
 * ## Frozen npm scripts (declared in package.json, consumed by later phases)
 *
 *   build         compile TypeScript to `dist/` and copy node icons next to it
 *   test          Node's native test runner over the compiled tests
 *   lint:english  English-only gate over `src`, `docs`, `README.md`, `CHANGELOG.md`
 *   lint:package  licence / dependencies / env / filesystem gate over the artefact
 *   scan          official n8n community package analyser
 *   verify        build, then the four above in order
 *
 * Five notes about those scripts that later phases must not "fix":
 *
 *  1. `lint:english` deliberately does NOT scan `test/`. The gate's own test
 *     fixtures contain Spanish on purpose (that is what proves the gate fires),
 *     so scanning the test tree would make the gate fail on itself.
 *  2. `scan` asserts on the analyser's OUTPUT, not on its exit code. The official
 *     CLI (`npx @n8n/scan-community-package <package-name>[@version]`, measured
 *     against version 0.34.0) prints a failure line and still exits 0; only an
 *     internal crash exits non-zero. Trusting its exit code alone would make the
 *     gate green on a failing scan, which is the "guardrail that reports success
 *     while protecting nothing" this project treats as a defect. The analyser also
 *     resolves the package FROM THE NPM REGISTRY, so it can only inspect a
 *     published version — it cannot scan an unpublished working tree.
 *  3. `test` hands Node a list of FILES, expanded by the shell, and never a
 *     directory and never a pattern Node itself has to expand. Both of the
 *     obvious shapes work on part of the range this package claims to support
 *     and fail on the rest. Measured, running the whole suite on each runtime:
 *
 *                                        Node 20.20.2  22.23.2  24.15.0
 *       node --test dist/test/ test/          pass      FAIL     FAIL
 *       node --test "dist/test/**\/*.test.js" FAIL      pass     pass
 *       node --test dist/test/*.test.js       pass      pass     pass
 *
 *     Directories stopped being expanded after Node 20 (`MODULE_NOT_FOUND` on
 *     `.../dist/test`, two synthetic failures, not one real test run), and Node
 *     20 does not understand a glob pattern (`Could not find '.../**\/*.test.js'`).
 *     Only a plain list survives all three, and `engines` declares `>=20.15`
 *     while the CI matrix runs 20, 22 and 24, so all three have to pass.
 *     The arguments are therefore UNQUOTED on purpose: the shell expands them
 *     and Node receives real paths. Two consequences worth knowing before
 *     editing them. The patterns are one level deep, so the test trees stay
 *     FLAT — a test in a subdirectory would be skipped in silence. And an
 *     unmatched pattern is NOT an error: measured on Node 22 and 24 with `dist/`
 *     deleted, `npm test` ran ONLY the tests of the two `.mjs` gate files,
 *     reported them as a pass, exited 0, and said nothing at all about the
 *     compiled tests — the large majority of the suite — that it had not looked
 *     for. That is why the script runs `scripts/assert-test-files.mjs` first: it
 *     refuses to start when either half of the suite is missing. Do not remove
 *     that guard — without it, "the tests pass" and "the tests were not built"
 *     are the same output. No test COUNT is written here on purpose: a number in
 *     a comment is not maintained, and the one that used to be here had already
 *     drifted from the suite it described.
 *  4. The compiled tests read their fixtures from the SOURCE tree, and the build
 *     copies only icons. `test/vectors/signature-vectors.json` is looked up by
 *     `verifySignature.test.ts` next to the running file first and then two
 *     levels up in `test/vectors/`, which is what resolves when the compiled copy
 *     runs from `dist/test/`. Widening the build's copy step to carry fixtures
 *     into `dist/` would put test data inside the directory the artefact is built
 *     from, for no gain: the lookup already works and `files` keeps `dist/test`
 *     out of the tarball.
 *  5. Every script that compiles calls `tsc` DIRECTLY, resolved from
 *     `node_modules/.bin`, which npm puts on the PATH of a script it runs.
 *     Never `npx tsc`. The reason is not flag handling: that was checked, and on
 *     npm 12.0.1 `npx tsc --noEmit` did pass the flag through and emitted
 *     nothing, exactly like `./node_modules/.bin/tsc --noEmit`. The reason is
 *     resolution. `npx` falls back to fetching a package from the registry when
 *     it cannot resolve one locally, so a build written that way silently stops
 *     being reproducible the day `node_modules` is incomplete: it would compile
 *     with whatever TypeScript the registry serves instead of the version
 *     `devDependencies` pins, over the network, without saying so. `scan` is the
 *     one script that uses `npx` on purpose, and it does so because it MUST run
 *     the analyser's current version — see note 2.
 */

/**
 * Header names the emitter puts on every delivery, spelled exactly as sent.
 *
 * HTTP header names are case-insensitive, so a consumer must lowercase before
 * looking them up in a runtime that normalises incoming headers. These constants
 * carry the canonical casing; `DELIVERY_HEADER_LOOKUP` carries the lowercase form
 * to look up with.
 */
export const DELIVERY_HEADERS = {
	/** `t=<unix>,v1=<hex>[,v1=<hex>]` — see the signature format above. */
	signature: 'Factuarea-Signature',
	/** UUID v7 of the event. Stable across retries: the deduplication key. */
	eventId: 'Factuarea-Event-Id',
	/** Event name in `<category>.<action>` form, e.g. `invoice.created`. */
	eventType: 'Factuarea-Event-Type',
	/** UUID v7 of this particular delivery attempt. Changes on every retry. */
	deliveryId: 'Factuarea-Delivery-Id',
	/** Equal to the event id. Sent so generic receivers can deduplicate too. */
	idempotencyKey: 'Idempotency-Key',
} as const;

/** Lowercase header names, for runtimes that normalise incoming headers. */
export const DELIVERY_HEADER_LOOKUP = {
	signature: 'factuarea-signature',
	eventId: 'factuarea-event-id',
	eventType: 'factuarea-event-type',
	deliveryId: 'factuarea-delivery-id',
	idempotencyKey: 'idempotency-key',
} as const;

/**
 * The body of a delivery, exactly as Factuarea publishes it.
 *
 * These eight keys are the whole top level. The node MUST NOT rename, flatten or
 * drop any of them when it builds a workflow item: a workflow built on `data.object`
 * breaks the moment this package decides on a different shape.
 */
export interface FactuareaEventBody {
	/** UUID v7 of the event. */
	id: string;
	/** Event name in `<category>.<action>` form, e.g. `invoice.paid`. */
	type: string;
	/** Contract version the payload was built for (`YYYY-MM-DD`), or null. */
	api_version: string | null;
	/** Unix timestamp (seconds) at which the event was recorded. */
	created: number;
	/** False for events produced by a sandbox / mirror company. */
	livemode: boolean;
	/** True when the delivery was triggered as a test from the dashboard. */
	test: boolean;
	/** Ties this event to the internal chain that produced it, or null. */
	correlation_id: string | null;
	/** Payload. By convention `{ <resource>: { … } }`; shape varies by `type`. */
	data: Record<string, unknown>;
}

/**
 * Default replay tolerance, in seconds.
 *
 * 300 s is the window the emitter documents as the consumer's decision
 * (`HmacSignatureGenerator.php`). It is applied in BOTH directions — a receiver
 * clock running ahead reopens exactly the replay window the check exists to
 * close, and clock skew is this check's real-world failure mode.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** Lower bound offered by the node's tolerance parameter, in seconds. */
export const MIN_TOLERANCE_SECONDS = 30;

/** Upper bound offered by the node's tolerance parameter, in seconds. */
export const MAX_TOLERANCE_SECONDS = 3600;

/**
 * Length of a SHA-256 digest rendered as lowercase hex.
 *
 * Candidates of any other length are discarded BEFORE comparison, because
 * `crypto.timingSafeEqual` throws when the two buffers differ in length. The
 * filter leaks nothing: the length of a SHA-256 hex digest is public and
 * constant, and it is the same for every secret.
 */
export const SHA256_HEX_DIGEST_LENGTH = 64;

/**
 * How many processed event ids the node remembers for deduplication.
 *
 * Deliberately conservative. The store lives in the node's own static state, so
 * an unbounded one would grow for the lifetime of the n8n process on a busy
 * instance. 1000 covers far more than the emitter's retry schedule can produce
 * for a single event while costing a few tens of kilobytes; the oldest entries
 * are evicted first. Raising or lowering it changes no requirement and no test
 * beyond the eviction test's own numbers.
 */
export const DEDUPE_CAPACITY = 1000;

/**
 * Default base URL of the Factuarea public API v1.
 *
 * Measured: `backend/config/public_api.php` mounts the v1 routes on the domain
 * `api.factuarea.com` and `PublicApiServiceProvider` prefixes them with `v1`.
 *
 * It is a CREDENTIAL PARAMETER and never an environment variable: n8n's
 * verification forbids reading the environment, and without the parameter there
 * would be no way to point the node at a non-production environment.
 */
export const DEFAULT_API_BASE_URL = 'https://api.factuarea.com/v1';
