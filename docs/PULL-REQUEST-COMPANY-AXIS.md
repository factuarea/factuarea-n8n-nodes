# Pull request: the company axis

This file is the review note for the branch that moves this package onto the
company axis of the Factuarea public API. It is written down rather than typed
into a pull request box so that the description survives the branch, and so that
the one step nobody may take by accident — publishing — is stated where a
reviewer reads it.

Copy it into the pull request body when you open it.

---

## Branch

| | |
| --- | --- |
| **Branch** | `feat/epic-nif-axis-api` |
| **Branched from** | `main` |
| **Target** | `main`, once the API change it follows is live |
| **Published** | nothing. No tag, no npm version, no release |

The branch starts at `main` and carries nothing else: this repository has no
`develop`, and the only change on it is the move onto the company axis.

## What changes, and why it is breaking

Every webhook route of the public API now carries the company in its path, and
the resource is spelled with a hyphen:

```
POST   /v1/companies/{company}/webhook-endpoints
GET    /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}
DELETE /v1/companies/{company}/webhook-endpoints/{webhook_endpoint}
```

The forms this package used, `/v1/webhook_endpoints` and
`/v1/webhook_endpoints/{id}`, answer `404`. Factuarea used to resolve the company
from the API key; it does not any more. So the node gains a **Company ID**
parameter, the credential gains an optional **Default Company ID**, and the
lifecycle refuses to activate when neither is filled rather than choosing one.

`GET /v1/event-catalog` is unchanged and must stay unchanged: it is a root route,
identical for every company.

**The published version 0.1.2 is broken against the live API from the moment the
API change ships until a new version is published.** That window is the reason
this branch exists, and it is not closed by merging: it is closed by the release
step below, which is deliberately not performed here.

## What to check in review

1. The three paths above are built with the company segment in front and a
   hyphen in the resource, and no file builds `webhook_endpoints` any more.
   `test/factuareaApiClient.test.ts` pins the three as literals.
2. The event catalogue is still built on the root, in the client, in
   `loadEventOptions.ts` and in the credential test. Three tests pin it.
3. The base URL of the credential still ends at the version segment. A company
   pasted in there breaks the catalogue and the credential test.
4. The company is read from the node parameter first and from the credential
   second, and from nowhere else. No code path picks a company on its own.
5. `npm run build && npm test`, `npm run lint:english` and `npm run lint:package`
   are green.

## Releasing, described and NOT performed

Publishing is an external, irreversible action. Nothing in this branch does it,
and nobody should do it as part of merging.

The step, when the owner decides to take it:

1. Bump `version` in `package.json`. This is a breaking change for anyone whose
   workflows run the published node, so it is `0.2.0` rather than a patch.
2. Move the `Unreleased — the company axis` section of `CHANGELOG.md` under that
   version number, with its date.
3. Merge to `main`.
4. Tag the merge commit `v0.2.0` and push the tag. `.github/workflows/release.yml`
   triggers on `v*` and publishes to npm with Trusted Publishing and provenance.
   `docs/RELEASING.md` holds the preconditions, including the one manual setting
   on npmjs.com without which every publish fails.
5. Check that the published version installs in n8n and that a workflow with a
   Company ID activates against the live API.

Until step 4 runs there is no new version on npm, and `npm run scan` — the
official community-package analyser — reads the PUBLISHED package, so it cannot
report on this branch.
