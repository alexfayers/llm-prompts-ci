# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

## Secrets

- Callers: `CI_BOT_CLIENT_ID`, `CI_BOT_PRIVATE_KEY`, `PROJECTS_TOKEN`.
- This repo: `RELEASER_CLIENT_ID`, `RELEASER_PRIVATE_KEY`.

## Releases

- `releases.yml` runs release-please for llm-prompts, cline-hooks and mcp-memory with the RELEASER app. A daily run also enables auto-merge on each release PR.
- `release-please.yml` credits each release note line with its PR author, except bots and the repo owner.
- Each repo calls `release-dispatch.yml` on push to main, which triggers `releases.yml` for that repo.

## PR rebases

- Each base branch has one active PR, marked `auto-rebase-active`.
- Selection uses current auto-merge, review and required-check results, not the retained `auto-rebase` label.
- Pending checks keep the active PR selected. Closed PRs and definite blockers release the selection.
- Only the selected PR updates its branch. Strict required-check freshness is unchanged.
- `sync-shared-files.yml` opens caller updates in llm-prompts, cline-hooks and mcp-memory. Merge those updates to enable disabled-auto-merge events and scheduled recovery.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js .github/scripts/*/*.test.js
```
