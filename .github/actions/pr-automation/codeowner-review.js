const { findPullRequest, CODEOWNER_REVIEW_CONTEXT: STATUS_CONTEXT } = require('./sync-project-status.js');
const { copilotHold, isCopilotReview, copilotWaitAnswered } = require('./copilot-review.js');
const { syncLabel, removeLabel, ensureLabel, PENDING_APPROVAL_LABEL, OWNER_REVIEWED_LABEL } = require('./label-pr.js');

const SAFE_BOT_BRANCHES = {
  'renovate[bot]': ['renovate/all-minor-patch', 'renovate/github-actions', 'renovate/lock-file-maintenance', 'renovate/pi-extensions'],
  'alexfayers-auto-cd[bot]': ['bot/shared-files', 'release-please--branches--main'],
};
const IGNORED_REVIEW_STATES = ['COMMENTED', 'PENDING'];
const WRITE_PERMISSIONS = ['admin', 'write'];
const CHANGES_REQUESTED = 'Code owner requested changes';
const OWNER_REVIEWED = 'Reviewed locally by the owner';
const BRANCH_MOVES = ['push', 'force_push', 'branch_creation'];

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
  return parseCodeOwners(Buffer.from(data.content, 'base64').toString(), owner.toLowerCase());
}

function parseCodeOwners(text, repoOwner) {
  return text.split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .map(([pattern, ...owners]) => {
      const logins = owners.filter((handle) => /^@?[\w-]+$/.test(handle)).map((handle) => handle.replace(/^@/, '').toLowerCase());
      return { pattern: patternToRegExp(pattern), owners: logins.length < owners.length ? [...new Set([...logins, repoOwner])] : logins };
    });
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

/** Copilot's verdict: 'approved' (approved, or its latest review left no comments or only low-severity findings), 'commented' or 'never'. */
async function copilotVerdict({ github, context, pr, reviews }) {
  const latest = reviews.filter(isCopilotReview).at(-1);
  if (!latest) return 'never';
  if (latest.state !== 'COMMENTED') return latest.state === 'APPROVED' ? 'approved' : 'commented';
  const comments = await github.paginate(github.rest.pulls.listCommentsForReview, { ...context.repo, pull_number: pr.number, review_id: latest.id, per_page: 100 });
  const body = latest.body ?? '';
  const severities = [...body.matchAll(/alt="([^"]+) severity"/g)].map(([, severity]) => severity);
  const listed = new Set([...body.matchAll(/discussion_r(\d+)/g)].map(([, id]) => id));
  const lowOnly = body.includes('<!-- ccr-overview-v2 -->') && severities.length && severities.every((severity) => severity === 'Low') && comments.every(({ id }) => listed.has(String(id)));
  return (comments.length && !lowOnly) || severities.some((severity) => severity !== 'Low') ? 'commented' : 'approved';
}

const isSafeBotPr = (pr) => Object.hasOwn(SAFE_BOT_BRANCHES, pr.user.login) && SAFE_BOT_BRANCHES[pr.user.login].includes(pr.head.ref);

async function syncOwnerReview({ github, context, core }) {
  const { action, pull_request: pr } = context.payload;
  if (action !== 'synchronize') return;
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
  if (current.head.sha !== pr.head.sha || !current.labels.some(({ name }) => name === OWNER_REVIEWED_LABEL.name)) return;
  const labelled = (await ownerLabelEvents(github, context, current)).findLast(({ event }) => event === 'labeled');
  const pushedAt = await headPushedAt(github, current);
  if (labelled && pushedAt !== undefined && Date.parse(labelled.created_at) < pushedAt) {
    await removeLabel(github, core, { ...context.repo, issue_number: pr.number }, OWNER_REVIEWED_LABEL.name);
  }
}

async function headPushedAt(github, pr) {
  if (!pr.head.repo) return undefined;
  const activities = await github.paginate(github.rest.repos.listActivities, { owner: pr.head.repo.owner.login, repo: pr.head.repo.name, ref: pr.head.ref, per_page: 100 });
  const latest = activities.filter(({ after }) => after === pr.head.sha).reduce((found, activity) => (!found || Date.parse(activity.timestamp) > Date.parse(found.timestamp) ? activity : found), undefined);
  return BRANCH_MOVES.includes(latest?.activity_type) ? Date.parse(latest.timestamp) : undefined;
}

async function ownerLabelEvents(github, context, pr) {
  const events = await github.paginate(github.rest.issues.listEvents, { ...context.repo, issue_number: pr.number, per_page: 100 });
  return events.filter(({ event, label }) => ['labeled', 'unlabeled'].includes(event) && label.name === OWNER_REVIEWED_LABEL.name);
}

async function ownerReviewed({ github, context, pr }) {
  if (!(pr.labels ?? []).some(({ name }) => name === OWNER_REVIEWED_LABEL.name)) return false;
  const last = (await ownerLabelEvents(github, context, pr)).at(-1);
  if (last?.event !== 'labeled' || last.actor?.login.toLowerCase() !== context.repo.owner.toLowerCase()) return false;
  const pushedAt = await headPushedAt(github, pr);
  return pushedAt !== undefined && Date.parse(last.created_at) > pushedAt;
}

/** Returns [state, description, owners to ask, reviews, min-reviews applied]: the owners only when the gate or min-reviews should request them. */
async function evaluate({ github, context, pr }) {
  const { owner, repo } = context.repo;
  if (isSafeBotPr(pr)) {
    return ['success', 'Bot PR needs no code owner review', []];
  }
  const author = pr.user.login.toLowerCase();
  const repoOwner = owner.toLowerCase();
  const reviewed = await ownerReviewed({ github, context, pr });
  const waived = new Set([author, ...(reviewed ? [repoOwner] : [])]);
  const files = await github.paginate(github.rest.pulls.listFiles, { owner, repo, pull_number: pr.number, per_page: 100 });
  const reviews = await github.paginate(github.rest.pulls.listReviews, { owner, repo, pull_number: pr.number, per_page: 100 });
  const verdict = await copilotVerdict({ github, context, pr, reviews });
  const paths = files.flatMap(({ filename, previous_filename }) => [filename, previous_filename].filter(Boolean));
  if (['commented', 'never'].includes(verdict) && paths.length) {
    const extraRules = parseCodeOwners(process.env.REVIEW_OWNERS ?? '', repoOwner);
    const needed = [...new Set([repoOwner, ...paths.flatMap((path) => ownersOf(extraRules, path) ?? [])])].filter((login) => !waived.has(login));
    if (!needed.length) {
      return ['success', reviewed ? OWNER_REVIEWED : 'No owner review needed', [], reviews];
    }
    const count = Math.max(1, minReviews(pr.labels ?? []));
    return [...ownerVerdict(reviews, [repoOwner, ...needed], author, count > 1 ? `Needs ${count} owner approvals` : 'Needs an owner approval', count, needed), needed, reviews, true];
  }
  const rules = await readCodeOwners(github, context.repo, pr.base.ref);
  const needsReview = (path) => (ownersOf(rules, path) ?? [repoOwner]).some((handle) => !waived.has(handle));
  if (!files.some(({ filename, previous_filename }) => [filename, previous_filename].some((path) => path && needsReview(path)))) {
    return ['success', reviewed ? OWNER_REVIEWED : 'No code owner review needed', []];
  }
  const owners = (reviewed ? [...new Set(paths.flatMap((path) => ownersOf(rules, path) ?? [repoOwner]))] : [repoOwner]).filter((login) => !waived.has(login));
  const result = ownerVerdict(reviews, new Set([repoOwner, ...rules.flatMap((rule) => rule.owners)]), author, 'Needs a code owner approval', 1, reviewed ? owners : undefined);
  if (result[0] === 'pending' && result[1] !== CHANGES_REQUESTED && verdict === 'approved' && (await isCollaborator({ github, context, pr }))) {
    return ['success', 'Approved by Copilot on a collaborator PR', owners, reviews];
  }
  return [...result, owners, reviews];
}

function ownerVerdict(reviews, owners, author, waiting, count = 1, required = owners) {
  const allowed = new Set(owners);
  const states = [...latestReviewStates(reviews)].filter(([login]) => allowed.has(login) && login !== author);
  if (states.some(([, state]) => state === 'CHANGES_REQUESTED')) {
    return ['pending', CHANGES_REQUESTED];
  }
  const approved = states.filter(([, state]) => state === 'APPROVED').map(([login]) => login);
  return approved.length >= count && approved.some((login) => [...required].includes(login)) ? ['success', 'Approved by a code owner'] : ['pending', waiting];
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

async function gate({ github, context, core, delay }) {
  const pr = await findPullRequest(github, context);
  if (!pr) {
    return;
  }
  let result;
  try {
    await syncOwnerReview({ github, context, core });
    const hold = isSafeBotPr(pr) ? [] : await copilotHold({ github, context, pr, delay, setPending: (description) => setStatus(github, context, pr, 'pending', description) });
    if (hold?.length) {
      await setStatus(github, context, pr, ...hold);
    }
    if (!hold || hold.length) {
      return;
    }
    result = await setReviewStatus({ github, context, pr });
  } catch (error) {
    await setStatus(github, context, pr, 'error', 'Code owner review check failed to run');
    throw error;
  }
  const [state, description] = result;
  await syncPendingLabel({ github, context, core, pr, state, description });
  if (state === 'pending') {
    await requestOwners({ github, context, pr, owners: result[2], reviews: result[3] });
  }
}

async function syncPendingLabel({ github, context, core, pr, state, description }) {
  const { data: current } = await github.rest.pulls.get({ ...context.repo, pull_number: pr.number });
  if (current.head.sha !== pr.head.sha) {
    return false;
  }
  const names = current.labels.map(({ name }) => name);
  const active = state === 'pending' && description !== CHANGES_REQUESTED;
  if (active && !names.includes(PENDING_APPROVAL_LABEL.name)) {
    await ensureLabel(github, core, context.repo, OWNER_REVIEWED_LABEL);
  }
  await syncLabel({ github, core, target: { ...context.repo, issue_number: pr.number }, names, label: PENDING_APPROVAL_LABEL, active });
  return true;
}

async function setReviewStatus({ github, context, pr }) {
  const result = await evaluate({ github, context, pr });
  const status = (result[0] === 'success' && !result[4] ? await evaluateMinReviews({ github, context, pr }) : null) ?? result.slice(0, 2);
  await setStatus(github, context, pr, ...status);
  return [...status, result[2], result[3]];
}

async function recover({ github, context, core }) {
  const prs = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', per_page: 100 });
  for (const pr of prs) {
    if (pr.draft) {
      continue;
    }
    try {
      const { data: { statuses } } = await github.rest.repos.getCombinedStatusForRef({ ...context.repo, ref: pr.head.sha });
      const status = statuses.find(({ context }) => context === STATUS_CONTEXT);
      if (await copilotWaitAnswered({ github, context, pr, status })) {
        const [state, description, owners, reviews] = await setReviewStatus({ github, context, pr });
        if ((await syncPendingLabel({ github, context, core, pr, state, description })) && state === 'pending') {
          await requestOwners({ github, context, pr, owners, reviews });
        }
      }
    } catch (error) {
      core.warning(`Failed to refresh ${STATUS_CONTEXT} on #${pr.number}: ${error.message}`);
    }
  }
}

module.exports = { gate, setStatus, recover };
