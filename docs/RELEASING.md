# Releasing

`n8n-nodes-factuarea` is published to npm by **GitHub Actions**, authenticated
with **npm Trusted Publishing (OIDC)** and shipped with build **provenance**.
There is no long-lived `NPM_TOKEN` anywhere in this repository, and nobody
publishes from a laptop.

That is not a preference. Since **1 May 2026**, n8n's community-node
verification requires that a verified package be published from GitHub Actions
with npm provenance. A version published by hand cannot be verified.

---

## Read this first: the one manual step

**Trusted Publishing must be configured on npmjs.com before the workflow can
publish anything.** It is a one-time, manual action by a human with owner rights
on the npm package. No code in this repository can do it, and until it is done
every publish attempt fails.

On <https://www.npmjs.com>, signed in as the account that owns the package:

1. Open the package page, then **Settings** (also reachable as **Publishing
   access** / **Trusted Publisher**).
2. Under **Trusted Publisher**, choose **GitHub Actions** and enter exactly:

   | Field | Value |
   | --- | --- |
   | **Organization or user** | `factuarea` |
   | **Repository** | `factuarea-n8n-nodes` |
   | **Workflow filename** | `release.yml` |
   | **Environment** | *(leave empty)* |

3. Save.

The permission is bound to that **triple**: owner, repository, workflow file. All
three must match what actually runs. Renaming the workflow file, moving the
repository to a different owner, or publishing from a second workflow all break
the binding, and they break it at publish time, not before.

### What it looks like when this step is missing

The build is green, the gates pass, and the publish step fails with npm's own
authentication error. npm reports it as **`ENEEDAUTH`**, or as **`E404`** on the
package: npm answers a request from an unauthorised publisher with a 404 rather
than revealing whether the package exists. Neither error mentions Trusted
Publishing, which is why this section exists and why the workflow prints a
pointer back to this file when the publish step fails.

The same trap, and the same remedy, is documented for the Factuarea TypeScript
SDK in `../factuarea-node/docs/RELEASING.md`, whose `release.yml` carries an
explicit "Explain a failed publish" step for it. This package follows that
precedent.

### The first publish is a special case

Trusted Publishing can only be configured on a package that **already exists** on
npm, so the very first version cannot be published by the trusted workflow. The
SDK resolved this by publishing its `0.1.0` manually, once, and then configuring
the Trusted Publisher. Do the same here:

```bash
npm whoami            # confirm the owning account
npm publish --access public --provenance=false
```

`--provenance=false` is not optional, and it is not a weakening of the release.
`package.json` sets `publishConfig.provenance: true`, and npm honours that
everywhere — including a laptop, where it cannot be satisfied: provenance is an
attestation signed from a supported CI runner over OIDC, so outside one npm
**aborts** the publish instead of publishing without it. Measured in the npm the
release runs on (npm 12.0.1, `libnpmpublish/lib/publish.js`): with
`provenance === true`, `ensureProvenanceGeneration()` accepts GitHub Actions
and GitLab CI and throws `EUSAGE` for anything else —

    Automatic provenance generation not supported for provider: <name>

— before the tarball is uploaded. `npm publish --dry-run` does NOT reveal this:
it skips the attestation step and exits 0, so the first sign of the problem would
be the real publish failing. The flag states out loud what is already true of a
manual publish: **`0.1.0` carries no provenance attestation.**
That is why the verification checklist below asks for provenance on *the
published version* — the first release is the only one that cannot have it, and
every release after it goes out through the workflow, which can.

Then configure the Trusted Publisher as above, and never publish by hand again.
The npm account uses two-factor authentication, so that first publish may open a
browser to complete web authentication.

If npm has since made it possible to register a Trusted Publisher for a package
name that does not yet exist, prefer that: it removes the only manual publish in
this package's life. Check before you run the command above.

---

## The normal flow

A release is a **tag**. There is no changeset tooling and no version-bump pull
request in this repository: it publishes one artefact at a low cadence, and every
development dependency avoided is surface that does not need maintaining.

1. **Update the version and the changelog on a branch.**

   ```bash
   npm version 0.2.0 --no-git-tag-version
   ```

   Add the matching entry to [CHANGELOG.md](../CHANGELOG.md).

2. **Run the full gate locally.**

   ```bash
   npm run verify
   ```

3. **Open a pull request and merge it.**

4. **Tag the merge commit and push the tag.**

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

   The tag is `v` followed by the exact `version` in `package.json`. The workflow
   compares the two and refuses to publish if they differ: a tag that says one
   thing and a manifest that says another produces a release nobody can locate
   afterwards.

5. **Watch the workflow.** It runs every gate and publishes only if all of them
   pass. Publishing first and checking afterwards would leave a version on npm
   that verification will reject, and npm versions are immutable.

You never run `npm publish` by hand for a normal release.

## What the workflow requires

`.github/workflows/release.yml` is the authority; these are the properties it has
to keep, and why.

| Requirement | Why |
| --- | --- |
| `permissions: id-token: write` on the publishing job | Without it there is no OIDC token, and Trusted Publishing cannot authenticate. |
| npm **>= 11.5.1** in the runner | Earlier npm does not support Trusted Publishing. `actions/setup-node` ships an older npm, so the workflow installs a known-good version explicitly. |
| `NPM_CONFIG_PROVENANCE: "true"` | Attaches the provenance attestation to the publish. `publishConfig.provenance` in `package.json` says the same thing; both are set so neither alone is load-bearing. |
| No `NPM_TOKEN` secret | A long-lived token is the credential Trusted Publishing exists to remove. If one is ever added, publishing may keep working while silently ceasing to be attested. |
| Tag and manifest versions compared before anything else | See step 4 above. |
| Every gate green before the publish step | A red gate stops the release. |

## The gates

`npm run verify` runs them in order:

| Script | What it checks |
| --- | --- |
| `npm run build` | TypeScript compiles and node icons are copied next to the output. |
| `npm test` | The package's own test suite, on Node's native test runner. |
| `npm run lint:english` | No Spanish in `src`, `docs`, `README.md` or `CHANGELOG.md`. See [ENGLISH-ONLY.md](ENGLISH-ONLY.md). |
| `npm run lint:package` | MIT licence, empty runtime `dependencies`, no `process.env` access, no filesystem access, checked against the **artefact npm would publish** rather than against the source tree. |
| `npm run scan` | The official `@n8n/scan-community-package` analyser. |

**Before the first publish, `npm run verify` ends red on its last step and that is
expected.** The analyser resolves the package from npm, and until `0.1.0` exists
there npm answers `404`, which the gate reports as a failed scan. Run the first
four by hand instead — `npm run build && npm test && npm run lint:english &&
npm run lint:package` — and read the scan's `404` for what it is. Do not silence
it, and do not add a "package not published" escape hatch to the script: `ci.yml`
already carries that guard, in the one place where it retires itself.

Two things about the scan gate that look like bugs and are not:

**It is not pinned to a version.** The analyser runs at whatever version is
current. Pinning it would produce a reproducible green that can be lying the day
n8n hardens a requirement. We would rather CI go red the day the rule changes,
which is when we want to know, than the day we try to publish. The cost is
accepted: an occasional red that our own change did not cause. Do not "fix" it by
pinning.

**It asserts on the analyser's output, not on its exit code.** The official CLI
prints a failure line and still exits `0`; only an internal crash exits non-zero.
Trusting the exit code would make the gate green on a failing scan, which is
exactly the shape of a guardrail that reports success while protecting nothing.

**It resolves the package from the npm registry**, so it can only inspect a
version that is already published. Read `npm run scan` as a check on what is on
npm, not as a pre-flight check on the working tree. For a brand-new version the
meaningful run is the one immediately **after** publishing; before publishing it
reports on the previous version. `npm run lint:package` is the gate that inspects
the artefact you are about to ship, and it runs on the unpublished tree.

### Where the scan gates, and where it only reports

That last property has a consequence for both workflows, and it is written out
here because reading either file in isolation invites the wrong conclusion.

**In `release.yml` there are two analyser runs, and only the second one gates.**

| Step | When | Judges | Effect on the release |
| --- | --- | --- | --- |
| `Official n8n analyser, against the version currently on npm` | Before `npm publish` | The **previous** release | `continue-on-error: true`. It **does not hold the release**: a red prints a warning and the run goes on. |
| `Official n8n analyser, against the version just published` | After `npm publish` | The version this run shipped | **Blocking.** A red fails the workflow. |

The pre-publish run cannot gate on anything meaningful, because the artefact it
would have to judge is not on npm yet — it inspects the version already published,
so it is describing the past. Letting it block would also invert the intent: the
likeliest cause of a red there is n8n having hardened a requirement, and the
release it would stop is precisely the one that **fixes** it. So it runs, its
verdict goes in the log, and a failure adds a warning pointing back here.

The post-publish run is the one that judges this release. It first polls
`npm view n8n-nodes-factuarea version` until the registry serves the version just
published — a new version takes a moment to become readable, and without the wait
the analyser would inspect the previous one and report on the wrong artefact — and
only then scans. It cannot prevent the publish, since npm versions are immutable
once accepted; what it does is make a bad release impossible to miss. The remedy
is the one below: deprecate it and ship a fix forward.

**In `ci.yml` the analyser gate carries one guard, and only one.** Before running,
the job asks npm whether the package exists:

- **Published** — the current version is printed and `npm run scan` runs,
  blocking, exactly as described above.
- **`E404`, the package is not on npm at all** — the job prints a GitHub warning
  and does not scan. That is the state before the first manual publish, when the
  analyser has nothing to measure. "Nothing to measure" is not "clean", so it is
  said out loud rather than passed over in silence. The guard retires itself: once
  `0.1.0` is on npm this branch stops being taken.
- **Any other failure to reach npm** — a network problem, a registry outage, a
  proxy — the job prints an error and **fails**. That is why the guard matches on
  `E404` specifically instead of on "npm did not answer": a guard that read every
  npm failure as "nothing to measure" would turn every outage into a green gate,
  which is the shape of guardrail this repository treats as a defect.

## Verifying a published release

```bash
npm view n8n-nodes-factuarea version
npm view n8n-nodes-factuarea dist-tags
npm audit signatures                 # from a project that installed it
```

The npm package page shows a provenance badge linking back to the workflow run
that built it. If the badge is missing, the version was published without
provenance and cannot be submitted for n8n verification.

## Withdrawing a bad release

`npm unpublish` is only possible for a short window after publishing, and it
breaks anyone who already installed the version. Prefer deprecation:

```bash
npm deprecate n8n-nodes-factuarea@0.2.0 "Broken release, upgrade to 0.2.1"
```

Then ship the fix as a new patch version through the normal flow. There is
nothing to roll back on the Factuarea side: this package holds no state there
beyond the webhook destinations each user's workflows created, and those are
removed when their workflows are deactivated.

## Requesting n8n verification

Verification is a separate process with n8n's own timeline, and it is not part of
publishing. Before submitting, confirm:

- The published version carries a provenance attestation.
- `npm run scan` reports a pass against the **published** version.
- Runtime `dependencies` is empty, the licence is MIT, and the package touches
  neither the environment nor the filesystem (`npm run lint:package`).
- The package integrates exactly one third-party service.
- Every user-facing string is in English (`npm run lint:english`).

See also [MCP-REGISTRY.md](MCP-REGISTRY.md), which covers a related but separate
listing: the Factuarea MCP server in n8n's MCP servers registry.
