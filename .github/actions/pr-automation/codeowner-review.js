const { findPullRequest } = require('./sync-project-status.js');
const { copilotRequested, isCopilot, isCopilotReview } = require('./copilot-review.js');

const STATUS_CONTEXT = 'codeowner-review';
const SAFE_BOT_BRANCHES = {
  'renovate[bot]': ['renovate/all-minor-patch', 'renovate/github-actions', 'renovate/lock-file-maintenance', 'renovate/pi-extensions'],
  'alexfayers-auto-cd[bot]': ['bot/shared-files', 'release-please--branches--main'],
};
const IGNORED_REVIEW_STATES = ['COMMENTED', 'PENDING'];
const WRITE_PERMISSIONS = ['admin', 'write'];
const CHANGES_REQUESTED = 'Code owner requested changes';

async function setStatus(github, context, pr, state, description) {
  await github.rest.repos.createCommitStatus({
    ...context.repo,
    sha: pr.head.sha,
    context: STATUS_CONTEXT,
    state,
    description,
  });
}

function patternToRegExp(pattern) {
  const body = pattern.replace(/^\/|\/$/g, '');
  const head = pattern.replace(/\/$/, '').includes('/') ? '' : '(?:.*/)?';
  const tail = pattern.endsWith('/') ? '/.*' : /[*?][^/]*$/.test(body) ? '' : '(?:/.*)?';
  const source = body.replace(/(^|\/)\*\*(?:\/|$)|\*+|\?|[.+^${}()|[\]\\]/g, (token, lead) => (lead !== undefined ? lead + (token.endsWith('/') ? '(?:.*/)?' : '.*') : token[0] === '*' ? '[^/]*' : token === '?' ? '[^/]' : `\\${token}`));
  return new RegExp(`^${head}${source}${tail}$`);
}

async function readCodeOwners(github, { owner, repo }, ref) {
  let data;
  try {
    ({ data } = await github.rest.repos.getContent({ owner, repo, path: 'CODEOWNERS', ref }));
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }
  return parseCodeOwners(Buffer.from(data.content, 'base64').toString());
}

function parseCodeOwners(text) {
  return text.split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .map(([pattern, ...owners]) => ({ pattern: patternToRegExp(pattern), owners: owners.filter((handle) => /^@?[\w-]+$/.test(handle)).map((handle) => handle.replace(/^@/, '').toLowerCase()) }));
}

function ownersOf(rules, path) {
  return rules.findLast(({ pattern }) => pattern.test(path))?.owners;
}

function latestReviewStates(reviews) {
  const states = new Map();
  for (const { user, state } of reviews) {
    if (!IGNORED_REVIEW_STATES.includes(state)) {
      states.set(user.login.toLowerCase(), state);
    }
  }
  return states;
}

/** Copilot's verdict: 'approved' (approved, or its latest review left no comments), 'commented', 'pending' (requested, not reviewed) or 'never'. */
async function copilotVerdict({ github, context, pr, reviews }) {
  const latest = reviews.filter(isCopilotReview).at(-1);
  if (!latest) return (await copilotRequested(github, context, pr)) ? 'pending' : 'never';
  if (latest.commit_id !== pr.head.sha) return pr.requested_reviewers?.some(isCopilot) ? 'pending' : 'never';
  if (latest.state !== 'COMMENTED') return latest.state === 'APPROVED' ? 'approved' : 'commented';
  const comments = await github.paginate(github.rest.pulls.listCommentsForReview, { ...context.repo, pull_number: pr.number, review_id: latest.id, per_page: 100 });
  return comments.length ? 'commented' : 'approved';
}

/** Returns [state, description, owners to ask, reviews, min-reviews applied]: the owners only when the gate or min-reviews should request them. */
async function evaluate({ github, context, pr }) {
  const { owner, repo } = context.repo;
  if (Object.hasOwn(SAFE_BOT_BRANCHES, pr.user.login) && SAFE_BOT_BRANCHES[pr.user.login].includes(pr.head.ref)) {
    return ['success', 'Bot PR needs no code owner review', []];
  }
  const author = pr.user.login.toLowerCase();
  const repoOwner = owner.toLowerCase();
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 });
  const verdict = await copilotVerdict({ github, context, pr, reviews });
  const paths = files.flatMap(({ filename, previous_filename }) => [filename, previous_filename].filter(Boolean));
  if (['commented', 'never'].includes(verdict) && paths.length) {
    const extraRules = parseCodeOwners(process.env.REVIEW_OWNERS ?? '');
    const needed = [...new Set([repoOwner, ...paths.flatMap((path) => ownersOf(extraRules, path) ?? [])])].filter((login) => login !== author);
    if (!needed.length) {
      return ['success', 'No owner review needed', [], reviews];
    }
    // A Copilot request can show up after pull_request_target events, so ask a never-asked PR's owners only after a workflow run.
    const ask = verdict === 'commented' || context.eventName === 'workflow_run';
    const count = Math.max(1, minReviews(pr.labels ?? []));
    return [...ownerVerdict(reviews, needed, author, count > 1 ? `Needs ${count} owner approvals` : 'Needs an owner approval', count), ask ? needed : [], reviews, true];
  }
  if (verdict === 'pending') {
    return ['pending', 'Waiting for the requested Copilot review', [], reviews];
  }
  const rules = await readCodeOwners(github, context.repo, pr.base.ref);
  const needsReview = (path) => (ownersOf(rules, path) ?? [repoOwner]).some((handle) => handle !== author);
  if (!files.some(({ filename, previous_filename }) => [filename, previous_filename].some((path) => path && needsReview(path)))) {
    return ['success', 'No code owner review needed', []];
  }
  const owners = [repoOwner].filter((login) => login !== author);
  const result = ownerVerdict(reviews, new Set([repoOwner, ...rules.flatMap((rule) => rule.owners)]), author, 'Needs a code owner approval');
  if (result[0] === 'pending' && result[1] !== CHANGES_REQUESTED && verdict === 'approved' && (await isCollaborator({ github, context, pr }))) {
    return ['success', 'Approved by Copilot on a collaborator PR', owners, reviews];
  }
  return [...result, owners, reviews];
}

function ownerVerdict(reviews, owners, author, waiting, count = 1) {
  const allowed = new Set(owners);
  const states = [...latestReviewStates(reviews)].filter(([login]) => allowed.has(login) && login !== author);
  if (states.some(([, state]) => state === 'CHANGES_REQUESTED')) {
    return ['pending', CHANGES_REQUESTED];
  }
  return states.filter(([, state]) => state === 'APPROVED').length >= count ? ['success', 'Approved by a code owner'] : ['pending', waiting];
}

async function isCollaborator({ github, context, pr }) {
  const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: pr.user.login });
  return WRITE_PERMISSIONS.includes(data.permission);
}

function minReviews(labels) {
  const counts = labels.map(({ name }) => /^min-reviews:([12])$/.exec(name)?.[1]).filter(Boolean).map(Number);
  return counts.length ? Math.max(...counts) : 0;
}

async function evaluateMinReviews({ github, context, pr }) {
  const needed = minReviews(pr.labels ?? []);
  if (needed === 0) {
    return null;
  }
  const reviews = (await github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number: pr.number, per_page: 100 })).filter((review) => !isCopilotReview(review));
  const author = pr.user.login.toLowerCase();
  const approvals = [...latestReviewStates(reviews)].filter(([login, state]) => login !== author && state === 'APPROVED').length;
  return approvals >= needed ? null : ['pending', `Needs ${needed} approval${needed > 1 ? 's' : ''} (${approvals} so far)`];
}

async function requestOwners({ github, context, pr, owners, reviews }) {
  if (pr.draft || !owners.length) {
    return;
  }
  const done = new Set([...(pr.requested_reviewers ?? []), ...reviews.map(({ user }) => user)].map(({ login }) => login.toLowerCase()));
  const reviewers = owners.filter((login) => !done.has(login));
  if (reviewers.length) {
    await github.rest.pulls.requestReviewers({ ...context.repo, pull_number: pr.number, reviewers });
  }
}

async function gate({ github, context }) {
  const pr = await findPullRequest(github, context);
  if (!pr) {
    return;
  }
  let result;
  let required;
  try {
    result = await evaluate({ github, context, pr });
    required = result[0] === 'success' && !result[4] ? await evaluateMinReviews({ github, context, pr }) : null;
    await setStatus(github, context, pr, ...(required ?? result.slice(0, 2)));
  } catch (error) {
    await setStatus(github, context, pr, 'error', 'Code owner review check failed to run');
    throw error;
  }
  if ((required ?? result)[0] === 'pending') {
    await requestOwners({ github, context, pr, owners: result[2], reviews: result[3] });
  }
}

module.exports = { gate };
