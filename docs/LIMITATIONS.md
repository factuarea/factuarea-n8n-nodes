# Limitations

What this node cannot do, why, and what to do instead. Everything here was
measured against the Factuarea platform on 2026-09-02, not assumed. Each section
names the file that decides the behaviour, so the claim can be re-checked rather
than trusted.

There are four limitations that will change how you build. Read the first one
before you install: it decides whether the node can work for you at all. Account
mode adds five more, in the section after number 4.

---

## 1. Factuarea delivers only to public HTTPS addresses

**A self-hosted n8n reachable only from an internal network never receives a
delivery.**

Two independent checks produce this, and neither can be switched off from n8n:

**At registration.** The destination URL must start with `https://`. The rule is
`regex:/^https:\/\//i` on the `url` field of
`POST /v1/companies/{company}/webhook-endpoints` (`CreateWebhookEndpointRequest`). A `http://` address is refused when the
trigger tries to register it, and the workflow fails to activate with a message
naming the cause.

**At delivery.** Factuarea's outbound HTTP client refuses any destination that
resolves to a non-public address, and the refusal is checked again on every
delivery rather than once at registration, so a hostname that resolves publicly
today and privately tomorrow is refused tomorrow. The platform default is
`allow_private_targets = false` (`config/egress.php`), and the refused ranges
are RFC 1918, loopback, link-local, CGNAT, IPv6 ULA, multicast and reserved.

A refused delivery is marked **failed permanently, with no retry**
(`DeliverWebhookCommandHandler`). That is deliberate: retrying against the same
host would only confirm the refusal and would turn the retry schedule into an
indirect port scanner. It also means there is no queue waiting for you to fix
the network later. Events recorded while the destination was unreachable are
visible in Factuarea, and can be replayed by hand, but they do not arrive on
their own once you expose the instance.

### What this looks like when it happens

The workflow activates. The destination is registered. Events are recorded in
Factuarea. Nothing arrives, and n8n reports nothing, because from n8n's point of
view no request was ever made. The evidence is in Factuarea, under **Settings >
Developers > Webhooks**, where the deliveries of that destination are listed as
permanently failed.

### The remedy

- Expose the n8n instance on a public HTTPS address: a reverse proxy with a
  valid certificate, or a tunnel such as Cloudflare Tunnel or ngrok.
- Or run the workflow on n8n Cloud.

Then deactivate and activate the workflow so the trigger registers a destination
with the new address.

### One honest footnote about the per-company allowlist

Factuarea does have a per-company egress allowlist, in which a company can be
granted specific non-public hosts for a specific purpose, revalidated on every
outbound call. Two measured facts stop it from being an answer here:

- Its purpose catalogue declares `outbound_webhook`, but **no call site passes
  it**: the webhook delivery path does not consult the allowlist at all today.
  The declaration is documented in the platform as forward-looking, not as a
  wired feature.
- There is no self-service surface to add a host to it. No public API route and
  no dashboard screen writes to that table.

So for this node, in this version, the restriction is total. Treat a public
HTTPS address as the only remedy.

---

## 2. Rotating the webhook secret outside n8n breaks the trigger

**The trigger owns its webhook destination and cannot adopt one it did not
create, because Factuarea returns a signing secret exactly once.**

`POST /v1/companies/{company}/webhook-endpoints` returns the plaintext `secret`
in its response, and that is the only time it exists outside Factuarea. Reading a
destination back with
`GET /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}` returns
eighteen fields and `secret` is not among them.

Consequences:

- The trigger **creates** its own destination on activation and stores the
  secret in the node's own state. It never attaches to a destination that
  already exists, because it could not verify a single delivery from it.
- If you rotate the secret from the Factuarea dashboard, from the API or from
  the CLI, the new secret goes to whoever made that call. The trigger keeps the
  old one and has no way to fetch the new one.

Factuarea softens the fall with a **24-hour dual-signing grace window**
(`WebhookEndpoint::SECRET_GRACE_WINDOW_SECONDS`): while the previous secret is
still inside its window, every delivery carries **two** `v1=` candidates, one per
active secret. This node evaluates all candidates, so deliveries keep arriving
during those 24 hours. When the window closes, the trigger starts rejecting
every delivery with `401`, and Factuarea treats each rejection as permanent.

### What this looks like when it happens

A delivery arrives whose timestamp is inside tolerance but whose signature
matches no candidate. That combination has essentially one cause, so the node
writes this to the **n8n log**, at warning level, once per refused delivery:

> A delivery arrived with a valid timestamp but a signature this trigger could
> not match. The most likely cause is that the webhook secret was rotated
> outside n8n: Factuarea only returns a secret when the destination is created,
> so this trigger cannot pick up a new one by itself. Deactivate and activate
> this workflow to register a fresh destination, then send the event again.

**The log is where to look for it, and the only place.** The delivery itself is
answered with an empty `401` that says nothing about which check refused, and
that silence is deliberate: the caller of a rejected delivery is unauthenticated
by definition, and telling it that the timestamp was accepted but the digest was
not would hand a forger an oracle. No item reaches the workflow either, so there
is no execution to open. When deliveries stop arriving and the workflow looks
idle, read the instance log.

Only this one refusal is logged. A signature header that cannot be parsed is a
probe or a proxy rather than a rotation, and logging those would let anyone fill
the log by POSTing rubbish at a URL that is public by construction.

### The remedy

Deactivate and activate the workflow. Deactivation deletes the stale
destination, activation creates a new one with a new secret.

### How to avoid it

Do not rotate the secret of a destination that an n8n trigger created. Rotate
the secrets of destinations your own services own instead. If you are unsure
which destination belongs to which consumer, check its URL in **Settings >
Developers > Webhooks**: a destination created by this node points at the
webhook path of the n8n instance that owns the workflow.

---

## 3. Deduplication is a guarantee of the active workflow, not of a test run

**Skip Repeated Events** remembers the identifiers of events it has already
processed and answers a repeat with `200` without producing a second item. Three
bounds on that promise:

**It is bounded in size.** The store holds the last **1000** event identifiers
and evicts the oldest first (`DEDUPE_CAPACITY` in `src/contract.ts`). That is far
more than Factuarea's retry schedule can produce for a single event, but it is
not infinite: an event whose retries span longer than 1000 other events on a
very busy instance could be seen twice.

**It belongs to the node's own state.** n8n persists that state for an
**activated** workflow. A manual execution from the editor does not necessarily
share it, so a manual test can produce an item for an event an activated run
already handled. Do not use a manual execution to prove that deduplication
works.

**It is per node, not per account.** Two workflows subscribed to the same event
each get their own item. That is intended, but it means deduplication does not
protect you from having built two triggers for the same thing.

Turning **Skip Repeated Events** off is a real choice, not a debug switch:
Factuarea retries a delivery until it is acknowledged, on an escalating schedule
that spans days, so the same event does arrive more than once. With the option
off, the workflow runs again for every retry, and whatever the workflow does
happens again with it.

If you turn it off and deduplicate yourself, key on `id` and not on
`delivery_id`. Both arrive on the item: `id` is the event, stable across every
retry, and `delivery_id` is the attempt, different on each one. Keying on
`delivery_id` deduplicates nothing, because no two deliveries ever share it.

---

## 4. Factuarea suspends a destination that keeps failing, and it does not resume on its own

**After 100 deliveries fail permanently within 24 hours, Factuarea marks the
destination `degraded` and stops delivering to it. Bringing n8n back does not
bring the deliveries back.**

The detection is `OnWebhookDeliveryFailedDetectDegraded`: on every permanent
failure it counts the destination's permanent failures of the last 24 hours and,
at **100** (`DEGRADED_THRESHOLD_24H`), dispatches `MarkEndpointDegradedCommand`
and emails the destination's owner. From then on `DeliverWebhookCommandHandler`
drops the delivery of any destination whose status is not `active` — the check is
`$endpoint->status()->isActive()`, before anything is sent. A destination can also
sit at `disabled`, which behaves the same way.

The threshold is easier to reach than it sounds. Section 1 explains that a
delivery to an unreachable address fails **permanently**, with no retry, so an
instance that is down, moved or behind a broken tunnel burns one permanent
failure per event. A busy account produces a hundred of those in an afternoon.

### What this looks like when it happens

Nothing, on the n8n side — which is the point. The destination still exists and
still reads back through the API with all eighteen of its fields; only its
`status` changed. A trigger that asked "does my destination still exist" would
get `true`, activate happily, and receive nothing for ever.

This node asks the fuller question, so an activation of a workflow whose
destination is suspended **fails with the cause named** instead of appearing to
succeed:

> The webhook destination this trigger registered still exists in Factuarea but
> is no longer active, so Factuarea has stopped delivering events to it. […]
> Deactivate and activate this workflow: deactivating removes the suspended
> destination and activating registers a fresh one.

The same check catches the other way a destination goes quiet while looking
healthy: the **public URL of the n8n instance changed** — a new domain, a new
tunnel — and the destination still points at the old address.

### The remedy

Deactivate and activate the workflow. Deactivating deletes the suspended
destination, activating registers a new one, which starts `active`.

Do not work around it by leaving the workflow deactivated and re-activating
repeatedly: an activation that cannot delete the old destination first leaves it
behind, and the account's destination limit is what you would hit next.

### How to avoid it

If the instance is going to be unreachable for a while — maintenance, a move, a
holiday for a machine under a desk — **deactivate the workflow first**. A
deactivated workflow has no destination in Factuarea, so nothing fails, nothing
counts towards the threshold, and the events are still recorded in Factuarea for
you to replay by hand.

---

## Account mode: five more limitations

These apply only when **Listen On** is **Account**. Company mode is not affected
by any of them. The codes below are the `error.code` of the Factuarea API, as
catalogued by the platform; the node turns each into its own message, so you read
the cause in n8n instead of a generic failure.

### A1. Account mode works only with a live key (`fact_live_`)

**An account webhook is created and removed only with a production key.** A test
key, `fact_test_`, cannot write one, and in Account mode the node refuses it
**before sending any request**, with the message that asks for a live key. The platform refuses it with
**403 `live_credential_required`** where the credential guard answers
(`AccountCapabilityCredentialGuard::ensureWrite`), and the node has a catalogued
message for that code asking for a live key.

**One measured detail you should know.** On the REST route this node uses, the
guard is not the first thing a test key meets. The API checks the permission
first, and a test key is not issued the `webhooks:write` permission at all: it
gets a **403 `insufficient_scope`**, or **403 `module_not_available_in_sandbox`**
if it somehow carries the permission. The controller that serves
`POST /v1/accounts/{account}/webhooks` documents exactly that order
(`CreateAccountWebhookController.php:30-36` in the Factuarea backend), and
`live_credential_required` is the code of the same guard when it is reached
through the MCP channel. The node does not leave you to decode that: a key that
starts with `fact_test_` is refused up front, and a `module_not_available_in_sandbox`
(or `live_credential_required`) answer from the API is turned into the same
live-key message. A plain **403 `insufficient_scope`** from a live key stays the
missing-scope message, because there the cause really is a missing permission.
Whichever code you see, the cause and the remedy are the same: put a live key in
the credential.

Related and different, **403 `forbidden_action`**: the key is live, but the user
who issued it is no longer an owner or an admin of the account, or the key does
not cover all of the account's tax ids. The remedy is a new key issued by such a
user. If that happens *after* the endpoint exists, Factuarea does not reject
anything: it **disables the endpoint** (`status: disabled`,
`disabled_reason: creator_lost_capability`) and stops delivering. The node reports
that state when the workflow is activated again.

### A2. Test endpoints can be created only from the dashboard

An account endpoint of the test environment can be created only from the
Factuarea dashboard, whose environment toggle decides where it is born. This node
cannot create one, for the reason in A1: the creation is a write, and writes need
a live key. So a test workflow cannot be wired up by activating a trigger. To
exercise a receiver in a sandbox, create the destination in the dashboard and use
the test delivery, as described in *Sandbox keys record events but do not deliver
them* below.

### A3. OAuth is excluded

**There is no OAuth path for account mode.** The credential of this package is an
API key sent as a Bearer token, and the account webhook operations are available
only with an API key: an OAuth connection is not an account credential, because it
has no issuing user whose role can be checked and no key scope over the tax ids of
the account. Where Factuarea serves these operations to OAuth connections, the MCP
channel, it refuses them with **403 `forbidden_action`** (the same code as the
issuer case in A1) before checking anything else
(`AccountCapabilityForbiddenException::oauthChannel()`). For this node that is a
statement about the design, not a failure you can hit: there is no OAuth
credential type to select.

### A4. The `account.*` list is fixed, with no catalogue route, and a test guards it

**The fifteen `account.*` events in the picker are written down in the package,
not read from Factuarea.** The public `GET /v1/event-catalog` never lists them, by
design, and no other route does. So the picker of Account mode offers the live
public catalogue plus the list in
`src/nodes/FactuareaTrigger/accountEventCatalog.ts`, which is the one list of the
package that is not read live.

Two consequences:

- When Factuarea adds an `account.*` event, it does not appear in the picker until
  a new version of this package lists it.
- A selection that includes a name Factuarea does not know is refused at
  activation with **422 `invalid_param_value`**, a status the node cannot tell
  apart from other invalid values.

The risk is bounded by a test. `test/accountEventCatalog.test.ts` compares the
list with `test/vectors/account-event-types.json`, a data file extracted from the
`AccountEventType` schema of the frozen API document, and fails naming the event
that is extra or missing. If the contract changes and the vector is regenerated,
the test shows what to add.

### A5. The number of account endpoints is capped by the plan

**Creating an account endpoint beyond the cap of the payer's plan is refused with
422 `account_webhook_endpoint_limit_reached`.** Account endpoints are counted
apart from company endpoints, per account and per environment, and the cap is the
one of the tier of whoever *pays* for the account, not of the key that creates the
endpoint (`config/public_api_tiers.php`, `max_account_webhook_endpoints`). When
this document was written the caps were 0 for free, 1 for starter, 10 for pro and
50 for scale. Read them as a measurement of that day, not as a promise.

A plan that does not include account webhooks is refused differently:
**402 `addon_required`** (subcode `account_webhooks_addon_required`).

Each activation of a workflow creates one endpoint, and each deactivation removes
it, so a workflow normally holds one slot. When the cap is reached, delete an
account endpoint you no longer use in Factuarea (**Settings > Developers >
Webhooks**) and activate the workflow again.

---

## Other measured constraints worth knowing

These do not change the shape of your workflow, but they explain messages you
may see.

**The event selection is fixed when the destination is created.** Changing the
**Events** field on an active workflow does not change what Factuarea sends. The
change takes effect on the next activation.

**Your account has a limit on webhook destinations.** The limit depends on your
Factuarea tier. When it is reached, the trigger cannot register its destination
and reports that you need to free a slot in **Settings > Developers > Webhooks**.

**The event picker needs the catalogue to be reachable.** The list is read live
on every open. If the request fails, the field stays empty and says so. There is
no built-in fallback list, deliberately: a frozen list would offer events the API
refuses to subscribe to, and would need a new release of this package every time
Factuarea adds one.

**The signature is verified over the raw request body.** If a proxy in front of
n8n rewrites request bodies, every signature becomes invalid. The node fails with
a message naming that cause rather than rebuilding the body from the parsed
payload, because rebuilding it changes bytes and rejects every delivery. See
[SIGNATURE-VERIFICATION.md](SIGNATURE-VERIFICATION.md).

**An activation that times out can leave a destination behind.** The trigger
registers its destination with one `POST`. If that request is answered — with
anything, including a rejection — the node knows where it stands. If it gets no
answer at all, it cannot know: a read timeout fires after the request was sent,
so Factuarea may already have created the destination and answered into a socket
nobody was listening on. The node says so rather than guessing:

> Factuarea did not answer the request to register a webhook destination for this
> workflow, so it is unknown whether the destination was registered […] Open
> Settings, Developers, Webhooks in Factuarea and delete any destination pointing
> at this workflow's URL […]

Do open that screen when you see it. The identifier was never stored, so the node
cannot see or delete that destination, and each activation that ends the same way
leaves another one — until the account reaches its destination limit and the
error you get is about a limit you never knowingly approached.

**Sandbox keys record events but do not deliver them.** Factuarea's public
documentation states that events generated with a sandbox (`fact_test_`) key are
recorded and never delivered to external endpoints, and that the way to exercise
a receiver in sandbox is the dedicated test delivery, which *is* sent. See
<https://docs.factuarea.com/guides/webhooks>.
