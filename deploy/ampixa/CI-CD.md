# Docker-free continuous delivery

The production branch is `ampixa/selfhosted`. Pull requests build and test on
standard GitHub-hosted Linux runners without production credentials. A merge
builds frontend, backend and the Linux x64 native module from one commit, then
automatically deploys that exact successful push build through restricted SSH.

Neither production nor the builder requires Docker. The inherited upstream
container/mobile/cloud release workflows are separate from this pipeline.

## Gates and deployment behavior

- `ampixa-build.yml`: Node/Rust versions come from the repository; the compatible
  application version remains 0.27.4. Native storage limits, gateway, selected
  context, document search and MCP/Kanban tests must pass. PostgreSQL runs locally
  on the disposable runner. No real provider requests are made. Packaging removes
  AVA's test cache before moving the focused runtime dependencies, and rejects
  unexpected workspace-local runtime packages rather than overwriting them.
- `ampixa-deploy.yml`: accepts only successful **push** builds of the expected
  workflow on the production branch. PR artifacts cannot deploy. Both GitHub
  and the server reject a SHA superseded by a newer merge.
- Deployments are serialized, never canceled mid-switch. The host uses its
  installed trusted deployment helper rather than executing an uploaded shell
  script as root.
- The receiver bounds compressed/unpacked size and rejects escaping paths,
  symlinks, devices and hardlinks before extraction.
- Existing preflight verifies checksums, exact Node version, compatibility,
  native module, disk capacity and already-applied schema/data migrations.
  **Pending migrations block deployment**; they need a separate reviewed plan.
- The helper backs up PostgreSQL, configuration/storage, service definitions and
  the old application before switching. Health failure attempts to restore the
  previous app. It does not restore the database automatically.
- Credentials, Claude gateways, uploads and service drop-ins are preserved.
  File-chat provisioning is not rerun. Gateway source is packaged for inspection
  but gateway upgrades remain a separate explicit operation.
- A green `/info` check is startup acceptance, not proof of every product feature.
  After feature changes, verify login, document read/write, chat, attachments and
  MCP in the browser.

## Production environment secrets

Configure these in repository **Settings → Environments → production**:

| Secret                      | Value                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `AFFINE_DEPLOY_HOST`        | Production SSH hostname/IP                                                          |
| `AFFINE_DEPLOY_USER`        | Dedicated `affine-ci` account                                                       |
| `AFFINE_DEPLOY_KEY`         | Dedicated Ed25519 private key; never a personal SSH key                             |
| `AFFINE_DEPLOY_KNOWN_HOSTS` | Trusted server host-key entry verified through an existing authenticated connection |

Keep IP addresses, private keys and provider keys out of source, artifacts and
logs. Anthropic keys remain on the VM. GitHub masks stored secrets in logs, but
do not intentionally print them. Production secrets are unavailable to builds.

Restrict the environment to `ampixa/selfhosted`. For automatic rollout do not
configure required reviewers on this environment. Protect the branch with PR
reviews and the `Ampixa systemd build / build` check after its first successful
run. Administrators should not bypass failing checks.

## One-time server setup

From a reviewed checkout, transfer `deploy/ampixa/ci` to a private temporary
directory on the VM, along with the dedicated public key. Run:

```bash
sudo bash /path/to/ci/install-receiver.sh /absolute/path/to/ci-key.pub
```

This creates a dedicated account with a forced command and a narrowly named
sudo entry. It does not restart AFFiNE or alter provider credentials. The account
has no interactive SSH shell, forwarding, PTY, or general-purpose remote command.
Keep its home and authorization root-owned. Never replace this with an
unrestricted deployment key on an administrator account.

The host-side receiver/helper is deliberately not overwritten by deployment.
Changes to these files require explicit administrator installation using the
same reviewed-source procedure. Rotate the key by updating both the server's
authorization and the GitHub environment secret.

## Usage and recovery

After merging, inspect **Actions → Ampixa systemd build**, followed by
**Ampixa production deploy**. The deployment log records the SHA and backup
directory, with no runtime environment contents. Failed builds never deploy.

To retry a transient deployment failure, manually dispatch the deploy workflow
with the successful push-build run ID. It must still be the branch's current
SHA and its artifact must not have expired. For an expired artifact, rerun the
original push build, then deploy that successful run.

For a code-only rollback, connect as a production administrator:

```bash
sudo bash /usr/local/lib/affine-ci/rollback-release.sh CURRENT_FULL_SHA
```

Only roll back a release that ran no migrations. The helper requires the recorded
matching previous complete app. Database or storage restores need an explicit
recovery decision because subsequent writes may exist.

## Cost and retention

This fork is public. Standard hosted runner execution is currently free under
GitHub's public-repository policy. Larger runners are paid. Artifact storage has
separate allowances; bundles/logs expire after **two days**. The pipeline does not
increase storage budgets or create paid runners. Rust dependency builds use
a cache within the repository's existing allowance; PR caches remain scoped
to their PR and cannot replace production-branch caches. Monitor the
organization's storage usage and retain important releases in your own approved
backup location when needed. Existing production backups are not auto-deleted.

A release can take substantial time on a cold runner. Jobs have bounded timeouts
and no endless retry loop. A canceled/superseded build is not a deployable release.
