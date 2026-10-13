# Native Factuarea CRM actions

Select the genuine **Factuarea API** credential or the separate **Factuarea CRM OAuth2** credential. API keys retain their native singleton UUID; the existing webhook trigger uses only its genuine API-key credential. OAuth uses the actual registered HTTPS issuer and n8n's S256 PKCE credential manager. Tokens stay in the host credential store. The shipped node reads no files or environment variables.

CRM requests use `https://api.factuarea.com/v1`, TLS, no redirects and a 30-second timeout. Live and sandbox share this host; the native credential binds company, actor, API channel and realm. Expected Environment checks the realm and cannot change it. OAuth calls `GET /crm/credential-context`: operation `crm_access_context.show`, fine scope `crm_access_context:read`, consent `crm_access_context.read`. It observes current company, public credential/client UUIDs, environment, fine scopes and authorization revision. Callers cannot supply an OAuth family, lineage or historical grants.

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
| Opportunity / Move Stage | POST `/crm/opportunity/{id}/stage` | `crm_opportunities.move_stage` / `crm_opportunities:write` |
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

The API-key credential's existing **Test** button reads the event catalog and
therefore needs `events:read`. CRM execution itself needs the CRM scopes listed
above. If using the trigger, retain its documented webhook scopes as well.
Use a dedicated credential with only the scopes the workflow needs.
The node adds no API-version override: the key's pinned native API version applies.

## Inputs and output

**Prepare Create** accepts **Creation Fields (JSON)** containing native fields. A lead needs at least a
non-empty `name`, `email`, `phone` or `mobile`. Opportunities need `title`, an
exact decimal string `amount` and uppercase three-letter `currency`; select
the pipeline and stage in their dynamic fields. Activities need `type`
(`task`, `call`, `meeting`, `note`), `title` and an IANA `timezone`; select a
lead, opportunity or person target. Nullable fields remain nullable and omitted
fields remain omitted. Fields outside each native write contract are rejected.

**Prepare Update** requires **Record ID**, **Expected Version**, **Changes (JSON)**
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

Use **Prepare Create**, **Prepare Update** or **Prepare Move Stage** to retain `prepared`, exact UTF-8 `originalRequestBody`, SHA256 and raw Idempotency-Key before any mutation. Persist this output and map only its saved `prepared` JSON to the matching Submit operation. Submit revalidates current authority and sends those bytes once. It does not remap input, replace CAS or retry on 401/timeouts. Mutable requests pin the actual native credential Bearer observed before preflight and reject credential replacement before dispatch, bypassing the host helper's automatic refresh/replay; read requests use n8n's native authentication helper. A successor credential UUID after refresh blocks Submit of the old preparation.

For an uncertain create or stage move, use **Recover Original** with the saved preparation (or `error.original`). It revalidates current writer authority and realm, then sends only a GET with the exact raw Idempotency-Key and the single query `original_body_sha256`. Canonical routes are Lead/Create, Opportunity/Create, Activity/Create and Opportunity/Stage. There is no GET body or POST/PATCH redispatch. The native backend alone proves OAuth refresh lineage; client checks never synthesize a family. The genuine API-key singleton must keep the same native key UUID.

Only `confirmed` with an original HTTP 2xx and valid original owner body permits continuation. Recovery preserves exact body/status, native DTO pointers and nullable Activity representation. Pending, in-progress, unconfirmed or missing receipts never authorize a replacement POST. Current C7 may change and is reauthorized natively; the saved revision grants no access. Updates have no canonical Original GET route in this contract: recovery stops before HTTP and preserves the original for native review. No client recovery TTL is invented. Prepared bodies can hold sensitive source data; use normal n8n execution access/retention controls. They contain no credential secret.

## Inbound lead → opportunity → follow-up recipe

Import [the workflow JSON](recipes/web-lead-follow-up.workflow.json) in n8n.
Select a sandbox Factuarea API credential on its six Prepare/Submit CRM nodes, a header-auth
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
2. Add **Factuarea CRM**, **Lead / Prepare Create**. Set Creation Fields to
   `={{ {name: $json.name, email: $json.email, source: 'manual'} }}` and key to
   `={{ 'inbound:' + $json.eventId + ':lead' }}`. Map the saved `prepared` output into **Submit Prepared Create**. On an error, branch to recovery
   or manual review; require `_factuarea.confirmed` before proceeding.
3. Add **Opportunity / Prepare Create**, choose an authorized pipeline and stage and
   provide `{title: 'Inbound opportunity', lead_id: <the lead output id>,
   amount: '125.0000', currency: 'EUR'}` as an n8n expression. Set a separate
   key derived from the preserved source event ID: `inbound:<eventId>:opportunity`.
   Submit its saved preparation once; proceed only on confirmed output.
4. Add **Activity / Prepare Create**, Target Type Opportunity, Target ID `={{ $json.id }}`.
   Use `{type: 'task', title: 'Follow up', timezone: 'Europe/Madrid'}` and
   `inbound:<eventId>:follow-up` as its stable key. Submit its saved preparation once. A due date, when provided,
   uses the native UTC format `YYYY-MM-DDTHH:mm:ssZ`.
5. Record completion only after the activity's native `state` and `_factuarea`
   confirmation. For updates, retain the authorized record's original version,
   body and key for native review when the result is uncertain.

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
uncertain originals before removing the package. Marketplace verification, private n8n import, registered OAuth issuer setup, deployment mounting/DDL and real sandbox execution remain separate gates. Offline tests exercise current OAuth context, renewed-token GET-only recovery and the actual node HTTP methods without claiming native backend or host execution.

```sh
npm run build
node --test dist/test/factuareaCrm.test.js test/checkPackageConstraints.test.mjs
node scripts/check-english-only.mjs src/nodes/FactuareaCrm docs/CRM.md README.md CHANGELOG.md
npm run lint:package
```

Keys with header-edge whitespace are rejected before HTTP because the host transport normalizes them. Internal printable ASCII spaces remain exact; no key is trimmed. Choose only the CRM operation scopes needed by the workflow in the OAuth credential; context read is included.

Submit refuses the host Retry On Fail setting before any HTTP request. Keep it disabled and route uncertainty to Recover Original, which performs reads only.

Unknown authentication selections fail before credential access or HTTP. Only the registered genuine API-key and OAuth credentials are accepted. Offline package validation does not prove import or execution of the inactive recipe in a local n8n instance.
