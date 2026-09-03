# Verifying a Factuarea delivery signature

Everything needed to verify a Factuarea webhook delivery **without this
package**: the headers, the signed material, the algorithm, the multi-candidate
header format used during secret rotation, the timestamp check and the
comparison rules. Reimplement it in any language from this document alone.

The same procedure is documented by Factuarea at
<https://docs.factuarea.com/guides/webhooks>.

If you are already using the node, you do not need any of this: the node does it
for you. This is for the case where you receive deliveries with n8n's generic
Webhook node, or with your own service.

---

## 1. The headers on a delivery

Every delivery carries these five headers. HTTP header names are
case-insensitive, so lowercase them before looking them up in a runtime that
normalises incoming headers.

| Header | Contents |
| --- | --- |
| `Factuarea-Signature` | `t=<unix>,v1=<hex>` with **one or more** `v1=` values. The subject of this document. |
| `Factuarea-Event-Id` | UUID v7 of the event. **Stable across retries**, so it is the deduplication key. |
| `Factuarea-Event-Type` | Event name, `<category>.<action>`, for example `invoice.paid`. |
| `Factuarea-Delivery-Id` | UUID v7 of this particular delivery attempt. **Changes on every retry.** |
| `Idempotency-Key` | Equal to `Factuarea-Event-Id`, sent so generic receivers can deduplicate with a header their stack may already understand. |

If you are using the trigger node rather than verifying by hand, it surfaces
`Factuarea-Delivery-Id` on the item it produces, as a top-level `delivery_id`
field next to the event body.

## 2. The signature header format

The value of `Factuarea-Signature` is a comma-separated list of `key=value`
pairs:

```http
Factuarea-Signature: t=1767225600,v1=46b271035ac53309422bb698a1ff9a13309b0b5e5e1c30b5a16a9504bdf30b82
```

and, during a secret rotation:

```http
Factuarea-Signature: t=1767226200,v1=<signed with the current secret>,v1=<signed with the previous secret>
```

Rules:

- There is exactly **one** `t=`.
- There is **one or more** `v1=`. Never assume there is exactly one.
- **Ignore pairs you do not recognise.** A future version of the emitter may add
  a field. Treating an unknown pair as an error breaks your receiver on the day
  Factuarea adds one; ignoring it costs nothing.
- Take the timestamp from `t=`, **never from your own clock**. The signature is
  computed over the value in the header, so a locally generated timestamp
  produces a signature that never matches.

## 3. The signed material

```
signedPayload = <t> + "." + <raw body>
signature     = HMAC-SHA256(signedPayload, secret)   rendered as lowercase hex
```

Three details that are the whole difficulty:

**`<t>` is the decimal timestamp exactly as it appears in the header**, not a
reformatted or re-parsed one. Concatenate the digits.

**The separator is a single ASCII dot.**

**`<raw body>` is the bytes that arrived on the wire.** Not the parsed object,
not a re-serialisation of it. See section 5.

## 4. The algorithm

1. Read `Factuarea-Signature`. If it is missing or empty, reject.
2. Split it on `,`, then split each part on the first `=`. Collect the single
   `t` value and every `v1` value. If there is no `t`, or `t` is not a base-10
   integer, or there is no `v1`, reject.
3. Check the timestamp: reject unless `|now - t| <= tolerance`, with `now` and
   `t` both in **seconds**. See section 6.
4. Compute `expected = HMAC-SHA256(t + "." + rawBody, secret)` as lowercase hex.
5. Discard every candidate whose length is not **64 characters** (the length of a
   SHA-256 digest in hex). See section 7 for why this filter is mandatory and why
   it leaks nothing.
6. Compare `expected` against **every remaining candidate** using a
   constant-time comparison, accumulating the result **without short-circuiting**.
   Accept if any of them matched.
7. If no candidate matched, reject.

Answer `401` on rejection and `2xx` on acceptance. Factuarea treats a 4xx as a
**permanent** failure and stops retrying, which is correct for a signature that
does not match: retrying will not make it match. It retries a 5xx with
exponential back-off, which is correct for a transient failure on your side.

## 5. Re-serialising the body invalidates every signature

The emitter signs the exact JSON string it puts on the wire, produced with
unescaped forward slashes. Parsing that JSON and serialising the resulting object
again changes separators, key escaping and slash escaping. A body that is
byte-for-byte legitimate then produces a signature that never matches.

The failure mode is silent and total: the receiver rejects 100% of deliveries and
nothing in the rejection explains why. It is the single most common way to get
this wrong.

So: capture the raw body **before** any JSON middleware touches it.

- Express: `express.raw({ type: 'application/json' })` on that route, then
  `req.body.toString('utf8')`.
- PHP: `file_get_contents('php://input')`.
- Flask: `request.get_data()`, not `request.get_json()`.
- n8n generic Webhook node: configure the node to hand you the raw body.

If your runtime cannot give you the raw body, **fail loudly**. Do not rebuild it.

## 6. The timestamp check

```
accept if |now - t| <= toleranceSeconds
```

- Both values are in **seconds**. A common bug is comparing a millisecond clock
  against a second timestamp, which rejects everything.
- The check is **bidirectional**, and that matters. A receiver clock running
  *ahead* of the emitter reopens exactly the replay window the check exists to
  close, and clock skew is this check's real-world failure mode. Checking only
  `now - t <= tolerance` is not enough.
- The default tolerance is **300 seconds**, the window Factuarea documents. This
  node exposes it as a parameter with a range of 30 to 3600 seconds.
- A tolerance below the real clock difference between the two machines rejects
  every delivery, and the rejection is indistinguishable from a wrong secret. If
  correctly signed deliveries are being rejected, check the clocks before you
  suspect the secret.

## 7. Constant-time comparison, over all candidates

Two rules, and both have a reason.

**Compare in constant time.** A byte-by-byte comparison that returns early leaks
how many leading characters of the expected digest the attacker got right, which
turns forging a signature into a per-character search. Use the primitive your
platform provides: `crypto.timingSafeEqual` in Node.js, `hash_equals` in PHP,
`hmac.compare_digest` in Python, `subtle.ConstantTimeCompare` in Go.

**Filter by length first.** `crypto.timingSafeEqual` (and its equivalents)
**throws** when the two buffers differ in length, so a malformed candidate would
crash the handler rather than being rejected. Discard anything that is not 64
hex characters *before* comparing. This filter leaks nothing: the length of a
SHA-256 hex digest is public, constant, and the same for every secret.

**Evaluate every candidate, without short-circuiting.** During a rotation the
header carries two candidates, and the one that matches may be the second. A
verifier that stops at the first candidate rejects legitimate deliveries for the
entire rotation window. Beyond correctness, accumulating the result instead of
returning on the first match keeps the number of comparisons independent of which
candidate matched.

It is worth distinguishing two rejection causes when you report them:

- **No candidate survived the length filter.** Points at a malformed header, or
  at a header format this code does not know.
- **Candidates were compared and none matched.** Points at a wrong secret, or at
  a secret rotated without this receiver being told.

## 8. Secret rotation

Factuarea returns a destination's plaintext secret **exactly once**, in the
response to `POST /v1/webhook_endpoints`. Reading the destination back never
returns it.

When a secret is rotated, Factuarea signs each delivery with **both** the new and
the previous secret for a **24-hour grace window**, so a correctly written
verifier that evaluates every candidate never drops a delivery during a rotation.

Two practical consequences:

- Store the secret at creation time. There is no second chance to obtain it.
- If you hold only one of the two secrets, you are still fine during the window
  as long as you evaluate all candidates. After the window, only the current
  secret verifies.

## 9. A worked example

Verified against the emitter. The secret is a synthetic fixture that never
existed in any environment.

```
secret    = whsec_3f8a1c9b2e7d4a6f0b5c8e1d2a3f4b6c
timestamp = 1767225600
raw body  = {"id":"0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0e","type":"invoice.paid","api_version":"2026-01-01","created":1767225600,"livemode":true,"test":false,"correlation_id":null,"data":{"invoice":{"id":"0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0f","number":"F2026-0001","total":"121.00"}}}
```

Signed material (the timestamp, a dot, then the raw body):

```
1767225600.{"id":"0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0e","type":"invoice.paid",...}
```

Expected header:

```http
Factuarea-Signature: t=1767225600,v1=46b271035ac53309422bb698a1ff9a13309b0b5e5e1c30b5a16a9504bdf30b82
```

Reproduce it from a shell:

```bash
node -e 'const {createHmac} = require("node:crypto");
const secret = "whsec_3f8a1c9b2e7d4a6f0b5c8e1d2a3f4b6c";
const t = 1767225600;
const body = process.argv[1];
console.log(createHmac("sha256", secret).update(t + "." + body).digest("hex"));' \
  '{"id":"0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0e","type":"invoice.paid","api_version":"2026-01-01","created":1767225600,"livemode":true,"test":false,"correlation_id":null,"data":{"invoice":{"id":"0198f3c2-7a41-7c3e-9d2b-5f6a1b8c4d0f","number":"F2026-0001","total":"121.00"}}}'
```

More vectors, including a tampered signature, a rotation in which the **second**
candidate is the one that matches, and a body whose re-serialisation produces
different bytes, are in
[`test/vectors/signature-vectors.json`](../test/vectors/signature-vectors.json).
Use them as a conformance suite for your own implementation. The last one is the
important one: an implementation that re-serialises the body passes every other
vector and fails only that one.

## 10. Reference implementation

Node.js, no dependencies, deliberately close to the algorithm above.

```js
const { createHmac, timingSafeEqual } = require('node:crypto');

const HEX_DIGEST_LENGTH = 64;

function parseSignatureHeader(header) {
  if (typeof header !== 'string' || header.trim() === '') return null;

  let timestamp = null;
  const signatures = [];

  for (const pair of header.split(',')) {
    const index = pair.indexOf('=');
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      signatures.push(value);
    }
    // Any other key is ignored on purpose.
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function verify(rawBody, header, secret, { now, toleranceSeconds = 300 } = {}) {
  const parsed = parseSignatureHeader(header);
  if (parsed === null) return false;

  const currentTime = now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(currentTime - parsed.timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');
  // `latin1`, never `utf8`, on BOTH sides. The filter below counts CHARACTERS
  // and timingSafeEqual compares BYTES, and only latin1 makes the two the same
  // number: one non-ASCII character inside a 64-character candidate encodes to
  // 65 bytes under utf8, so it passes the filter and then makes timingSafeEqual
  // throw — the very crash the filter exists to prevent, reachable by anyone who
  // can send a header. A candidate that is not hex simply fails to match.
  const expectedBuffer = Buffer.from(expected, 'latin1');

  // Length filter FIRST: timingSafeEqual throws on a length mismatch.
  const candidates = parsed.signatures.filter(
    (candidate) => candidate.length === HEX_DIGEST_LENGTH,
  );
  if (candidates.length === 0) return false;

  // Every candidate is evaluated. No short circuit, so the work done does not
  // depend on which one matches, and a rotation window never drops a delivery.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(expectedBuffer, Buffer.from(candidate, 'latin1'))) {
      matched = true;
    }
  }

  return matched;
}
```

Wiring it into Express, with the raw body preserved:

```js
app.post(
  '/factuarea/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const rawBody = req.body.toString('utf8');

    if (!verify(rawBody, req.header('Factuarea-Signature'), SECRET)) {
      return res.status(401).end();
    }

    const event = JSON.parse(rawBody);
    handle(event);      // deduplicate on event.id before doing anything
    return res.status(200).end();
  },
);
```

## 11. After the signature verifies: deduplicate

Verification is not the end. Factuarea retries a delivery until it is
acknowledged, on an escalating schedule that spans days, so the same event will
reach you more than once.

Deduplicate on **`id` in the body**. It is a UUID v7, it is **stable across
retries**, and — the part that matters — it is inside the material the signature
covers, so by the time you read it you have proved Factuarea sent it.

`Factuarea-Event-Id` carries the same value, and so does `Idempotency-Key`, but
**both are headers and no header is signed**: the signed material is
`<timestamp>.<raw body>` and nothing else. Keying your memory on a header lets
anyone who cannot forge a body still choose which events you suppress — they
POST an unsigned request carrying the id of an event they want dropped, your
store remembers it, and the genuine delivery that follows is discarded as a
duplicate. That is a denial of service needing no secret and leaving no trace
beyond a `200`. It is also why the trigger node deduplicates AFTER verifying,
and on the body.

`Factuarea-Delivery-Id` is the wrong key for a different reason: it changes on
every attempt, so it deduplicates nothing. Inside the trigger node the two
values arrive on the item as `id` and `delivery_id`.

Answer a duplicate with `200` and do nothing else. Answering with an error would
tell Factuarea the delivery failed and produce more retries of an event you have
already handled.
