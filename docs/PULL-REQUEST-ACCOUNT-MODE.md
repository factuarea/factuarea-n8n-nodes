# Pull request: account mode

This file is the review note for the branch that gives the trigger an **Account**
mode, so a workflow can listen to the events of a whole Factuarea account. It is
written down rather than typed into a pull request box so that the description
survives the branch, and so that the one step nobody may take by accident,
publishing, is stated where a reviewer reads it.

Copy it into the pull request body when you open it. It follows
`docs/PULL-REQUEST-COMPANY-AXIS.md`: both changes live on the same branch and
ship in the same version.

---

## Branch

| | |
| --- | --- |
| **Branch** | `feat/epic-nif-axis-api` |
| **Branched from** | `main` |
| **Target** | `main`, once the API changes it follows are live |
| **Target version** | `0.2.0` (`origin/main` is `0.1.2`) |
| **Published** | nothing. No tag, no npm version, no release |

## What changes

The trigger gains a **Listen On** parameter with two values, `Company` (the
default, and the behaviour of every workflow saved before) and `Account`. In
Account mode, activating the workflow registers an account webhook on
`POST /v1/accounts/{account}/webhooks`, and deactivating it removes the endpoint.

- **Parameters:** **Account ID**, **Account Relationship** (`Own`, `Managed`,
  `All`; default `All`) and an optional **Company ID Filter**. **Company ID**
  shows only in Company mode.
- **Credential:** an optional **Default Account ID**, typed by the integrator and
  read only by Account mode.
- **Events:** in Account mode the picker joins the live public catalogue with the
  fifteen `account.*` events, a fixed list in
  `src/nodes/FactuareaTrigger/accountEventCatalog.ts` that a test compares with
  `test/vectors/account-event-types.json`.
- **Item:** `account`, `account_relationship` and `company_id` arrive with the
  event body; the `Factuarea-Account-Relationship` header is documented.
- **Filter:** an event of another `company_id` is answered `200` and dropped, so
  the sender does not retry it. An event with no `company_id` always starts the
  workflow. The filter runs after the signature and before deduplication.
- **Lifecycle:** the mode and the account are stored when the endpoint is created,
  and the check and the removal use the stored ones. Changing either on an active
  workflow cannot make the node delete another destination.
- **Messages:** catalogued for a test key, an issuer without account capability,
  the account endpoint limit, a plan without account webhooks and an endpoint
  disabled because its creator lost the capability.

## Why it is compatible

The new parameter defaults to `Company`, and a saved workflow with no value for it
is read as Company mode. The Company routes, the Company ID resolution, the
signature, the deduplication and the shape of the emitted item are unchanged. The
package still declares **one trigger node and one credential**, which is what the
package gate and n8n's verification require, so Account mode is a mode of the
same node and not a second node.

The breaking part of this branch is the company axis, described in
`docs/PULL-REQUEST-COMPANY-AXIS.md`. Account mode adds to it nothing breaking.

## What to check in review

1. `listenOn` defaults to `company`, and a node with no stored value is treated as
   Company mode (`test/webhookLifecycle.test.ts`, `test/factuareaTriggerNode.test.ts`).
2. The account routes are built only in Account mode, and the account is read from
   the node parameter first and the credential second, and from nowhere else.
3. The lifecycle stores the mode and the account (or, for a company endpoint, the
   company) at creation and uses them on check and removal, because n8n drops the
   parameters its `displayOptions` hide. On an account route, only a `404`
   `webhook_endpoint_not_found` counts as removed; a `404` `account_not_found`
   throws and keeps the stored endpoint.
4. The fifteen `account.*` names equal the vector extracted from the frozen API
   document, and Company mode offers none of them.
5. The Company ID Filter answers `200` without emitting for another `company_id`,
   emits when the event has none, and runs after the signature check.
6. Every catalogued account rejection has its message in `NODE_ERRORS` (including
   `account_not_found`), and none of those falls into the generic message that
   sends the user to check the key. That holds for the catalogued cases only:
   other 403s, such as `addon_not_active`, `feature_not_available_in_plan` or
   `privileged_scope_required`, still end in the generic missing-scope message.
7. `docs/LIMITATIONS.md` documents five limitations of Account mode, each with its
   code: a live key is required (`live_credential_required`, and
   `forbidden_action` for the issuer), test endpoints only from the dashboard,
   OAuth excluded (`forbidden_action`), the fixed `account.*` list, and the
   account endpoint cap (`account_webhook_endpoint_limit_reached`, with
   `addon_required` for a plan without the feature).
8. `npm run build && npm test`, `npm run lint:english` and `npm run lint:package`
   are green.

## Releasing, described and NOT performed

Publishing is an external, irreversible action. Nothing in this branch does it,
and nobody should do it as part of merging. It belongs to the owner, through
`.github/workflows/release.yml`.

The step, when the owner decides to take it, is the one of the company axis, once,
for both changes, with the target version **0.2.0**:

1. Bump `version` in `package.json` to `0.2.0`.
2. Move the `Unreleased` section of `CHANGELOG.md`, which holds the company axis
   and the account mode, under `0.2.0` with its date.
3. Merge to `main`.
4. Tag the merge commit `v0.2.0` and push the tag. `release.yml` triggers on `v*`
   and publishes to npm with Trusted Publishing and provenance.
   `docs/RELEASING.md` holds the preconditions, including the one manual setting
   on npmjs.com without which every publish fails.
5. Run the checks below against the published version.

### After publication: the official n8n analysis

`npm run scan` runs n8n's official community-package analyser, and it reads the
**published** package from the registry, so it cannot report on this branch and
must not be run before step 4. It is a check **after** publication, and it is the
owner's:

```bash
SCAN_VERSION=0.2.0 npm run scan
```

Run it once `0.2.0` is on npm. `SCAN_VERSION` pins the analysed version, so the
report is about `0.2.0` and not about the latest tag the registry resolves. Then install `0.2.0` in n8n and check that:

- a workflow saved with `0.1.2` and a Company ID still activates (Company mode is
  intact);
- a workflow in Account mode, with an Account ID and a live key issued by an owner
  or an admin of the account, registers an account endpoint and receives a
  delivery that verifies.

Until step 4 runs there is no new version on npm. A green local battery says the
branch is sound; it does not say the analysis passes.
