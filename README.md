# llm-prompts-ci

Shared GitHub Actions for the llm-prompts, cline-hooks and mcp-memory repositories.

Callers pin `@main`. Required checks match the job names in these workflows, so keep them unchanged.

## Reusable workflows

Call them with `uses: alexfayers/llm-prompts-ci/.github/workflows/<name>.yml@main`.

- `pr-automation.yml`: auto-merge, labels, rebase, code-owner gate and project board sync.
- `dependencies.yml`: pending status and `blocked` label while "Depends on" links are open.
- `pr-review.yml`: relays review events so automation reruns.
- `pr-template.yml`: checks the PR body against the PR template.
- `size-comment.yml`: posts the prompt size report on a PR.
- `hide-outdated-copilot-reviews.yml`: hides old Copilot review comments.
- `prompt-checks.yml`: checks prompt sizes.
- `sync-review-rules.yml`: opens PRs that copy `.github/instructions/` into the consumer repos.

## Actions

Use them with `uses: alexfayers/llm-prompts-ci/.github/actions/<name>@main`.

- `app-token`: mints a GitHub App token in public repos, otherwise returns the fallback token.
- `pr-automation`, `check-dependencies`, `pr-template`: used by the workflows above.
- `setup-just`: installs `just`.

## Secrets

Callers pass `CI_BOT_ID`, `CI_BOT_PRIVATE_KEY` and `PROJECTS_TOKEN` to the workflows that declare them. `sync-review-rules.yml` reads `RELEASER_ID`, `RELEASER_PRIVATE_KEY` and `PROJECTS_TOKEN` from this repository.

## Review rules

`.github/instructions/` holds the canonical Copilot review rules. Edit them here only. `sync-review-rules.yml` copies them to the consumer repos.

## Tests

```sh
node --test .github/actions/*/*.test.js .github/scripts/*.test.js
```
