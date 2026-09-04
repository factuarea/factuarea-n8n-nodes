# n8n-nodes-factuarea

An n8n **trigger node** for [Factuarea](https://factuarea.com). It starts a
workflow when Factuarea delivers a signed webhook event: an invoice is paid, a
quote is accepted, a store order is invoiced, and so on.

The node registers its own webhook destination in your Factuarea account when
you activate the workflow, verifies the HMAC-SHA256 signature of every delivery
it receives, and removes the destination again when you deactivate the workflow.

This package contains **one trigger node and one credential**. It does not
create, read or modify anything in Factuarea beyond its own webhook destination.
To call the Factuarea API from a workflow, use n8n's HTTP Request node against
the [public API](https://docs.factuarea.com), or the MCP Client Tool node
against `https://mcp.factuarea.com`.

---

## Before you install: Factuarea must be able to reach your n8n

**Read this first. It decides whether the node can work for you at all.**

Factuarea delivers webhooks only to addresses that are:

1. **HTTPS.** A destination URL that does not start with `https://` is rejected
   when the trigger tries to register it.
2. **Reachable on the public internet.** A destination that resolves to a
   private network address (RFC 1918, loopback, link-local, CGNAT, IPv6 ULA) is
   rejected **permanently, with no retry**, at delivery time.

So a self-hosted n8n that is only reachable from an internal network **will
never receive a delivery**. The workflow will activate, the destination will be
registered, events will be recorded in Factuarea, and nothing will ever arrive.

Your options:

- Put the n8n instance behind a public HTTPS address (a reverse proxy with a
  certificate, or a tunnel such as Cloudflare Tunnel or ngrok).
- Or run the workflow on n8n Cloud, which is already publicly addressable.

There is no setting in this node, and no configuration in Factuarea, that lifts
this restriction. See [docs/LIMITATIONS.md](docs/LIMITATIONS.md) for the full
measurement and for the other three limitations you should know about before you
build on this node.

---

## Requirements

- n8n with community nodes enabled.
- Node.js 22 or newer (the `engines` requirement of this package; `n8n-workflow` 2.x pulls in `isolated-vm`, which needs Node 22).
- A Factuarea account with an API key.

## Installation

In your n8n instance:

1. Go to **Settings > Community nodes**.
2. Select **Install a community node**.
3. Enter `n8n-nodes-factuarea` and confirm.

For a self-hosted instance you can install it from the command line instead:

```bash
npm install n8n-nodes-factuarea
```

Restart n8n. **Factuarea Trigger** then appears in the node panel.

## Creating the credential

The node uses one credential type, **Factuarea API**, with two fields:

| Field | What it is |
| --- | --- |
| **API Key** | An API key from Factuarea (**Settings > Developers > API keys**). Stored encrypted by n8n and masked in the editor. |
| **Base URL** | Root of the Factuarea public API including the version segment. Defaults to `https://api.factuarea.com/v1`. Change it only if the key belongs to a different Factuarea environment. |

The key needs four scopes, and the trigger fails with a message naming the
missing permission if any of them is absent:

| Scope | Why the node needs it |
| --- | --- |
| `events:read` | Read the event catalogue that fills the **Events** picker. |
| `webhooks:write` | Register the webhook destination when the workflow is activated. |
| `webhooks:read` | Check that the destination it registered still exists. |
| `webhooks:delete` | Remove the destination when the workflow is deactivated. |

Press **Test** on the credential to check it. The test performs a read-only
`GET /v1/event-catalog`: it creates nothing, and it exercises the same scope the
event picker needs, so a key that passes the test can actually fill the picker.

## Choosing events

The **Events** field is a multi-select that is filled from the **live** Factuarea
event catalogue (`GET /v1/event-catalog`) using the selected credential, and it
offers only the entries the catalogue marks as `available`.

Nothing is hardcoded in the package. Two consequences:

- An event Factuarea has announced but cannot emit yet is **not** offered.
  Subscribing to one would be rejected by the API, so offering it would only
  produce a confusing failure at activation time.
- When Factuarea adds an event, it appears in the picker without you having to
  update this package.

If the catalogue cannot be read, the field stays empty and the node reports that
the list could not be loaded. It does not fall back to a built-in list, because
a stale list would offer events the API refuses.

The selection is sent to Factuarea **when the workflow is activated**. Changing
it later takes effect on the next activation: the destination is created once,
with the events chosen at that moment.

## Node parameters

| Parameter | Default | What it does |
| --- | --- | --- |
| **Events** | none | The Factuarea events that start this workflow. Required. |
| **Timestamp Tolerance (Seconds)** | `300` | How far the timestamp signed into a delivery may sit from this instance clock, in either direction, before the delivery is rejected even though its signature is correct. Range 30 to 3600. |
| **Skip Repeated Events** | `true` | Answer a repeated delivery of an event already processed with success and drop it, instead of producing a second item. |

Raising the tolerance widens the window in which a captured delivery could be
replayed against this workflow. Lowering it below the real clock difference
between your instance and Factuarea rejects every delivery, and that rejection
looks exactly like a wrong secret. Change it only when correctly signed
deliveries are being rejected.

## Example workflow

Send a message to a chat channel whenever an invoice is paid.

1. Add **Factuarea Trigger**. Select your Factuarea API credential.
2. In **Events**, pick `invoice.paid`.
3. Leave **Timestamp Tolerance** at `300` and **Skip Repeated Events** on.
4. Connect a **Slack** (or Discord, or Gmail) node and compose the message from
   the trigger output, for example:

   ```
   Invoice {{ $json.data.invoice.number }} was paid.
   ```

5. **Activate** the workflow. Activation registers the webhook destination in
   Factuarea; deactivation removes it.

To exercise the whole path without waiting for a real event, use Factuarea's
test delivery: **Settings > Developers > Webhooks**, pick the destination the
trigger created, and send a test event. A test delivery arrives with `test:
true` in the body.

## What the trigger emits

One item per accepted delivery. The item carries the event body exactly as
Factuarea published it, with **no key renamed, flattened or dropped** — a
workflow built on these keys keeps working — plus one field of its own,
`delivery_id`:

```json
{
  "id": "0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0e",
  "type": "invoice.paid",
  "api_version": "2026-01-01",
  "created": 1767225600,
  "livemode": true,
  "test": false,
  "correlation_id": null,
  "data": {
    "invoice": { "id": "0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0f" }
  },
  "delivery_id": "0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d10"
}
```

| Key | Meaning |
| --- | --- |
| `id` | UUID v7 of the event. Stable across retries. |
| `type` | Event name, `<category>.<action>`. |
| `api_version` | Contract version the payload was built for, or `null`. |
| `created` | Unix timestamp, in seconds, at which the event was recorded. |
| `livemode` | `false` for events produced by a sandbox company. |
| `test` | `true` when the delivery was triggered as a test from the dashboard. |
| `correlation_id` | Ties the event to the internal chain that produced it, or `null`. |
| `data` | The payload, keyed by resource name. |
| `delivery_id` | UUID v7 of **this delivery attempt**, taken from the `Factuarea-Delivery-Id` header. Added by this node; not part of the event body. |

`delivery_id` is the only field the node adds. It exists so a workflow can tell
a **retry from a new event without inspecting the body**: `id` is stable across
retries of the same event, while `delivery_id` changes on every attempt. Two
items with the same `id` and different `delivery_id` are the same event
delivered twice.

`data` holds a **thin reference** to the affected resource. Fetch the full
representation from its own endpoint when you need more than the identifier.

Two fields are easy to confuse. `livemode` reflects the environment the key
belongs to (live or sandbox). `test` says whether **this particular delivery**
was triggered as a test from the Factuarea dashboard. They are independent:
`livemode: true, test: true` is a valid combination.

## How the trigger answers a delivery

| Situation | HTTP status | Why |
| --- | --- | --- |
| Signature verified, event accepted | `200` | The workflow runs and one item is produced. |
| Repeated event, deduplication on | `200` | Factuarea treats it as delivered and stops retrying. Answering with an error would cause more retries of an event already handled. |
| Signature invalid, or timestamp outside tolerance | `401` | Factuarea treats a 4xx as a permanent failure and does not retry. Retrying would not make a wrong signature right. |
| Internal failure while handling the delivery | `5xx` | Factuarea retries with exponential back-off, which is what a transient failure needs. |

## Verifying the signature yourself

If you would rather receive deliveries with n8n's generic Webhook node, or with
your own service, you can verify the signature without this package.
[docs/SIGNATURE-VERIFICATION.md](docs/SIGNATURE-VERIFICATION.md) describes the
signed material, the algorithm, the multi-candidate header format used during
secret rotation and the constant-time comparison, with a worked example and
golden vectors, in enough detail to reimplement it in any language.

The same procedure is documented by Factuarea at
<https://docs.factuarea.com/guides/webhooks>.

## Documentation in this repository

| Document | Contents |
| --- | --- |
| [docs/LIMITATIONS.md](docs/LIMITATIONS.md) | The four measured limitations of this node and what to do about each. |
| [docs/SIGNATURE-VERIFICATION.md](docs/SIGNATURE-VERIFICATION.md) | The delivery signature, reimplementable without this package. |
| [docs/RELEASING.md](docs/RELEASING.md) | How a version of this package is published, including the manual npm step. |
| [docs/ENGLISH-ONLY.md](docs/ENGLISH-ONLY.md) | Why this repository is written in English while the rest of Factuarea is not. |
| [docs/MCP-REGISTRY.md](docs/MCP-REGISTRY.md) | The decision on listing the Factuarea MCP server in n8n's MCP servers registry. |
| [CHANGELOG.md](CHANGELOG.md) | What each version contains. |

## Support

- Factuarea documentation: <https://docs.factuarea.com>
- Issues with this package: <https://github.com/factuarea/factuarea-n8n-nodes/issues>

## License

[MIT](LICENSE)
