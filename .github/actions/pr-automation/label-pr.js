const { findPullRequest, findPr, writerReviews, changesRequested, hasReviewRequirements } = require('./sync-project-status.js');
const { isBlockedLabel, REASON_PREFIX } = require('../blocked/blocked.js');

const BLOCKED_LABEL = { name: 'blocked', color: 'd73a4a', description: 'Open dependencies or changes requested' };
const blockedLabel = (reason, description) => ({ name: `${REASON_PREFIX}${reason}`, color: BLOCKED_LABEL.color, description });
const CHANGES_REQUESTED_LABEL = blockedLabel('changes-requested', 'A reviewer requested changes');
const PENDING_APPROVAL_LABEL = { name: 'pending:approval', color: 'fbca04', description: 'Waiting for a required approval' };
const AUTO_REBASE_LABEL = { name: 'auto-rebase', color: '0e8a16', description: 'Rebased automatically when the base branch moves' };

const BOT_LOGIN = 'github-actions[bot]';

const RENOVATE_LOGIN = /^(app\/)?renovate(\[bot\])?$/;

const isRenovate = (login) => RENOVATE_LOGIN.test(login);

const CONVENTIONAL_PREFIX = /^(\w+)(\([^)]*\))?(!)?:\s/;

function hasBreakingChange(title, body) {
  const match = CONVENTIONAL_PREFIX.exec(title);
  if (match && match[3] === '!') {
    return true;
  }
  return /BREAKING[- ]CHANGE/.test(body || '');
}

async function removeLabel(github, core, target, name) {
  try {
    await github.rest.issues.removeLabel({ ...target, name });
  } catch (error) {
    core.warning(`Failed to remove label "${name}": ${error.message}`);
  }
}

async function addLabels(github, core, target, labels) {
  try {
    await github.rest.issues.addLabels({ ...target, labels });
  } catch (error) {
    core.warning(`Failed to add labels [${labels.join(', ')}]: ${error.message}`);
  }
}

async function ensureLabel(github, core, { owner, repo }, { name, color, description }) {
  try {
    await github.rest.issues.createLabel({ owner, repo, name, color, description });
  } catch (error) {
    if (error.status !== 422) {
      core.warning(`Failed to create label "${name}": ${error.message}`);
    }
  }
}

async function labelledByBot(github, target, name) {
  const events = await github.paginate(github.rest.issues.listEvents, { ...target, per_page: 100 });
  return events.findLast(({ event, label }) => event === 'labeled' && label.name === name)?.actor.login === BOT_LOGIN;
}

async function syncLabel({ github, removeClient = github, core, target, names, label, active }) {
  const labelled = names.includes(label.name);
  if (active && !labelled) {
    await ensureLabel(github, core, target, label);
    await addLabels(github, core, target, [label.name]);
  } else if (!active && labelled && await labelledByBot(github, target, label.name)) {
    await removeLabel(removeClient, core, target, label.name);
  }
}

async function label({ github, context, core }) {
  const pr = context.payload.pull_request;
  if (!hasBreakingChange(pr.title, pr.body)) {
    return;
  }

  await addLabels(github, core, { ...context.repo, issue_number: pr.number }, ['breaking']);
}

async function labelBlocked({ github, removeClient = github, context, core }) {
  const pr = await findPr(github, context, core);
  if (!pr || pr.state !== 'OPEN') {
    return;
  }
  const names = pr.labels.nodes.map(({ name }) => name);
  await syncLabel({ github, removeClient, core, target: { ...context.repo, issue_number: pr.number }, names, label: CHANGES_REQUESTED_LABEL, active: changesRequested(pr, writerReviews(pr)) });
}

async function labelAutoRebase({ github, context, core }) {
  const found = await findPullRequest(github, context);
  if (!found) {
    return;
  }
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: found.number });
  const approved = await hasReviewRequirements(github, context.repo, pr.head.sha);
  const names = pr.labels.map(({ name }) => name);
  if (isRenovate(pr.user.login) || !approved || pr.draft || !pr.auto_merge || names.some(isBlockedLabel) || names.includes(AUTO_REBASE_LABEL.name)) {
    return;
  }
  await ensureLabel(github, core, context.repo, AUTO_REBASE_LABEL);
  await addLabels(github, core, { ...context.repo, issue_number: pr.number }, [AUTO_REBASE_LABEL.name]);
  core.setOutput('labelled', 'true');
}

module.exports = { isRenovate, hasBreakingChange, label, labelBlocked, labelAutoRebase, ensureLabel, addLabels, removeLabel, labelledByBot, blockedLabel, syncLabel, BLOCKED_LABEL, PENDING_APPROVAL_LABEL, AUTO_REBASE_LABEL };
