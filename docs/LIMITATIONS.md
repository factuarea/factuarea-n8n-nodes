# Limitations

What this node cannot do, why, and what to do instead. Everything here was
measured against the Factuarea platform on 2026-09-02, not assumed. Each section
names the file that decides the behaviour, so the claim can be re-checked rather
than trusted.

There are four limitations that will change how you build. Read the first one
before you install: it decides whether the node can work for you at all.

---

## 1. Factuarea delivers only to public HTTPS addresses

**A self-hosted n8n reachable only from an internal network never receives a
delivery.**

Two independent checks produce this, and neither can be switched off from n8n:

**At registration.** The destination URL must start with `https://`. The rule is
`regex:/^https:\/\//i` on the `url` field of `POST /v1/webhook_endpoints`
(`CreateWebhookEndpointRequest`). A `http://` address is refused when the
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

`POST /v1/webhook_endpoints` returns the plaintext `secret` in its response, and
that is the only time it exists outside Factuarea. Reading a destination back
with `GET /v1/webhook_endpoints/{id}` returns eighteen fields and `secret` is not
among them.

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
