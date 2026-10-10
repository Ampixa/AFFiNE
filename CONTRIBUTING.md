# Contributing to Ampixa AFFiNE

## Where to open pull requests

Open PRs in **https://github.com/Ampixa/AFFiNE** with **`ampixa/selfhosted` as the base branch**. This is the default branch for Ampixa's self-hosted customizations.

Create a feature or fix branch from the latest `ampixa/selfhosted`, push it to this repository or your own fork, and open a PR back to `Ampixa/AFFiNE:ampixa/selfhosted`.

```sh
git fetch origin
git switch -c fix/describe-the-change origin/ampixa/selfhosted
# Make and commit your changes.
git push -u origin fix/describe-the-change
```

If `origin` points to your personal fork, fetch the base from your remote for `Ampixa/AFFiNE` instead.

## PR expectations

- Explain the problem and resulting behavior, and keep the PR focused.
- Include the checks you ran and their results. State which checks could not run and why.
- Describe database migrations, configuration changes, and deployment or rollback steps when applicable.
- Keep credentials, private keys, user data, recordings, and generated runtime bundles out of commits.
- Request maintainer review before merging. Merging a PR does not deploy it to AWS; deployment is a separate action.

## Self-hosted operations

For document search provisioning, acceptance checks and rollback, see
[the workspace search runbook](deploy/ampixa/SEARCH.md).
For small selected-document chat without an embedding provider, see
[the document chat runbook](deploy/ampixa/DOCUMENT-CHAT.md).

For creating and moving native Kanban cards through MCP, see
[the Kanban tools guide](deploy/ampixa/MCP-KANBAN.md).

## Relationship to upstream

`toeverything/AFFiNE` is the upstream project. Submit Ampixa deployment changes here. Propose general upstream changes to `toeverything/AFFiNE` according to that project's contribution process.

For upstream updates, prepare a dedicated synchronization branch and open a PR against `ampixa/selfhosted` so Ampixa customizations can be reviewed and retained. Do not use the fork's inherited `canary` branch as the target for Ampixa work.
