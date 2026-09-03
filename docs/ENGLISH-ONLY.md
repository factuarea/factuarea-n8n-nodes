# Why this repository is written in English

Factuarea writes user-facing text in Spanish. Its application ships every string
through a translation function with parity across three locales, and a gate in
its continuous integration fails on a user-facing string that is missing from any
of them.

**This repository is the declared exception.** Everything here is in English:
the node name, its parameter labels, descriptions and hints, every error message,
this documentation and the changelog.

The exception is written down rather than assumed, and it is bounded rather than
general. Both of those are the point of this document.

## The reason

n8n's user base and its documentation are in English, and its community-node
verification is conducted in English. A node whose interface is in Spanish is not
a node that fails a rule and gets fixed later; it is a node that does not get
verified. Without verification there is no presence on n8n Cloud, which is where
the users this package exists for actually run their workflows.

A dual-language node was considered and rejected. n8n has no localisation
mechanism for community nodes: a description is one string, shown to everyone. A
node carrying both languages in every field would be twice as long and worse in
both.

## The scope

The exception covers **sibling package repositories only** — packages published
into a third-party marketplace whose review and audience are in English:

| Repository | Package |
| --- | --- |
| `factuarea-n8n-nodes` (this one) | The n8n trigger node. |
| The WooCommerce plugin repository | The WordPress plugin, published to wordpress.org. |
| The Shopify app repository | The public Shopify app. |

It covers **nothing else**. In particular:

- The Factuarea monorepo keeps Spanish, with parity across its three locales and
  the gates that enforce it. This exception is not a precedent for a single
  English string in the backend or in the web application.
- The Factuarea documentation portal keeps its three-language editions.
- Nothing in this repository may be copied into the monorepo on the grounds that
  "the n8n package does it this way".

If you are here because you want to write an English string in the monorepo, this
document is the reason you may not.

## What "user-facing" means here

Everything a person can read that this package authored:

- Node and credential display names.
- Parameter names, descriptions, hints and placeholder values.
- Every message in `src/errors.ts`.
- `README.md`, `CHANGELOG.md` and everything under `docs/`.
- Code comments, which are read by anyone maintaining this package.

**Data returned by the Factuarea API is not covered**, and cannot be. The event
catalogue, for example, returns descriptions written in Spanish. The node
displays them as data. What is forbidden is copying such a value into a string
this package authors: an error message, a label, a description. A message the
package writes is the package's own text, whatever it was built from.

## The gate

```bash
npm run lint:english
```

runs `scripts/check-english-only.mjs` over `src`, `docs`, `README.md` and
`CHANGELOG.md`. It extracts the strings and text this package authors and fails
on unmistakable markers of Spanish, naming the file, the line and the string it
found. It is part of `npm run verify`, so it runs in continuous integration and
before every release.

**Adding an exception requires a reason.** Entries in the checker's exception
list are keyed by their reason, so an entry without one does not exist. This is
the same shape every allowlist in the Factuarea codebase uses, for the same
purpose: an exception whose justification was never written down cannot be
reviewed later, and becomes permanent by accident.

Legitimate exceptions are proper nouns and Spanish fiscal terms that have no
English equivalent and must not be translated: `Factuarea`, `VeriFactu`, `NIF`,
`AEAT`. Keep the list short. A growing exception list is the failure mode this
gate exists to make visible.

### Two deliberate properties of the gate

**It does not scan `test/`.** The checker's own fixtures contain Spanish on
purpose: that is what proves the gate fires. Scanning the test tree would make
the gate fail on itself, and the natural "fix" would be to weaken it.

**It detects Spanish, not "not English".** The checker looks for inverted
punctuation marks, accented vowels and a short list of Spanish function words. It
cannot classify arbitrary languages, and it does not try to. The risk this gate
was built for is the specific and likely one — Spanish leaking in from a
codebase written in Spanish — not French or German arriving from nowhere.

## Copying this gate to the other sibling repositories

`scripts/check-english-only.mjs` is deliberately **portable**: pure Node with no
dependencies, no imports from this package, and no assumption about the language
of the files it reads. It is meant to be copied, not published as a shared
library, because a shared library would be a runtime dependency in a package that
must have none, and because the other two repositories are written in other
languages.

To adopt it in the WooCommerce plugin repository or in the Shopify app
repository:

1. Copy `scripts/check-english-only.mjs` unchanged.
2. Add a script that runs it over that repository's own paths, for example:

   ```json
   "lint:english": "node scripts/check-english-only.mjs src docs README.md"
   ```

3. Chain it into that repository's verification script and into its continuous
   integration, so it runs on every change rather than on request.
4. Start its exception list empty. Do not copy this repository's entries: they
   are justified by strings that exist here, and an exception copied without its
   string is an exception nobody can evaluate.
5. Copy this document too, adjusting the scope table. The reason for the
   exception has to live in the repository that takes it.

Keeping the checker identical across the three repositories is the point: three
hand-written versions would drift into three different definitions of "Spanish",
and the one that drifted loosest would be the one nobody noticed.
