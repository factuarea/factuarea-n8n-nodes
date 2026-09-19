# An action node for the Factuarea ERP

## Decision

**Date: 2026-09-17. Decision: no. This package does not publish an action node
for the ERP operations, and no new version is released to announce them.**

Taken by the maintainers of this package (`info@factuarea.com`) while Factuarea
was adding its ERP surface — sales orders, purchase orders, goods receipts,
warehouses, stock reservations, stock transfers, delivery-note fulfilment and
returns. It is recorded in the Factuarea monorepo as the change
`factuarea/openspec/changes/erp-assistant-and-n8n-client-surfaces/`, inside the
`erp-omnichannel-orders` epic.

**Next review: 2027-03-17**, or earlier if the condition further down is met.

> **To whoever reads this after 2027-03-17:** nobody has re-checked this
> decision since that date, so read every figure below as dated rather than
> current — in particular the route and tool counts, which grow with the
> platform. Re-measure the table before repeating its conclusion to anyone. When
> the review happens, write the new review date and what changed; if the decision
> is reversed, replace this document with the reversal and its date. Do not leave
> a review date in the past: a decision record nobody revisited reads exactly like
> a current one, which is the failure this note exists to prevent.

## What an action node would be, and what this package publishes instead

An **action** node is one a workflow puts in the middle of a chain to make
something happen: create a record, change a state, send a document. A **trigger**
node starts the chain instead, and that is the only node here.

This package publishes exactly one node, of trigger type, and exactly one
credential. That is not incidental: `npm run lint:package` reads the packaged
artefact and fails when the manifest declares anything else, so shipping a second
node is a deliberate act, never an accident.

So "how do I create a sales order in Factuarea from n8n" is a fair question with
a real answer, and the answer is not "you cannot". It is at the end of this
document.

## Why an action node would not enable anything new

Measured on 2026-09-17 against the Factuarea monorepo and the published API. Each
row names where it came from, so it can be re-checked rather than trusted.

| What a workflow needs | How it is reachable today, without a node for it | Measured in |
| --- | --- | --- |
| Create, edit, confirm, cancel, close, convert, send or delete a sales order, a purchase order, a goods receipt, a warehouse, a stock transfer or a return | REST writes on the public API, on the company axis: `POST /v1/companies/{company}/sales-orders`, `POST /v1/companies/{company}/sales-orders/{id}/confirm`, and so on. 58 write routes in the sales order, purchase order, warehouse and returns contexts alone — 61 `POST`, `PATCH` and `DELETE` declarations, of which three are query-style lookups rather than writes — all reachable from n8n's HTTP Request node | The v1 route file of each bounded context, `backend/app/<Context>/Infrastructure/Http/Routes/v1-public.php` |
| Retry a write without performing it twice | The `Idempotency-Key` header. The result is stored for 24 hours and replayed with `Idempotent-Replayed: true`; reusing a key with a different body is refused with `409`; on operations whose repetition has an external or irreversible effect the header is required, and its absence is refused with `422 idempotency_key_required` | `backend/app/PublicApi/Infrastructure/Http/Middleware/EnforceIdempotency.php`; documented at <https://docs.factuarea.com/guides/idempotency> |
| Authenticate those calls with the credential already configured here | The same **Factuarea API** credential this package ships. It declares a generic authentication rule, which is what lets the HTTP Request node pick it as a predefined credential type instead of asking for the key a second time | `src/credentials/FactuareaApi.credentials.ts` |
| Let an AI step choose the operation rather than hardcoding it | n8n's MCP Client Tool node against `https://mcp.factuarea.com`, which publishes the ERP operations as tools an agent can call — 141 of them on the date above, a number that grows with the platform | `backend/app/Mcp/Servers/FactuareaPublicMcpServer.php`; connecting is documented at <https://docs.factuarea.com/mcp/connect> |

An action node would wrap the first row in a form. A picker instead of a URL is
worth something, and it is worth saying so rather than pretending otherwise — but
it is **convenience, not capability**. Every operation such a node could offer is
already callable today, by two independent paths, with the credential this
package already ships and the scopes the same API key can already carry. Nothing
is unlocked by publishing it.

## What publishing one would cost

**A second pass through the community verification queue.** Verification is
n8n's process, on n8n's timeline, and it is not part of publishing: a package
version can be on npm and still not be verified. A submission names a **published
version**, and the checks are run against that version — provenance, the official
analyser, empty runtime dependencies, no access to the environment or the
filesystem, English throughout — so a package that grows a second node is
submitted again rather than inheriting the outcome of the earlier review. See
[RELEASING.md](RELEASING.md) for the list as this repository keeps it.

**Publishing from continuous integration with a provenance attestation.** A
verified package has to be published from GitHub Actions with npm provenance over
OIDC; a version published by hand cannot be verified. That machinery exists here
and works, but every publish spends the whole release path — tag, workflow,
attestation, scan against the published version — and this package has already
paid it once for a version that was published by hand and therefore could not be
submitted (`0.1.0`, see the changelog).

**And doing all of it twice.** The ERP is the part of the platform that is moving
most right now: its resources are being added context by context, and their
public API reference is not yet published at <https://docs.factuarea.com>, which
is the observable sign that the contract is still settling. A node published
against a contract that is still moving is a node republished — and re-verified —
at every adjustment, with users pinned to whichever version they installed. The
cheap moment to build one is after the contract stops moving, not before.

None of this cost buys the user a capability. It buys a form.

## The condition under which this is revisited

This is not a permanent refusal, and it is not an open "maybe later" either.
Conditions 1 and 2 decide the answer; condition 3 decides only the timing.

1. **The ERP contract has stopped moving.** No change in flight adds, renames or
   withdraws an ERP write route or an ERP tool, **and** the API reference for the
   ERP resources is published at <https://docs.factuarea.com>. That publication
   is the observable signal: the contract gets documented for outsiders when it
   is considered settled.
2. **Someone asked for it with a case the two paths above do not cover.**
   Recorded as an issue in this repository, naming the workflow that cannot be
   built today. A workflow that would merely be nicer with a picker does not
   clear this bar; one that is impossible does.
3. **A release is going through verification anyway.** The verification pass is
   the dominant cost, so adding the node to a release that pays it for another
   reason is far cheaper than publishing one for its own sake. This condition
   moves the date, never the decision.

Until 1 and 2 both hold, the answer stays no, and the reason is the table above
rather than a preference.

## How to write to Factuarea from n8n today

Two paths, both supported, neither requiring anything from this package beyond
the credential.

**With the HTTP Request node**, when the workflow knows which operation it wants:

1. Add an **HTTP Request** node. Set **Method** to `POST` and **URL** to
   `https://api.factuarea.com/v1/companies/{company}/sales-orders`, replacing the
   segment with the UUID of the company the order belongs to.
2. Under **Authentication**, choose **Predefined Credential Type** and select
   **Factuarea API** — the same credential the trigger uses.
3. Add an `Idempotency-Key` header and derive it from something stable, not from
   a fresh random value on every run: a retry has to carry the **same** key as the
   attempt it repeats, or the write happens twice. An event delivered by this
   trigger already gives you one — the item's `id` is stable across every retry of
   that event, while `delivery_id` changes on each attempt.
4. Send the body the operation documents, and read the response.

The API key needs the scope of the operation it calls — `sales_orders:write` to
create, `sales_orders:transition` to confirm or cancel, and so on. Those are
**not** among the four scopes the trigger needs, so a key made for the trigger
alone will be refused, naming the missing permission.

**With the MCP Client Tool node**, when an AI step should choose the operation:
point it at `https://mcp.factuarea.com`, authenticate with an API key or through
OAuth, and the ERP operations arrive as tools the agent can call. The connection
is documented at <https://docs.factuarea.com/mcp/connect>.

## What this document does not say

- It does not say writing to Factuarea from n8n is unsupported. Two paths are
  supported, and the section above is how to use them.
- It does not promise an action node eventually. It states the conditions under
  which the question is reopened, and nothing beyond them.
- It does not cover the listing of the Factuarea MCP server in n8n's MCP servers
  registry, which is a separate decision with its own record in
  [MCP-REGISTRY.md](MCP-REGISTRY.md).
