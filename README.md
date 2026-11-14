# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

## Secrets

- Callers: `CI_BOT_CLIENT_ID`, `CI_BOT_PRIVATE_KEY`, `PROJECTS_TOKEN`. Legacy `CI_BOT_ID` still works.
- This repo: `RELEASER_CLIENT_ID`, `RELEASER_PRIVATE_KEY`. Legacy `RELEASER_ID` still works.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js
```
