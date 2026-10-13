# Installed n8n recipe qualification

This group installs the existing reviewed `n8n-nodes-factuarea-0.1.2.tgz`
with npm and executes the real community node inside the official n8n engine.
It is a local fixture qualification, not a published package, a real Factuarea
backend qualification, or an activation of an external workflow.

The fixed engine is n8n **2.42.6**, image
`docker.n8n.io/n8nio/n8n@sha256:526daa38b68e923cc00c5280d18b4da5d489f115a73bdbf3b8e452b184197a9a`.
The image actually runs Node **26.7.0**; its n8n engine requirement is Node
`>=24.0.0`. This supersedes assumptions about the host's Node 22 runtime.
The community package's existing engine requirement remains `>=22.0.0`.

## Reproduce the isolated installed group

Docker Engine, host npm and OpenSSL are required. Pull the fixed image first:

```sh
docker pull docker.n8n.io/n8nio/n8n@sha256:526daa38b68e923cc00c5280d18b4da5d489f115a73bdbf3b8e452b184197a9a
python3 scripts/installedBatch82/run.py dev2n8n-installedBatch82-review
```

Choose an unused private directory name with the indicated prefix. The runner
refuses to reuse a directory containing a native SQLite database. It preserves
existing runs and verifies the earlier 495 Source/artifact/document pins before
and after execution. A later change to any earlier pin makes this guard stop
before installation. The final handoff records three later external Make/Zapier
supersessions separately; Root must supply their approved replacement freeze
before replaying this guarded recipe against those changed Sources. This group
never refreshes or overwrites the earlier freeze. It uses the existing tarball
without rebuilding or changing the package. The new group is independent of the
legacy connector suites.

The installation uses `npm install --offline --ignore-scripts
--legacy-peer-deps` in the private `.n8n/nodes` folder. The package has no runtime
dependencies. No global package installation or marketplace registration occurs.
The container uses the actual host UID/GID, `--network none`, no published ports,
two CPUs and a 2 GiB memory limit. All mounts point at the new private runtime or
this read-only test group. n8n listens on **127.0.0.1:17282** inside the container.
Its SQLite database and synthetic encrypted credentials live under the private
`dev2n8n-home` folder. No application database, Redis, backend or other container
is mounted or addressed.

A self-signed fixture certificate is trusted only by the container using
`NODE_EXTRA_CA_CERTS`. Its private hosts entry resolves `api.factuarea.com` to
127.0.0.1, where the fixture HTTPS service listens on port 443. The installed node
continues to use its exact production-shaped allowed HTTPS host and ordinary TLS
validation. Every accepted route is an explicit synthetic fixture; other routes
return 404. Network isolation prevents external API, telemetry or MCP registry
delivery even if the native engine tries to resolve a remote service.

## Import, configure and execute

The unchanged portable workflow is imported through the actual editor carrier
`POST /rest/workflows` into a newly initialized local instance, authenticated as
its synthetic owner. The current native CLI cannot import a workflow without a
host workflow ID: it fails its SQLite ID constraint. The editor carrier allocates
that ID and the inbound webhook ID natively. Native CLI export verifies every
original node, parameter, connection and inactive state; the sole normalized
node property is the host-assigned `webhookId`.

Configured private variants attach synthetic credentials, choose the actual
fixture pipeline/stage UUIDs and set the follow-up UTC date explicitly. The six
original CRM Prepare/Submit steps, expressions, original-key mapping and error
branches are preserved. One variant uses the genuine API-key credential format,
the other uses the real inherited n8n OAuth credential and authenticated helper.
The fake API exposes current fine scopes, sandbox context and current operation
availability. It creates fixture owner IDs, which the installed workflow must
pass unchanged from Lead to Opportunity to Activity. OAuth scope or family
authority is never inferred by the fixture.

The native manual-run endpoint registers temporary test webhooks only. Requests
go to localhost `/webhook-test/...`; the workflow is never published or made
active. The eight cases prove original import/export, API-key and OAuth journeys,
422/429/503 failure branches, mixed per-item success/error and current-authority
denial before every mutation. Each failed Submit makes one POST and stops. A
successful nullable Activity representation retains its genuine fixture owner
pointer. A separate native Split Out graph verifies multi-item execution without
calling a mocked `IExecuteFunctions` context. A native `export:entities` receipt
and the installed engine's own Cipher decoder verify the executed node's actual
`pairedItem` metadata: the successful item retains index 0 and the rejected item
retains index 1. The instance key stays in the private environment file; no
plaintext credential or instance key is printed by the observer.

## Upgrade, disconnect and limits

For a real private installation, use the package's existing README and CRM guide
to create credentials, choose only required native scopes, configure pipeline,
stage, target/date/timezone and select the correct credential realm. Preserve
every prepared original key, exact body, digest and CAS while updating a package.
Prepare/Submit input changes require explicit workflow migration. Never use an
uncertain, missing or pending Original result as permission to send another POST.

Disconnect by deactivating the real workflows and revoking the dedicated native
credential before removing the community package. The fixture runner terminates
its engine and removes its container automatically while retaining private
evidence. It leaves its workflows inactive. It does not disconnect an existing
host, change a real account, perform OAuth App Review, publish to npm or certify a
verified community package. Valid-token OAuth execution is observed here;
native refresh lineage, revocation producer effects, provider callbacks and
real backend persistence are separate proofs.

Logs, native importer receipts, exported workflow and case HTTP ledgers are kept
in the chosen private runtime directory. The final handoff is
`../runtime-evidence/resume-20261010/ecosystem-n8n-installed-batch82.json` relative
to the repository. Fixture credentials are synthetic and private, and no
credential is embedded in the portable workflow.

Primary documentation: [native server CLI](https://docs.n8n.io/deploy/host-n8n/configure-n8n/use-the-command-line.md),
[official Docker installation](https://docs.n8n.io/deploy/host-n8n/install-options/install-with-docker.md),
and [manual community installation](https://docs.n8n.io/integrations/community-nodes/installation-and-management/manual-installation.md).
