# Changelog

All notable changes to `n8n-nodes-factuarea` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased — not published

Documentation and gates only. **No new version of this package is released for
the Factuarea ERP, and none is needed.** Factuarea's ERP adds eight families of
events — sales orders, purchase orders, goods receipts, warehouses, stock
reservations, stock transfers, delivery-note fulfilment and returns — and they
reach the node's event picker through the live catalogue, which is read over the
network every time the picker is opened. The published artefact already behaves
correctly; republishing it would spend a release, and another pass through
community verification, to change nothing a user can observe.

Nothing under `src/` changed. That the node's source tree is untouched is the
result this work demonstrates, not a detail of it: if a new family of events had
required a code change here, the promise that the picker follows the catalogue
without a release would have been false.

### Added

- `docs/ACTION-NODE-DECISION.md`: the recorded decision not to publish an action
  node for the ERP operations, with the measurement behind it (those writes are
  already reachable from n8n's HTTP Request node with an `Idempotency-Key`, and
  from the MCP Client Tool node), the cost it avoids, the condition that would
  reopen it, and a worked example of writing to Factuarea from a workflow.
- A fifth entry in `docs/LIMITATIONS.md`: this package does not write to
  Factuarea, and what to use instead.
- A rule in `scripts/check-package-constraints.mjs` that fails when the packaged
  artefact carries a group of literal event names, naming the file and the line.
  A hardcoded list would offer events the API refuses to subscribe to and would
  tie the catalogue to the published version; the rule keeps that impossible
  rather than merely discouraged.
- Tests that drive the real client over a doubled HTTP helper on a catalogue
  containing ERP events: an active one is offered, one the catalogue marks
  `coming_soon` is not, and neither needs a change under `src/`.

### Changed

- `README.md` names the ERP event families, states that they appear in the picker
  without updating the package, explains what happens to an event that is
  announced but not yet emitted and where to read the state of each one, and
  confirms that none of it adds a scope: `events:read` is still all the picker
  needs.

## 0.1.2 — 2026-09-05

- `package.json` declares `author.name` (Factuarea), required by the official n8n community node scan (`community-package-json-author-name-missing`). No functional change.

## 0.1.1 — 2026-09-05

- Published through GitHub Actions with npm provenance (OIDC Trusted Publishing). No functional change over 0.1.0, which was published by hand without provenance and therefore fails the official n8n community node scan.
- Node 22 or newer is now required: `n8n-workflow` 2.x loads `isolated-vm`, which only builds on 22+.

## 0.1.0 — unreleased

First release. One trigger node, one credential, no runtime dependencies.

### Added

**Factuarea Trigger node.** A programmatic trigger that starts a workflow when
Factuarea delivers a signed webhook event. It registers its own webhook
destination in the user's Factuarea account when the workflow is activated,
checks on every activation that the destination is still there, still active and
still pointing at the address this instance answers on, and removes it when the
workflow is deactivated. It never attaches to a destination it did not create, because
Factuarea returns a signing secret only once, at creation.

**Factuarea API credential.** An API key plus the base URL the key belongs to,
defaulting to `https://api.factuarea.com/v1`. Authentication is
`Authorization: Bearer`. The credential test performs a read-only request to the
event catalogue, so pressing Test creates nothing and exercises the same
permission the event picker needs. The base URL is a credential field rather
than an environment variable, because a verified n8n node may not read the
environment.

**Event selection from the live catalogue.** The Events field is filled from
`GET /v1/event-catalog` using the selected credential and offers only the entries
the catalogue marks as available. Nothing is hardcoded: an event Factuarea has
announced but cannot emit yet is not offered, and an event Factuarea adds appears
without a new release of this package. A failed catalogue request leaves the
field empty and says so rather than falling back to a built-in list.

**Signature verification.** HMAC-SHA256 over the raw request body, with:

- the signed material taken as `<timestamp>.<raw body>`, using the timestamp from
  the signature header and never the local clock;
- every `v1=` candidate in the header evaluated, so a delivery signed during a
  secret rotation window, when Factuarea sends two candidates, is accepted
  whichever one matches;
- a length filter before comparison, because the constant-time primitive throws
  on buffers of different lengths;
- constant-time comparison across all candidates without short-circuiting;
- an explicit failure when the runtime does not supply the raw body, instead of
  rebuilding it by re-serialising the parsed payload, which would change bytes
  and reject every delivery;
- the bytes hashed as they arrived, without a decode and re-encode between the
  request and the digest;
- one refusal explained in the n8n log — a recent timestamp whose signature
  matches no candidate, which is what a secret rotated outside n8n looks like —
  while the response itself stays an empty `401`, so an unauthenticated caller
  learns nothing about which check refused it.

**Timestamp tolerance.** A parameter, defaulting to 300 seconds, with a range of
30 to 3600. The check is bidirectional: a receiver clock running ahead reopens
the replay window the check exists to close.

**Deduplication.** On by default. The node remembers the identifiers of processed
events, bounded to 1000 with the oldest evicted first, and answers a repeat
delivery with success without producing a second item. Factuarea retries a
delivery until it is acknowledged, so the same event does arrive more than once.

**Workflow item that preserves the event.** One item per accepted delivery,
carrying the event body with no key renamed, flattened or dropped, plus a
top-level `delivery_id` taken from the `Factuarea-Delivery-Id` header so a
workflow can tell a retry from a new event without inspecting the body.

**Response codes chosen for how Factuarea reads them.** An invalid signature or a
timestamp outside tolerance answers `401`, which Factuarea treats as a permanent
failure and does not retry, because retrying will not make a wrong signature
right. A duplicate answers `200`. An internal failure lets the runtime answer
`5xx`, which Factuarea retries with exponential back-off.

**Compliance gates, run in continuous integration and before every release.**
MIT licence, empty runtime dependencies, no access to the environment or to the
filesystem checked against the artefact that would be published rather than
against the source tree, an English-only checker over the package's own strings
and documentation, and the official n8n community package analyser.

**Publishing by tag from GitHub Actions**, authenticated with npm Trusted
Publishing over OIDC and shipped with build provenance. No long-lived npm token
exists in the repository.

**Documentation.** A README that opens with the network requirement rather than
burying it, plus `docs/LIMITATIONS.md`, `docs/SIGNATURE-VERIFICATION.md`
(complete enough to verify a delivery without this package),
`docs/RELEASING.md`, `docs/ENGLISH-ONLY.md` and `docs/MCP-REGISTRY.md`.

### Known limitations

Four, all measured and all documented in
[docs/LIMITATIONS.md](docs/LIMITATIONS.md):

- Factuarea delivers only to public HTTPS addresses and rejects private network
  destinations permanently, so a self-hosted n8n reachable only from an internal
  network never receives a delivery.
- Rotating the webhook secret outside n8n leaves the trigger unable to verify
  anything once the 24-hour dual-signing window closes; the remedy is to
  deactivate and activate the workflow.
- Deduplication is a guarantee of the activated workflow, not of a manual test
  execution.
- Factuarea suspends a destination after 100 permanent delivery failures in 24
  hours and never resumes it on its own; the trigger refuses to report a
  suspended destination — or one pointing at an address the instance no longer
  answers on — as being in place, and names the cause instead.
