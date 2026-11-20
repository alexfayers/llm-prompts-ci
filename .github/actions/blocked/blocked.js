const BLOCKED = 'blocked';
const REASON_PREFIX = `${BLOCKED}:`;

function isBlockedLabel(name) {
  return name === BLOCKED || (name.startsWith(REASON_PREFIX) && name.slice(REASON_PREFIX.length).trim() !== '');
}

function report({ context, core, failWhenBlocked = false }) {
  const blocking = (context.payload.pull_request?.labels ?? []).map(({ name }) => name).filter(isBlockedLabel);
  core.setOutput('blocked', String(blocking.length > 0));
  if (failWhenBlocked && blocking.length > 0) {
    core.setFailed(`Blocked by labels: ${blocking.join(', ')}`);
  }
}

module.exports = { report, isBlockedLabel, REASON_PREFIX };
