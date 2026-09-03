# Listing the Factuarea MCP server in n8n's MCP servers registry

## Decision

**Date: 2026-09-02. Decision: yes, list it.**

The Factuarea public MCP server should be listed in n8n's MCP servers registry.

**Registry identifier: not yet assigned.**

> **To whoever executes this:** when the listing is accepted, replace the line
> above with the identifier n8n assigns, the date, and who submitted it. For
> example: `Registry identifier: factuarea — listed 2026-10-14 by <name>.` If the
> submission is refused, write the refusal and its reason here instead. Do not
> leave this document saying "not yet assigned" once it no longer is: a decision
> record that does not record the outcome is worse than none, because it reads as
> current.

## Why it is worth doing

n8n's documentation for the MCP Client Tool node states:

> "If the service you want is available in n8n's MCP servers registry, you can
> connect it straight from the node panel without adding a credential."

That is the whole value. A listed server is one entry in the node panel. An
unlisted one is a URL and a credential the user has to find, paste and maintain
before anything works. For a service whose users are accountants and small
businesses rather than integrators, that difference is most of the adoption.

Until the listing exists, users can already connect manually with the MCP Client
Tool node, pointing it at `https://mcp.factuarea.com` with an API key or through
OAuth. That path is documented at <https://docs.factuarea.com/mcp/connect>, and
it is unaffected by this listing.

Note that this is a **different** listing from the one in the official Model
Context Protocol registry, which is handled elsewhere in the Factuarea roadmap.
The two are independent submissions to independent parties.

## The data to send

Measured on 2026-09-02 against the Factuarea monorepo and its published
documentation. Each row names where it came from, so it can be re-checked rather
than trusted.

| Field | Value | Measured in |
| --- | --- | --- |
| Display name | `Factuarea` | — |
| Publisher | Factuarea | — |
| Description | Spanish invoicing and e-invoicing platform: invoices, quotes, pro formas, delivery notes, recurring and purchase invoices, clients, suppliers, products, document series, taxes and VeriFactu. | — |
| Server URL | `https://mcp.factuarea.com` | `infrastructure/nginx/mcp.factuarea.com.conf` (the subdomain root proxies to the backend MCP transport) |
| Legacy alias | `https://mcp.factuarea.com/mcp` — still served, kept for compatibility | `docs.factuarea.com/mcp/connect` |
| Transport | Streamable HTTP. JSON-RPC 2.0 over `POST`; `GET` opens the server-to-client stream; `DELETE` ends a session. No stdio transport is offered publicly. | Live route table: `GET|HEAD mcp`, `POST mcp`, `DELETE mcp` |
| Protocol revision | `2026-07-28`, the single revision the server admits | `backend/config/mcp.php` (`protocol_versions`) |
| Authentication | Two accepted credentials, see below | `backend/routes/ai.php` |
| Tool count | Count `FactuareaPublicMcpServer::$tools` **at submission time** and submit that number. A figure frozen in this table is wrong within weeks, because the list grows with every bounded context that publishes a tool — and unlike every other row here, this one cannot be re-derived from the value itself: a stale number reads exactly like a current one. | `backend/app/Mcp/Servers/FactuareaPublicMcpServer.php` |
| Prompts | none published at the time of writing | — |
| Documentation | <https://docs.factuarea.com/mcp/connect> | — |
| Tool catalogue | <https://docs.factuarea.com/mcp/tools> | — |
| Scopes | <https://docs.factuarea.com/mcp/scopes> | — |
| Contact | `info@factuarea.com` | `package.json` |
| Home page | <https://factuarea.com> | — |

### Authentication, in the detail a registry usually asks for

**OAuth 2.1**, the path for end-user tools. The client registers itself and the
user authorises it through a consent screen on which they pick the company, the
environment (live or sandbox) and the scopes to grant.

| Endpoint | Standard |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 authorisation server metadata |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 protected resource metadata |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET /oauth/authorize` | Authorisation, with consent |
| `POST /oauth/token` | Token exchange and refresh |
| `POST /oauth/revoke` | RFC 7009 |
| `POST /oauth/introspect` | RFC 7662 |

**API key**, the path for a user's own automations: an `Authorization: Bearer`
header carrying a `fact_live_` or `fact_test_` key. The prefix selects the
environment, so a sandbox key exercises the same server against sandbox data.

Both credentials resolve to a company and a scope set, and every call is rate
limited per credential and per company plan, and audited.

## Procedure

A person executes this. No code in this repository can.

**Who:** someone with access to `info@factuarea.com` and to the Factuarea
GitHub organisation, authorised to speak for Factuarea to a third party.

**Step 1. Establish the submission channel.**

Measured on 2026-09-02: n8n documents the registry in two places — the MCP Client
Tool node page and the MCP servers page — and neither publishes a submission
form, a repository, a set of required fields or a contact address for third
parties wanting to be listed. The MCP servers page says only that "the list of
registry servers changes often" and to browse the current list in the node panel.

So the first step is to ask, not to submit. Open a thread on the n8n community
forum, or an issue on the n8n GitHub repository, citing both documentation pages,
stating that Factuarea operates a public MCP server and asking what the listing
process is. Attach the payload below so the request is actionable on first
contact. Then follow whatever process they name — this document's procedure is
superseded by their answer the moment there is one.

**Step 2. Check the server before pointing anyone at it.**

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://mcp.factuarea.com
curl -s https://mcp.factuarea.com/.well-known/oauth-authorization-server | head
curl -s https://mcp.factuarea.com/.well-known/oauth-protected-resource | head
```

The two discovery documents must resolve and be well-formed JSON. A registry
that validates the entry will fetch them, and a listing that points at a broken
discovery document is worse than no listing.

**Step 3. Send the payload.**

```
Name:            Factuarea
Publisher:       Factuarea
Server URL:      https://mcp.factuarea.com
Transport:       Streamable HTTP (JSON-RPC 2.0; POST, GET stream, DELETE session)
Protocol:        MCP revision 2026-07-28
Auth:            OAuth 2.1 with dynamic client registration (RFC 7591),
                 discovery at /.well-known/oauth-authorization-server (RFC 8414)
                 and /.well-known/oauth-protected-resource (RFC 9728);
                 alternatively an API key as Authorization: Bearer fact_live_...
                 or fact_test_... for sandbox
Tools:           436 public tools
Category:        Invoicing, accounting, finance (Spain), e-invoicing, VeriFactu
Docs:            https://docs.factuarea.com/mcp/connect
Tool catalogue:  https://docs.factuarea.com/mcp/tools
Scopes:          https://docs.factuarea.com/mcp/scopes
Home page:       https://factuarea.com
Contact:         info@factuarea.com
```

If the process asks for fields not listed here, do not invent values: measure
them in the monorepo, add them to the table above with the file they came from,
and then send them.

**Step 4. Record the outcome** in the Decision section at the top of this file.

**Step 5. Verify.** Once listed, open a fresh n8n instance, add an MCP Client
Tool node and confirm that Factuarea appears in the node panel and connects
without a manually entered URL.

## Why this is not closed inside the change that wrote this document

Because it is not code. Listing a service in a registry operated by another
company is an administrative request: someone at n8n reads it, decides, and acts
on their own timeline. There is no API to call and no file to commit that makes
it true.

What a change can deliver is what is above: the decision, taken and dated; the
exact data, measured rather than recalled; a procedure a person can execute
without rediscovering any of it; and a place for the outcome to be recorded. What
it cannot deliver is another company's answer. Pretending otherwise would mean
either leaving the task open forever or marking it done while nothing was
submitted.

## The "wait for the protocol migration" argument, and why it is rejected

One could argue for delaying the listing until the Factuarea MCP server has
migrated to the current protocol revision, on the grounds that listing a server
and then changing its protocol would waste the reviewer's time and possibly the
listing.

**That argument does not apply, and it is rejected in writing so nobody
reconstructs it later.**

Measured on 2026-09-02 in the epic manifest: the change that performs that
migration, `mcp-protocol-2026-migration`, declares `depends_on: []` — it is a
level-0 root of the dependency graph, waiting on nothing — and its recorded state
is `applied`. The migration is not pending; it is done. The server admits exactly
one protocol revision, `2026-07-28`, and that is the revision in the payload
above.

There is therefore nothing to wait for. Delaying the listing would postpone the
benefit without removing any risk.
