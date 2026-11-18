const { findPullRequest } = require('./sync-project-status.js');

const STATUS_CONTEXT = 'copilot-review';
const COPILOT_LOGINS = ['copilot', 'copilot-pull-request-reviewer[bot]'];

const HOLD_MARKER = 'copilot-review-hold';
const POLL_MS = 20_000;
const WAIT_MS = 600_000;

const DISABLE_AUTO_MERGE = `mutation($id: ID!) {
  disablePullRequestAutoMerge(input: {pullRequestId: $id}) {
    clientMutationId
  }
}`;

const isCopilot = (user) => COPILOT_LOGINS.includes(user?.login?.toLowerCase());
const isCopilotReview = (review) => review.is_copilot_code_review || isCopilot(review.user);

async function copilotRequested(github, context, pr) {
  if (pr.requested_reviewers?.some(isCopilot)) {
    return true;
  }
  const events = await github.paginate(github.rest.issues.listEventsForTimeline, { ...context.repo, issue_number: pr.number, per_page: 100 });
  const last = events.findLast(({ event, requested_reviewer }) => ['review_requested', 'review_request_removed'].includes(event) && isCopilot(requested_reviewer));
  return last?.event === 'review_requested';
}

async function evaluate({ github, context, pr }) {
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number: pr.number, per_page: 100 });
  if (reviews.some(isCopilotReview)) {
    return ['success', 'Copilot has reviewed'];
  }
  return (await copilotRequested(github, context, pr)) ? ['pending', 'Waiting for the requested Copilot review'] : ['success', 'No Copilot review requested'];
}

async function setStatus(github, context, pr, state, description) {
  await github.rest.repos.createCommitStatus({ ...context.repo, sha: pr.head.sha, context: STATUS_CONTEXT, state, description });
}

async function gate({ github, context }) {
  const pr = await findPullRequest(github, context);
  if (!pr) {
    return;
  }
  let status;
  try {
    status = await evaluate({ github, context, pr });
  } catch (error) {
    await setStatus(github, context, pr, 'error', 'Copilot review check failed to run');
    throw error;
  }
  await setStatus(github, context, pr, ...status);
}

async function holdAutoMerge({ github, context, core }) {
  const pr = await findPullRequest(github, context);
  if (!pr?.auto_merge) {
    return;
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number: pr.number, per_page: 100 });
  const review = reviews.filter(isCopilotReview).at(-1);
  if (!review || review.state === 'APPROVED') {
    return;
  }
  const comments = await github.paginate(github.rest.pulls.listReviewComments, { ...context.repo, pull_number: pr.number, per_page: 100 });
  if (comments.some((comment) => isCopilot(comment.user))) {
    return;
  }
  const marker = `<!-- ${HOLD_MARKER}:${review.id} -->`;
  const issueComments = await github.paginate(github.rest.issues.listComments, { ...context.repo, issue_number: pr.number, per_page: 100 });
  if (issueComments.some((comment) => comment.body?.includes(marker))) {
    return;
  }
  try {
    await github.graphql(DISABLE_AUTO_MERGE, { id: pr.node_id });
  } catch (error) {
    core.warning(`Failed to disable auto-merge: ${error.message}`);
    return;
  }
  await github.rest.issues.createComment({
    ...context.repo,
    issue_number: pr.number,
    body: `${marker}\nCopilot reviewed without approving and left no inline comments, so auto-merge is off. Check its review, then re-enable auto-merge.`,
  });
}

async function waitForReview({ github, context, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const { requested_reviewer, pull_request } = context.payload;
  if (!isCopilot(requested_reviewer)) {
    return false;
  }
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: pull_request.number });
    if (pr.state !== 'open' || pr.draft || pr.head.sha !== pull_request.head.sha) {
      return false;
    }
    const reviews = await github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number: pr.number, per_page: 100 });
    if (reviews.some((review) => isCopilotReview(review) && review.commit_id === pr.head.sha)) {
      return true;
    }
    await delay(POLL_MS);
  }
  return false;
}

module.exports = { gate, holdAutoMerge, waitForReview, copilotRequested, isCopilot, isCopilotReview };
