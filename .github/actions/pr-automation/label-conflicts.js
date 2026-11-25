const { BLOCKED_LABEL, CHANGES_REQUESTED_LABEL, PENDING_APPROVAL_LABEL, removeLabel, labelledByBot, blockedLabel, syncLabel } = require('./label-pr.js');
const { REVIEWS, writerReviews, changesRequested } = require('./sync-project-status.js');
const { ACTIVE_LABEL } = require('./rebase-prs.js');

const CONFLICTS_LABEL = blockedLabel('conflicts', 'Merge conflicts with the base branch');
const CHECKS_LABEL = blockedLabel('checks', 'A required check failed');
const DEPENDENCIES_CONTEXT = 'dependencies';
const MERGEABLE_ATTEMPTS = 5;
const MERGEABLE_DELAY_MS = 3000;
const FAILED_CONCLUSIONS = ['failure', 'timed_out'];

const GET_PR = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewDecision ${REVIEWS} mergeable labels(first: 50) { nodes { name } } } }
}`;

async function fetchPr(github, context, number, delay) {
  for (let attempt = 1; ; attempt++) {
    const { pullRequest } = (await github.graphql(GET_PR, { ...context.repo, number })).repository;
    if (pullRequest.mergeable !== 'UNKNOWN' || attempt === MERGEABLE_ATTEMPTS) {
      return pullRequest;
    }
    await delay(MERGEABLE_DELAY_MS);
  }
}

async function requiredCheckFailed(github, repo, { head, base }) {
  const rules = await github.paginate(github.rest.repos.getBranchRules, { ...repo, branch: base.ref, per_page: 100 });
  const required = rules.filter(({ type }) => type === 'required_status_checks').flatMap(({ parameters }) => parameters.required_status_checks.map(({ context }) => context));
  const runs = required.length ? await github.paginate(github.rest.checks.listForRef, { ...repo, ref: head.sha, per_page: 100 }) : [];
  const newest = new Map();
  for (const run of runs.filter(({ name }) => required.includes(name))) {
    if (!newest.has(run.name) || run.started_at > newest.get(run.name).started_at) {
      newest.set(run.name, run);
    }
  }
  return [...newest.values()].some(({ conclusion }) => FAILED_CONCLUSIONS.includes(conclusion));
}

async function dependenciesPending(github, repo, sha) {
  const { data } = await github.rest.repos.listCommitStatusesForRef({ ...repo, ref: sha });
  return data.find(({ context }) => context === DEPENDENCIES_CONTEXT)?.state === 'pending';
}

function clearsBlock(pr, failed) {
  return pr.mergeable === 'MERGEABLE' && !failed && !changesRequested(pr, writerReviews(pr));
}

async function labelConflicts({ github, removeClient = github, context, core, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const { payload, repo, ref } = context;
  const headSha = payload.workflow_run?.head_sha;
  const prs = payload.pull_request
    ? [payload.pull_request]
    : (await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base: ref.replace('refs/heads/', ''), per_page: 100 })).filter((pr) => !headSha || pr.head.sha === headSha);

  for (const listed of prs) {
    const { number } = listed;
    const pr = await fetchPr(github, context, number, delay);
    const names = pr.labels.nodes.map(({ name }) => name);
    const target = { ...repo, issue_number: number };
    const failed = await requiredCheckFailed(github, repo, listed);

    if (pr.mergeable !== 'UNKNOWN') {
      await syncLabel({ github, removeClient, core, target, names, label: CONFLICTS_LABEL, active: pr.mergeable === 'CONFLICTING' });
    }
    await syncLabel({ github, removeClient, core, target, names, label: CHECKS_LABEL, active: failed });
    if (names.includes(BLOCKED_LABEL.name) && clearsBlock(pr, failed) && await labelledByBot(github, target, BLOCKED_LABEL.name) && !await dependenciesPending(github, repo, listed.head.sha)) {
      await removeLabel(removeClient, core, target, BLOCKED_LABEL.name);
    }
  }
}

async function clearStateLabels({ removeClient, context, core }) {
  const { number, labels } = context.payload.pull_request;
  const state = [CHECKS_LABEL, CONFLICTS_LABEL, CHANGES_REQUESTED_LABEL, PENDING_APPROVAL_LABEL, ACTIVE_LABEL].map(({ name }) => name);
  for (const { name } of labels.filter(({ name }) => state.includes(name))) {
    await removeLabel(removeClient, core, { ...context.repo, issue_number: number }, name);
  }
}

module.exports = { labelConflicts, clearStateLabels, DEPENDENCIES_CONTEXT, dependenciesPending, fetchPr, requiredCheckFailed, clearsBlock };
