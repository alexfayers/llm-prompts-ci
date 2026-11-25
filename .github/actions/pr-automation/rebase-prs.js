const { isRenovate } = require('./label-pr.js');
const { isBlockedLabel } = require('../blocked/blocked.js');
const { hasReviewRequirements } = require('./sync-project-status.js');

const ACTIVE_LABEL = { name: 'auto-rebase-active', color: '0e8a16', description: 'The next PR selected for merging on its base branch' };
const PR_FIELDS = 'id number state createdAt baseRefName headRefOid isDraft mergeable reviewDecision latestOpinionatedReviews(first: 100) { nodes { state } pageInfo { hasNextPage } } autoMergeRequest { enabledAt } author { login } labels(first: 100) { nodes { name } pageInfo { hasNextPage } } reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage } }';
const LIST_OPEN_PRS = `query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      nodes { ${PR_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const GET_PR = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { ${PR_FIELDS} } }
}`;
const updateBranch = (method) => `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: {pullRequestId: $id, expectedHeadOid: $head, updateMethod: ${method}}) { clientMutationId }
}`;
const REBASE_BRANCH = updateBranch('REBASE');
const MERGE_BRANCH = updateBranch('MERGE');
const hasLabel = (pr, name) => pr.labels.nodes.some((label) => label.name === name);
const excluded = (pr) => pr.state !== 'OPEN' || pr.isDraft || !pr.autoMergeRequest || isRenovate(pr.author?.login) || pr.labels.nodes.some(({ name }) => isBlockedLabel(name)) || pr.mergeable === 'CONFLICTING' || pr.reviewDecision === 'CHANGES_REQUESTED' || pr.latestOpinionatedReviews?.nodes.some(({ state }) => state === 'CHANGES_REQUESTED');
const awaitingReview = (pr) => pr.reviewDecision === 'REVIEW_REQUIRED';
const oldestFirst = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number;

async function rebaseBranch(github, core, pr) {
  const variables = { id: pr.id, head: pr.headRefOid };
  try {
    await github.graphql(REBASE_BRANCH, variables);
    return;
  } catch (error) {
    core.info(`Rebase of #${pr.number} failed, updating by merge: ${error.message}`);
  }
  try {
    await github.graphql(MERGE_BRANCH, variables);
  } catch (error) {
    core.warning(`Failed to update #${pr.number}: ${error.message}`);
  }
}

async function requiredResults(github, repo, pr) {
  const rules = await github.paginate(github.rest.repos.getBranchRules, { ...repo, branch: pr.baseRefName, per_page: 100 });
  if (rules.some(({ type, parameters }) => type === 'pull_request' && parameters.required_review_thread_resolution) && pr.reviewThreads.nodes.some(({ isResolved }) => !isResolved)) return 'failure';
  const required = rules.filter(({ type }) => type === 'required_status_checks').flatMap(({ parameters }) => parameters.required_status_checks);
  if (!required.length) return 'success';
  const [runs, statuses] = await Promise.all([
    github.paginate(github.rest.checks.listForRef, { ...repo, ref: pr.headRefOid, per_page: 100 }),
    github.paginate(github.rest.repos.listCommitStatusesForRef, { ...repo, ref: pr.headRefOid, per_page: 100 }),
  ]);
  const apps = new Map();
  const states = [];
  for (const { context, integration_id: app } of required) {
    const bound = app != null && app !== -1;
    const run = runs.filter((run) => run.name === context && (!bound || run.app?.id === app)).sort((a, b) => b.id - a.id || (b.started_at || '').localeCompare(a.started_at || ''))[0];
    let status;
    for (const candidate of statuses.filter((status) => status.context === context).sort((a, b) => b.id - a.id)) {
      if (bound) {
        const slug = candidate.creator?.type === 'Bot' && candidate.creator.login?.match(/^(.+)\[bot\]$/)?.[1];
        if (!slug) continue;
        if (!apps.has(slug)) {
          const { data } = await github.request('GET /apps/{app_slug}', { app_slug: slug });
          apps.set(slug, data.id);
        }
        if (apps.get(slug) !== app) continue;
      }
      status = candidate;
      break;
    }
    if (!run && !status) states.push('pending');
    if (run) {
      const passed = ['success', 'neutral', 'skipped'].includes(run.conclusion);
      const failed = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale'].includes(run.conclusion);
      states.push(run.status !== 'completed' ? 'pending' : passed ? 'success' : failed ? 'failure' : 'pending');
    }
    if (status) states.push(['failure', 'error'].includes(status.state) ? 'failure' : status.state === 'success' ? 'success' : 'pending');
  }
  return states.includes('failure') ? 'failure' : states.every((state) => state === 'success') ? 'success' : 'pending';
}

async function rebase({ github, context, core }) {
  const nodes = [];
  let cursor = null;
  do {
    const { repository: { pullRequests } } = await github.graphql(LIST_OPEN_PRS, { ...context.repo, cursor });
    if (pullRequests.nodes.some((pr) => pr.labels.pageInfo?.hasNextPage || pr.latestOpinionatedReviews?.pageInfo?.hasNextPage || pr.reviewThreads?.pageInfo?.hasNextPage) || (pullRequests.pageInfo.hasNextPage && !pullRequests.pageInfo.endCursor)) {
      throw new Error('Incomplete PR metadata; retaining the current rebase selection');
    }
    nodes.push(...pullRequests.nodes);
    cursor = pullRequests.pageInfo.hasNextPage ? pullRequests.pageInfo.endCursor : null;
  } while (cursor);
  const active = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'all', labels: ACTIVE_LABEL.name, per_page: 100 });
  for (const issue of active.filter((issue) => issue.pull_request && !nodes.some((pr) => pr.number === issue.number))) {
    const { repository } = await github.graphql(GET_PR, { ...context.repo, number: issue.number });
    if (!repository.pullRequest) throw new Error(`Cannot inspect active PR #${issue.number}`);
    if (repository.pullRequest.state !== 'OPEN') {
      await github.rest.issues.removeLabel({ ...context.repo, issue_number: issue.number, name: ACTIVE_LABEL.name });
    }
  }
  const bases = Map.groupBy(nodes, (pr) => pr.baseRefName);
  for (const [base, prs] of bases) {
    const ordered = prs.sort(oldestFirst);
    const incumbents = ordered.filter((pr) => hasLabel(pr, ACTIVE_LABEL.name));
    let selected;
    for (const pr of incumbents) {
      if (!excluded(pr) && await requiredResults(github, context.repo, pr) !== 'failure') {
        selected = pr;
        break;
      }
    }
    for (const pr of incumbents.filter((pr) => pr !== selected)) {
      await github.rest.issues.removeLabel({ ...context.repo, issue_number: pr.number, name: ACTIVE_LABEL.name });
    }
    if (!selected) {
      for (const pr of ordered) {
        if (!excluded(pr) && !awaitingReview(pr) && pr.mergeable === 'MERGEABLE' && await hasReviewRequirements(github, context.repo, pr.headRefOid) && await requiredResults(github, context.repo, pr) === 'success') {
          selected = pr;
          break;
        }
      }
      if (!selected) continue;
      try {
        await github.rest.issues.createLabel({ ...context.repo, ...ACTIVE_LABEL });
      } catch (error) {
        if (error.status !== 422) throw error;
      }
      await github.rest.issues.addLabels({ ...context.repo, issue_number: selected.number, labels: [ACTIVE_LABEL.name] });
    }
    const { repository: current } = await github.graphql(GET_PR, { ...context.repo, number: selected.number });
    const pr = current.pullRequest;
    if (!pr || pr.labels.pageInfo?.hasNextPage || pr.latestOpinionatedReviews?.pageInfo?.hasNextPage || pr.reviewThreads?.pageInfo?.hasNextPage) throw new Error(`Cannot revalidate active PR #${selected.number}`);
    if (excluded(pr) || awaitingReview(pr) || !hasLabel(pr, ACTIVE_LABEL.name) || pr.mergeable !== 'MERGEABLE' || pr.baseRefName !== base || pr.headRefOid !== selected.headRefOid) continue;
    if (await requiredResults(github, context.repo, pr) !== 'success' || !await hasReviewRequirements(github, context.repo, pr.headRefOid)) continue;
    const { data: { behind_by: behind } } = await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${base}...${pr.headRefOid}` });
    if (behind > 0) await rebaseBranch(github, core, pr);
  }
}

module.exports = { rebase, ACTIVE_LABEL };
