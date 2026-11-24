# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

## Secrets

- Callers: `CI_BOT_CLIENT_ID`, `CI_BOT_PRIVATE_KEY`, `PROJECTS_TOKEN`.
- This repo: `RELEASER_CLIENT_ID`, `RELEASER_PRIVATE_KEY`.

## Blocked PRs

- A PR is blocked while it has the `blocked` label or a `blocked:<reason>` label.
- `blocked.yml` fails when the event's PR has a blocked label. A caller runs it as job `unblocked` and gates a job with `needs: unblocked` only.
- A blocked PR shows the `unblocked` job as failed and the gated jobs as skipped. The failure is the label, not a broken check.
- Automation adds one label per reason:
  - `blocked:dependencies`: a "Depends on" or "Blocked by" link is open.
  - `blocked:conflicts`: the PR has merge conflicts.
  - `blocked:checks`: a required check failed.
  - `blocked:changes-requested`: the review decision is changes requested, or a reviewer with push access requested changes in their latest review. Only the latest 50 reviews are read.
- `pending:approval` marks a PR waiting for a required approval. It does not block CI.
- Automation removes a label only when the last `labeled` event for it came from automation. A label a person added stays. GitHub records no event when someone re-adds a label that is already there.
- Review submissions and dismissals re-run labelling only in repos with a `pr-review.yml` relay.

## Releases

- `releases.yml` runs release-please for llm-prompts, cline-hooks and mcp-memory with the RELEASER app. A daily run also enables auto-merge on each release PR.
- `release-please.yml` credits each release note line with its PR author, except bots and the repo owner.
- Each repo calls `release-dispatch.yml` on push to main, which triggers `releases.yml` for that repo.

## PR rebases

- Each base branch has one active PR, marked `auto-rebase-active`.
- Selection uses current auto-merge, review, required conversation resolution and required-check results, not the retained `auto-rebase` label.
- Pending checks keep the active PR selected. Closed PRs and definite blockers release the selection.
- Only the selected PR updates its branch. Strict required-check freshness is unchanged.
- Scheduled runs refresh `codeowner-review` waits that Copilot answered on any head. These runs ask the needed owners when the PR still needs an owner approval.
- `sync-shared-files.yml` opens caller updates in llm-prompts, cline-hooks and mcp-memory. Merge those updates to enable disabled-auto-merge events and scheduled recovery.

## PR template

- `pr-template.yml` runs on this repo's PRs with `pull_request_target`. Callers run it with `workflow_call`.
- The check fails when the PR body is missing or has an empty `## What` or `## Why` section, or keeps a `<!--` placeholder comment.
- Bot PRs are exempt.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js .github/scripts/*/*.test.js
```
