# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

## Secrets

- Callers: `CI_BOT_CLIENT_ID`, `CI_BOT_PRIVATE_KEY`, `PROJECTS_TOKEN`.
- This repo: `RELEASER_CLIENT_ID`, `RELEASER_PRIVATE_KEY`.

## Releases

- `releases.yml` runs release-please for llm-prompts, cline-hooks and mcp-memory with the RELEASER app. A daily run also enables auto-merge on each release PR.
- Each repo calls `release-dispatch.yml` on push to main, which triggers `releases.yml` for that repo.
- `release-backfill.yml` creates one release per ISO week from existing history. It defaults to a dry run.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js
```
