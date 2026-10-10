# Native Factuarea CRM actions

Add **Factuarea CRM** to an n8n workflow and select its **Factuarea API**
credential. n8n encrypts and masks the API key and authenticates requests with
its own HTTP helper. The node never reads environment variables or files.
The existing webhook trigger and its credential test remain unchanged.

The CRM node sends credentials only to `https://api.factuarea.com/v1`, verifies
TLS, disables redirects and uses a 30-second request timeout. Live and sandbox
share this host; the API key binds company, actor, API channel and realm.
**Expected Environment** checks the native realm and cannot change it.
No Company ID, actor ID, internal integer alias or authorization grant is accepted
as a request parameter. Public records use `id` and `*_id` UUIDs; owners use
their public user UUID. Company switching means selecting another credential.

## Native operation matrix

The contract below was checked against native route, request, resource and
confirmed-identity implementations on 2026-10-10. Paths are relative to `/v1`.
All operations first require `crm_access_context:read` for
`GET /crm/access-context` and the current native CRM module, plan, role, record,
field and sandbox policies. A key scope alone does not enable an operation.

| Resource / node operation | Method and native path | Operation / key scope |
| --- | --- | --- |
| Lead / Get Many | GET `/crm/leads` | `crm_leads.index` / `crm_leads:read` |
| Lead / Get | GET `/crm/leads/{id}` | `crm_leads.show` / `crm_leads:read` |
| Lead / Create | POST `/crm/leads` | `crm_leads.create` / `crm_leads:write` |
| Lead / Update | PATCH `/crm/leads/{id}` | `crm_leads.update` / `crm_leads:write` |
| Opportunity / Get Many | GET `/crm/opportunity` | `crm_opportunities.list` / `crm_opportunities:read` |
| Opportunity / Get | GET `/crm/opportunity/{id}` | `crm_opportunities.show` / `crm_opportunities:read` |
| Opportunity / Create | POST `/crm/opportunity` | `crm_opportunities.create` / `crm_opportunities:write` |
| Opportunity / Update | PATCH `/crm/opportunity/{id}` | `crm_opportunities.update` / `crm_opportunities:write` |
| Activity / Get Many | GET `/crm/crmactivity` | `crm_activities.index` / `crm_activities:read` |
| Activity / Get | GET `/crm/crmactivity/{id}` | `crm_activities.show` / `crm_activities:read` |
| Activity / Create | POST `/crm/crmactivity` | `crm_activities.create` / `crm_activities:write` |
| Activity / Update | PATCH `/crm/crmactivity/{id}` | `crm_activities.update` / `crm_activities:write` |
| Contact Person / Search | GET `/crm/contact-people?search=...` | `crm_contact_people.index` / `crm_contact_people:read` |
| Pipeline selector | GET `/crm/pipelines` | `crm_pipelines.index` / `crm_pipelines:read` |
| Stage selector | GET `/crm/pipelines/{id}` and its `stages` DTO | `crm_pipelines.show` / `crm_pipelines:read` |
| Person target selector | GET `/crm/contact-people/options?kind=people` | `crm_contact_people.options` / `crm_contact_people:read` |

Lead and opportunity target selectors use the corresponding authorized list.
They omit archived entries, keep public UUID values and use only names the API
actually exposes; a hidden name falls back to its visible public ID. Selectors
stop at 1,000 options. An expression can provide an authorized ID beyond that cap.
A failed selector never falls back to cached or hardcoded records.

The shared credential's existing **Test** button reads the event catalog and
therefore needs `events:read`. CRM execution itself needs the CRM scopes listed
above. If using the trigger, retain its documented webhook scopes as well.
Use a dedicated credential with only the scopes the workflow needs.
The node adds no API-version override: the key's pinned native API version applies.

## Inputs and output

**Creation Fields (JSON)** contains native fields. A lead needs at least a
non-empty `name`, `email`, `phone` or `mobile`. Opportunities need `title`, an
exact decimal string `amount` and uppercase three-letter `currency`; select
the pipeline and stage in their dynamic fields. Activities need `type`
(`task`, `call`, `meeting`, `note`), `title` and an IANA `timezone`; select a
lead, opportunity or person target. Nullable fields remain nullable and omitted
fields remain omitted. Fields outside each native write contract are rejected.

**Update** requires **Record ID**, **Expected Version**, **Changes (JSON)**
and a stable key. Lead updates send native top-level changes; opportunity and
activity updates send the native `{expected_version, changes}` envelope.
Do not derive Expected Version from a subsequent read after a conflict.
Amounts remain decimal strings; numeric floats are rejected.

**Get Many** retains the same Filters JSON on every cursor page. Leads use
`data.data` plus `has_more` and `next_cursor`; opportunities and activities use
`data.items` and `next_cursor`. Contact search uses native `page`, `per_page`
and `meta.total`, rather than inventing cursor support. **Return All** follows
pages up to **Maximum Items** (default 1,000, maximum 10,000 per input item).
Disabling Return All returns the first page. Each page checks current C7 and
realm; a changed or denied context discards the accumulated list. Invalid or
repeated cursors fail explicitly.

Output preserves native DTO fields, including omitted or null private fields,
without making follow-up requests to hydrate them. Read and list items are
paired with their original input index. Activity Get preserves its native
`activity`, `comments` and `attachments` envelope. Confirmed writes add
`_factuarea: {confirmed: true, replayed, idempotencyKey}`. Activity writes retain
their native `state`, `effect_id`, `activity_id` and nullable `activity` fields;
pending or unconfirmed states never become successful workflow items.

## Conflicts and uncertain writes

Every write requires a stable **Idempotency Key**, unique to a source item and
operation. Derive it from a durable source event ID, not the execution ID or a
random value. The node does not retry writes automatically. A timeout,
connection error, 5xx or invalid confirmation is **unconfirmed**, because the
effect might have committed. Do not submit another key or announce success.

With **Continue On Fail**, the item contains an `error` object, preserving
pairing. Successful items contain no `error`. Safe errors expose a code,
status, `unconfirmed`, safe 422 field names and numeric 429 `retryAfterSeconds`
when supplied by the API. Messages never include credentials or raw private API
responses. An HTTP 409 preserves the original key and CAS without fetching a
new head. The native codes `crm_version_conflict`, `idempotency_key_reused` and
`crm_effect_unconfirmed` distinguish a stale revision, different original
content and an uncertain native effect; only the latter is marked unconfirmed.

To reconcile an uncertain write, route that item to **Recover Original** for
the same resource and credential, using `={{ $json.error.original }}` in
**Original Request (JSON)**. This revalidates current availability, C7 and realm,
then sends the exact original method, route, body, key and version through the
native confirmed-identity replay contract. Its receipt or native confirmed
response is evidence of the original; a mutable Get is never used as evidence.
Revoked scope, another credential, changed realm or C7 fails before dispatch.
Deterministic conflicts still need review; recovery never repairs them silently.

Recovery is limited to **five minutes** from original dispatch to stay inside
the native owners' one-day intent reservation window. The public idempotency
cache defaults to one day and can be configured shorter; deployments using this
node must keep native replay retention above the five-minute recovery window.
After expiry, investigate the original outcome through the native service
before deciding on any replacement. The node does not invent a result lookup
endpoint. Keep the original object unchanged: it contains the authored body,
which may hold sensitive source data, so apply normal n8n execution retention
and access controls to these error items. It contains no API key.

## Inbound lead → opportunity → follow-up recipe

Import [the workflow JSON](recipes/web-lead-follow-up.workflow.json) in n8n.
Select a sandbox Factuarea API credential on its three CRM nodes, a header-auth
credential on the inbound Webhook, and an authorized pipeline/stage on Create
Opportunity. The workflow is inactive and contains no credentials or secrets.
It checks a durable, non-empty source `eventId`, branches every failed or
unconfirmed step to a review response, and responds with `completed: true`
only after all three native effects confirm. Original requests remain in the
n8n execution error items for explicit recovery. Import and execution in an
actual n8n instance remain deployment validation; the supplied offline tests
check the graph and real action-node behavior without claiming runtime import.

1. Receive an inbound event with n8n's Webhook node or a supported trigger.
   Preserve its durable `eventId`. Use a sandbox credential while constructing
   the workflow; set Expected Environment to Sandbox.
2. Add **Factuarea CRM**, **Lead / Create**. Set Creation Fields to
   `={{ {name: $json.name, email: $json.email, source: 'manual'} }}` and key to
   `={{ 'inbound:' + $json.eventId + ':lead' }}`. On an error, branch to recovery
   or manual review; require `_factuarea.confirmed` before proceeding.
3. Add **Opportunity / Create**, choose an authorized pipeline and stage and
   provide `{title: 'Inbound opportunity', lead_id: <the lead output id>,
   amount: '125.0000', currency: 'EUR'}` as an n8n expression. Set a separate
   key derived from the preserved source event ID: `inbound:<eventId>:opportunity`.
   Proceed only on confirmed output.
4. Add **Activity / Create**, Target Type Opportunity, Target ID `={{ $json.id }}`.
   Use `{type: 'task', title: 'Follow up', timezone: 'Europe/Madrid'}` and
   `inbound:<eventId>:follow-up` as its stable key. A due date, when provided,
   uses the native UTC format `YYYY-MM-DDTHH:mm:ssZ`.
5. Record completion only after the activity's native `state` and `_factuarea`
   confirmation. For updates, first retain the authorized record's version and
   reuse that exact version and key during original recovery.

In step 3, reference the Lead node's paired output rather than the inbound
payload for `lead_id`; use the inbound node's paired item to recover `eventId`.
If enabled, Continue On Fail makes the error branch explicit at every step.
The package does not promise unsupported CRM trigger event types; the existing
trigger offers only the current native event catalog.

## Contract sources and local verification

Native contracts: Lead, Opportunity, CrmActivity, Pipeline, BusinessContact and
CrmAccess `Infrastructure/Http/Routes/v1-public.php`, their request/resources,
`PublicApi/.../Middleware/EnforceIdempotency.php`, native owner reservations and
`Shared/.../Idempotency/ConfirmedIdentityReplay.php`. The sibling Node SDK's
generated native lead, pipeline and contact metadata agrees with these paths;
opportunity and activity paths come directly from their native owners. No SDK
runtime dependency is added because n8n provides authenticated HTTP transport
and this community package keeps zero runtime dependencies.

The node follows n8n's [programmatic node contract](https://docs.n8n.io/connect/create-nodes/build-your-node/tutorial-build-a-programmatic-style-node/)
and [authenticated HTTP helper contract](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/http-request-helpers/).
Offline unit tests exercise the real node and its HTTP transport with scripted
native envelopes. They do not contact the API or publish a package:

The source package contains the new action; a previously published package
version does not gain it until a separate release is approved. Build this
checkout for private installation, select credentials in n8n and keep the
imported workflow inactive until configuration is complete. To disconnect,
deactivate workflows and revoke their dedicated API credential; preserve
uncertain originals before removing the package. Marketplace verification,
OAuth2 refresh and a live sandbox/installation run are separate gates: current
public CRM routes authenticate API keys, so this action does not fabricate
OAuth authorization or token endpoints.

```sh
npm run build
node --test dist/test/factuareaCrm.test.js test/checkPackageConstraints.test.mjs
node scripts/check-english-only.mjs src/nodes/FactuareaCrm docs/CRM.md README.md CHANGELOG.md
npm run lint:package
```
