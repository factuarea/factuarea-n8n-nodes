# Changelog

All notable changes to `n8n-nodes-factuarea` are recorded here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.2.0 — 2026-10-17 — the company axis (BREAKING)

**Every webhook route of the Factuarea public API now carries the company in its
path, so this node no longer works against the published API until it is
released.** The routes this package used —
`/v1/webhook_endpoints` and `/v1/webhook_endpoints/{id}` — answer `404`: the
resource moved under `companies/{company}` and its name is now spelled with a
hyphen. Factuarea used to resolve the company from the API key on its own, and
it no longer does, which is why the node has to be told which one to work on.

This entry describes work on a branch. Nothing is published yet, and the
publication step is described in `docs/PULL-REQUEST-COMPANY-AXIS.md`.

### Changed

- The client builds `POST /v1/companies/{company}/webhook-endpoints`,
  `GET /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}` and
  `DELETE /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}`. The
  three operations take the company UUID as their first argument; the company is
  escaped, so a pasted value cannot compose another route.
- `src/client/types.ts`, `docs/LIMITATIONS.md`, `docs/SIGNATURE-VERIFICATION.md`
  and `README.md` describe those forms and no longer show the old ones.

### Added

- **Company ID**, a required parameter of the trigger, first in the editor. It
  holds the company UUID from Factuarea (Settings, Companies), never a tax id.
- **Default Company ID**, an optional credential field, used when a trigger
  leaves its own field empty, so an account with a single company types it once.
- A catalogued message for the case where neither is filled. The trigger refuses
  to activate, and refuses to deactivate without removing its destination,
  instead of picking a company nobody chose.

### Added — account mode

The trigger can now listen to a whole Factuarea account, not only to one
company. This part is **compatible**: the new **Listen On** parameter defaults
to `Company`, and a workflow saved before it existed has no value for it and
behaves exactly as before. Nothing about a company-mode workflow changes, and
the package still declares one trigger node and one credential.

Target version: **0.2.0**, the same release as the company axis above
(`origin/main` is `0.1.2`). **Nothing has been published**: this entry describes
work on a branch, and the publication step, which is the owner's, is described in
`docs/PULL-REQUEST-ACCOUNT-MODE.md`.

- **Listen On**, with `Company` (default) and `Account`. In `Account` mode the
  lifecycle registers, checks and removes an account webhook on
  `/v1/accounts/{account}/webhooks`, and checks and removes it with the mode and
  the account stored when it was created, so changing either on an active
  workflow cannot make the node delete another destination.
- **Account ID** on the node, and **Default Account ID** on the credential. You
  type it; it is never derived from the API key. With both empty the trigger
  refuses to activate and the message names both fields.
- **Account Relationship** (`Own`, `Managed`, `All`; default `All`), sent when the
  destination is created.
- **Company ID Filter**, optional. An event of another company is acknowledged
  with `200` and dropped; an event with no `company_id` always starts the
  workflow.
- The fifteen `account.*` events in the **Events** picker of `Account` mode, next
  to the live public catalogue. They are a fixed list in
  `src/nodes/FactuareaTrigger/accountEventCatalog.ts`, checked by a test against
  the frozen API document, because no route serves them. `Company` mode offers
  none.
- The emitted item carries `account`, `account_relationship` and `company_id`,
  and the `Factuarea-Account-Relationship` header is documented. The signature,
  the tolerance and the deduplication are those of company mode.
- Catalogued messages for the rejections of account webhooks: a test key, an
  issuer that cannot manage the whole account, the account endpoint limit of the
  plan, a plan without account webhooks, and an endpoint disabled because its
  creator lost the capability.
- `README.md`, `docs/LIMITATIONS.md` (five new limitations),
  `docs/SIGNATURE-VERIFICATION.md` and `docs/PULL-REQUEST-ACCOUNT-MODE.md`.

Account mode needs a live (`fact_live_`) key issued by an owner or an admin of the
account, and is not available through OAuth.

### Unchanged, on purpose

- `GET /v1/event-catalog` keeps hanging from the root of the version, with no
  company segment: it enumerates what the product can emit, which is the same
  list for every company. The event picker and the credential test therefore
  still work before any company has been chosen, and a re-anchoring that pushed
  a company in front of every route would break both.
- The base URL of the credential still stops at `/v1`. Putting a company in it
  would break the catalogue and the credential test, which hang from that same
  root.
- The signature, the deduplication, the delivery answers and the shape of the
  emitted item.

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
