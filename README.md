# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

## Secrets

- Callers pass `CI_BOT_ID`, `CI_BOT_PRIVATE_KEY` and `PROJECTS_TOKEN` to the workflows that declare them.
- This repo sets `RELEASER_ID` and `RELEASER_PRIVATE_KEY` for `sync-review-rules.yml`.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js
```
