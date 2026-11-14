# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

## Secrets

- Callers: `CI_BOT_ID`, `CI_BOT_PRIVATE_KEY`, `PROJECTS_TOKEN`.
- This repo: `RELEASER_ID`, `RELEASER_PRIVATE_KEY`.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js
```
