const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { gate, recover } = require('./codeowner-review.js');

process.env.REVIEW_OWNERS = '/prompts/ @alice bob';

const CODEOWNERS = '*.md @Owner\n/src/*/prompts/**/rules/ @Owner @friend\n/src/*/prompts/**/skills/ @Owner @friend\n/src/*/prompts/**/skills/pi-help/ @Owner\n/src/*/prompts/**/rules/hooks*.md @Owner\na**b/ @friend\na?c @friend\n';

const COPILOT_NO_COMMENTS = ['copilot-pull-request-reviewer[bot]', 'COMMENTED', true];

function fixture({ author, files, reviews = [], labels = [], branch = 'feature', requested = [], draft = false, permission = 'none', codeowners = CODEOWNERS, events = [], suites = [], createdAt = '2020-01-01T00:00:00Z', copilotComments = [], eventName = 'pull_request_target', copilotApproved = true, labelEvents = [] }) {
  reviews = [...(copilotApproved ? [COPILOT_NO_COMMENTS] : []), ...reviews];
  const calls = [];
  const labelCalls = [];
  const requests = [];
  const warnings = [];
  const live = { number: 7, node_id: 'n7', user: { login: author }, labels: labels.map((name) => ({ name })), draft, created_at: createdAt, requested_reviewers: requested.map((login) => ({ login })), requested_teams: [], head: { sha: 'abc', ref: branch }, base: { ref: 'main' } };
  const github = {
    paginate: async (method) => method.items,
    rest: {
      pulls: { listFiles: { items: files.map((file) => (typeof file === 'string' ? { filename: file } : file)) }, listReviews: { items: reviews.map(([login, state, copilot, commit_id = 'abc', body = ''], id) => ({ id, user: { login }, state, is_copilot_code_review: copilot, commit_id, body })) }, listCommentsForReview: { items: copilotComments }, requestReviewers: async ({ pull_number, reviewers }) => requests.push([pull_number, reviewers]), get: async () => ({ data: structuredClone(live) }) },
      checks: { listSuitesForRef: { items: suites.map((created_at) => ({ created_at })) } },
      repos: {
        getContent: async ({ path, ref }) => {
          if (codeowners === null) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { content: Buffer.from(codeowners).toString('base64'), path, ref } };
        },
        createCommitStatus: async ({ sha, context, state }) => calls.push([sha, context, state]),
        getCollaboratorPermissionLevel: async () => ({ data: { permission } }),
      },
      issues: {
        createLabel: async ({ name }) => labelCalls.push(['createLabel', name]),
        addLabels: async ({ labels }) => labelCalls.push(['addLabels', labels]),
        removeLabel: async ({ name }) => labelCalls.push(['removeLabel', name]),
        listEvents: { items: labelEvents.map(([name, login]) => ({ event: 'labeled', label: { name }, actor: { login } })) },
        listEventsForTimeline: { items: events.map(([event, login, created_at]) => ({ event, [event === 'reviewed' ? 'user' : 'requested_reviewer']: { login }, created_at })) } },
    },
  };
  const context = { eventName, repo: { owner: 'owner', repo: 'r' }, payload: { pull_request: structuredClone(live) } };
  return { github, context, core: { warning: (message) => warnings.push(message) }, calls, labelCalls, requests, warnings, live };
}

function scheduled(options = {}) {
  const f = fixture({ author: 'owner', files: ['src/llm_prompts/cli.py'], eventName: 'schedule', ...options });
  f.github.rest.pulls.list = { items: [structuredClone(f.live)] };
  f.github.rest.repos.getCombinedStatusForRef = async () => ({ data: { statuses: [{ context: 'codeowner-review', state: 'pending', description: 'Waiting for the requested Copilot review' }] } });
  f.github.rest.repos.createCommitStatus = async ({ sha, context, state, description }) => f.calls.push([sha, context, state, description]);
  return f;
}

test('scheduled recovery refreshes an answered Copilot wait without requesting reviews', async () => {
  const f = scheduled();
  await recover(f);
  assert.deepEqual(f.calls, [['abc', 'codeowner-review', 'success', 'No code owner review needed']]);
  assert.deepEqual(f.requests, []);
});

test('scheduled recovery refreshes a wait Copilot answered on an older head', async () => {
  const f = scheduled({ copilotApproved: false, reviews: [['copilot-pull-request-reviewer[bot]', 'APPROVED', true, 'old']], events: [['review_requested', 'Copilot'], ['reviewed', 'Copilot']] });
  await recover(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'success', 'No code owner review needed']], []]);
});

test('scheduled recovery leaves unanswered waits and other statuses unchanged', async () => {
  for (const [name, options, change = () => {}] of [
    ['old head review with a newer request', { copilotApproved: false, reviews: [['copilot', 'APPROVED', true, 'old']], events: [['reviewed', 'Copilot'], ['review_requested', 'Copilot']] }],
    ['no review', { copilotApproved: false }],
    ['draft', { draft: true }],
    ['owner wait', {}, (f) => (f.github.rest.repos.getCombinedStatusForRef = async () => ({ data: { statuses: [{ context: 'codeowner-review', state: 'pending', description: 'Needs a code owner approval' }] } }))],
    ['non-pending status', {}, (f) => (f.github.rest.repos.getCombinedStatusForRef = async () => ({ data: { statuses: [{ context: 'codeowner-review', state: 'error', description: 'Waiting for the requested Copilot review' }] } }))],
    ['no status', {}, (f) => (f.github.rest.repos.getCombinedStatusForRef = async () => ({ data: { statuses: [] } }))],
  ]) {
    const f = scheduled(options);
    change(f);
    await recover(f);
    assert.deepEqual(f.calls, [], name);
    assert.deepEqual(f.labelCalls, [], name);
    assert.deepEqual(f.requests, [], name);
  }
});

test('scheduled recovery labels an owner approval wait and asks the needed owners', async () => {
  const f = scheduled({ author: 'stranger', files: [OWNED_FILE], copilotComments: [{ id: 1 }] });
  await recover(f);
  assert.deepEqual(f.calls, [['abc', 'codeowner-review', 'pending', 'Needs an owner approval']]);
  assert.deepEqual(f.labelCalls, [['createLabel', 'pending:approval'], ['addLabels', ['pending:approval']]]);
  assert.deepEqual(f.requests, [[7, ['owner', 'alice', 'bob']]]);
});

test('scheduled recovery writes only the listed head and skips labels after a push', async () => {
  const f = scheduled({ author: 'stranger', files: [OWNED_FILE], copilotComments: [{ id: 1 }] });
  f.live.head.sha = 'def';
  await recover(f);
  assert.deepEqual(f.calls, [['abc', 'codeowner-review', 'pending', 'Needs an owner approval']]);
  assert.deepEqual(f.labelCalls, []);
  assert.deepEqual(f.requests, []);
});

test('scheduled recovery warns on a PR failure and refreshes later PRs without an error status', async () => {
  for (const method of ['getCombinedStatusForRef', 'createCommitStatus']) {
    const f = scheduled();
    const next = structuredClone(f.live);
    next.number = 8;
    next.head.sha = 'def';
    f.github.rest.pulls.list.items.push(next);
    f.github.rest.pulls.listReviews.items.push({ ...f.github.rest.pulls.listReviews.items[0], commit_id: 'def' });
    const original = f.github.rest.repos[method];
    f.github.rest.repos[method] = async (args) => {
      if ((args.ref ?? args.sha) === 'abc') throw new Error('boom');
      return original(args);
    };
    await recover(f);
    assert.deepEqual(f.warnings, ['Failed to refresh codeowner-review on #7: boom'], method);
    assert.deepEqual(f.calls, [['def', 'codeowner-review', 'success', 'No code owner review needed']], method);
    assert.deepEqual(f.requests, [], method);
  }
});

const PROMPT_FILE = 'src/llm_prompts/prompts/shared/rules/a.md';
const OWNED_FILE = 'prompts/a.md';
const check = (state, files) => async () => {
  for (const file of files) {
    const f = fixture({ author: 'Owner', files: [].concat(file) });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], JSON.stringify(file));
  }
};

test('owner change outside prompts succeeds without review', async () => {
  const { github, context, calls } = fixture({ author: 'owner', files: ['src/llm_prompts/cli.py', 'src/llm_prompts/prompts/pi/extensions/x.ts'] });
  await gate({ github, context });
  assert.deepEqual(calls, [['abc', 'codeowner-review', 'success']]);
});

test('owner prompt change waits for another code owner to approve', async () => {
  const waiting = fixture({ author: 'owner', files: [PROMPT_FILE], reviews: [['owner', 'APPROVED']] });
  await gate(waiting);
  assert.deepEqual(waiting.calls, [['abc', 'codeowner-review', 'pending']]);

  const approved = fixture({ author: 'owner', files: [PROMPT_FILE], reviews: [['Friend', 'APPROVED']] });
  await gate(approved);
  assert.deepEqual(approved.calls, [['abc', 'codeowner-review', 'success']]);
});

test('the pending approval label follows an approval wait', async () => {
  const bot = [['pending:approval', 'github-actions[bot]']];
  const pending = ['pending:approval'];
  for (const [name, options, expected, change = () => {}] of [
    ['approval wait', { reviews: [['owner', 'APPROVED']] }, [['createLabel', 'pending:approval'], ['addLabels', pending]]],
    ['approved', { reviews: [['Friend', 'APPROVED']], labels: pending, labelEvents: bot }, [['removeLabel', 'pending:approval']]],
    ['approved with a label a person added', { reviews: [['Friend', 'APPROVED']], labels: pending, labelEvents: [['pending:approval', 'someone']] }, []],
    ['owner changes requested', { reviews: [['Friend', 'CHANGES_REQUESTED']], labels: pending, labelEvents: bot }, [['removeLabel', 'pending:approval']]],
    ['moved head', { reviews: [['owner', 'APPROVED']] }, [], (live) => (live.head.sha = 'def')],
  ]) {
    const f = fixture({ author: 'owner', files: [PROMPT_FILE], ...options });
    change(f.live);
    await gate(f);
    assert.deepEqual(f.labelCalls, expected, name);
  }
  const held = fixture({ author: 'owner', files: ['src/llm_prompts/cli.py'], copilotApproved: false, requested: ['Copilot'], labels: pending, labelEvents: bot });
  await gate(held);
  assert.deepEqual([held.calls, held.labelCalls], [[['abc', 'codeowner-review', 'pending']], []]);
});

test('exempt and unmatched files need no review', check('success', [
  'src/llm_prompts/prompts/pi/skills/pi-help/SKILL.md', 'src/llm_prompts/prompts/pi/skills/pi-help/a/b.md', 'src/llm_prompts/prompts/kiro/rules/hooks-kiro.md', 'src/llm_prompts/prompts/shared/rules/hooks-llm-prompts.md', 'src/llm_prompts/cli.py', 'a/x/b/f', 'a/c',
]));

test('a mixed change, a rename from a covered path or any file under another owner needs review', check('pending', [
  ['src/llm_prompts/prompts/pi/skills/pi-help/SKILL.md', PROMPT_FILE], { filename: 'x.py', previous_filename: PROMPT_FILE }, 'src/llm_prompts/prompts/pi/skills/pi-help-x/a.md', 'src/llm_prompts/prompts/shared/rules/nothooks.md', 'axyb/f', 'abc',
]));

test('other author needs a code owner approval even outside prompts', async () => {
  const stranger = fixture({ author: 'stranger', files: ['README.md'], reviews: [['bystander', 'APPROVED']] });
  await gate(stranger);
  assert.deepEqual(stranger.calls, [['abc', 'codeowner-review', 'pending']]);

  const approved = fixture({ author: 'stranger', files: ['README.md'], reviews: [['owner', 'APPROVED']] });
  await gate(approved);
  assert.deepEqual(approved.calls, [['abc', 'codeowner-review', 'success']]);
});

test('files no CODEOWNERS rule matches belong to the repo owner', async () => {
  for (const [author, reviews, state] of [
    ['owner', [], 'success'],
    ['stranger', [], 'pending'],
    ['stranger', [['bystander', 'APPROVED']], 'pending'],
    ['stranger', [['Owner', 'APPROVED']], 'success'],
  ]) {
    const f = fixture({ author, files: ['src/llm_prompts/cli.py'], reviews });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], `${author} ${JSON.stringify(reviews)}`);
  }
});

test('a CODEOWNERS rule with only team or email owners belongs to the repo owner', async () => {
  for (const [author, reviews, state] of [
    ['owner', [], 'success'],
    ['friend', [], 'pending'],
    ['friend', [['owner', 'APPROVED']], 'success'],
  ]) {
    for (const file of ['team/x', 'mail/x']) {
      const f = fixture({ author, files: [file], reviews, codeowners: '* @friend\nteam/ @org/team\nmail/ a@b.c\n' });
      await gate(f);
      assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], `${author} ${file} ${JSON.stringify(reviews)}`);
    }
  }
});

test('a CODEOWNERS rule mixing a login with a team owner also belongs to the repo owner', async () => {
  for (const [reviews, state] of [
    [[], 'pending'],
    [[['owner', 'APPROVED']], 'success'],
  ]) {
    const f = fixture({ author: 'friend', files: ['mixed/x'], reviews, codeowners: 'mixed/ @friend @org/team\n' });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], JSON.stringify(reviews));
  }
});

test('a missing CODEOWNERS file leaves every file to the repo owner', async () => {
  for (const [author, reviews, state] of [
    ['owner', [], 'success'],
    ['stranger', [], 'pending'],
    ['stranger', [['owner', 'APPROVED']], 'success'],
  ]) {
    const f = fixture({ author, files: ['src/llm_prompts/cli.py'], reviews, codeowners: null });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], `${author} ${JSON.stringify(reviews)}`);
  }
});

test('the repo owner is asked to review only when the gate waits on his approval and he has not reviewed', async () => {
  for (const [name, options, reviewers] of [
    ['stranger PR', { author: 'stranger' }, ['owner']],
    ['major renovate PR', { author: 'renovate[bot]', branch: 'renovate/major-updates', labels: ['needs-review'] }, ['owner']],
    ['pi-extensions renovate PR', { author: 'renovate[bot]', branch: 'renovate/pi-extensions' }, []],
    ['safe renovate PR', { author: 'renovate[bot]', branch: 'renovate/all-minor-patch' }, []],
    ['owner PR', { author: 'owner' }, []],
    ['owner PR waiting on min-reviews', { author: 'owner', labels: ['min-reviews:1'] }, []],
    ['approved PR', { author: 'stranger', reviews: [['owner', 'APPROVED']] }, []],
    ['approved PR waiting on min-reviews', { author: 'stranger', reviews: [['owner', 'APPROVED']], labels: ['min-reviews:2'] }, []],
    ['someone else requested', { author: 'stranger', requested: ['friend'] }, ['owner']],
    ['already requested', { author: 'stranger', requested: ['Owner'] }, []],
    ['draft PR', { author: 'stranger', draft: true }, []],
    ['owner already commented', { author: 'stranger', reviews: [['Owner', 'COMMENTED']] }, []],
    ['owner already requested changes', { author: 'stranger', reviews: [['owner', 'CHANGES_REQUESTED']] }, []],
    ['someone else reviewed', { author: 'stranger', reviews: [['friend', 'COMMENTED']] }, ['owner']],
  ]) {
    const f = fixture({ files: ['README.md'], ...options });
    await gate(f);
    assert.deepEqual(f.requests, reviewers.length ? [[7, reviewers]] : [], name);
  }
});

test('bot PRs pass without review only from known-safe branches', async () => {
  for (const [author, branch, labels, reviews, state] of [
    ['renovate[bot]', 'renovate/all-minor-patch', [], [], 'success'],
    ['renovate[bot]', 'renovate/github-actions', [], [], 'success'],
    ['renovate[bot]', 'renovate/lock-file-maintenance', ['ci'], [], 'success'],
    ['renovate[bot]', 'renovate/pi-extensions', [], [], 'success'],
    ['renovate[bot]', 'renovate/major-updates', ['needs-review'], [], 'pending'],
    ['renovate[bot]', 'renovate/major-updates', [], [['owner', 'APPROVED']], 'success'],
    ['renovate[bot]', 'renovate/all-minor-patch-2', [], [], 'pending'],
    ['renovate[bot]', 'feature/all-minor-patch', [], [], 'pending'],
    ['dependabot[bot]', 'renovate/all-minor-patch', [], [], 'pending'],
    ['stranger', 'renovate/all-minor-patch', [], [], 'pending'],
    ['alexfayers-auto-cd[bot]', 'bot/shared-files', [], [], 'success'],
    ['alexfayers-auto-cd[bot]', 'bot/other', [], [], 'pending'],
    ['renovate[bot]', 'bot/shared-files', [], [], 'pending'],
    ['constructor', 'bot/shared-files', [], [], 'pending'],
  ]) {
    const f = fixture({ author, files: ['README.md'], labels, reviews, branch });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], `${author} ${branch} ${labels} ${JSON.stringify(reviews)}`);
  }
});

test('requested changes keep the status pending until the review is dismissed', async () => {
  const blocked = fixture({ author: 'stranger', files: ['README.md'], reviews: [['owner', 'APPROVED'], ['friend', 'CHANGES_REQUESTED']] });
  await gate(blocked);
  assert.deepEqual(blocked.calls, [['abc', 'codeowner-review', 'pending']]);

  const dismissed = fixture({ author: 'stranger', files: ['README.md'], reviews: [['owner', 'APPROVED'], ['friend', 'CHANGES_REQUESTED'], ['friend', 'DISMISSED']] });
  await gate(dismissed);
  assert.deepEqual(dismissed.calls, [['abc', 'codeowner-review', 'success']]);
});

test('a min-reviews label needs that many approvals from anyone but the author', async () => {
  const owner = ['owner', 'APPROVED'];
  for (const [reviews, labels, state] of [
    [[owner], ['min-reviews:2'], 'pending'],
    [[owner, ['stranger', 'APPROVED']], ['min-reviews:2'], 'pending'],
    [[owner, ['alice', 'APPROVED']], ['min-reviews:2'], 'success'],
    [[owner, ['alice', 'APPROVED'], ['alice', 'CHANGES_REQUESTED']], ['min-reviews:2'], 'pending'],
    [[owner, ['alice', 'APPROVED']], ['min-reviews:1'], 'success'],
    [[owner], [], 'success'],
  ]) {
    const f = fixture({ author: 'stranger', files: ['README.md'], reviews, labels });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], JSON.stringify([reviews, labels]));
  }
});

test('a Copilot code review approval does not count toward min-reviews', async () => {
  const copilot = ['copilot-pull-request-reviewer[bot]', 'APPROVED', true];
  for (const [reviews, state] of [
    [[['owner', 'APPROVED'], copilot], 'pending'],
    [[['owner', 'APPROVED'], copilot, ['alice', 'APPROVED']], 'success'],
  ]) {
    const f = fixture({ author: 'stranger', files: ['README.md'], reviews, labels: ['min-reviews:2'] });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], JSON.stringify(reviews));
  }
});

test('a Copilot approval stands in for a code owner only on a PR by a collaborator with write access', async () => {
  const copilot = ['copilot-pull-request-reviewer[bot]', 'APPROVED', true];
  for (const [permission, reviews, state] of [
    ['write', [copilot], 'success'],
    ['admin', [copilot], 'success'],
    ['read', [copilot], 'pending'],
    ['none', [copilot], 'pending'],
    ['write', [copilot, ['owner', 'CHANGES_REQUESTED']], 'pending'],
  ]) {
    const f = fixture({ author: 'stranger', files: ['README.md'], reviews, permission });
    await gate(f);
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], JSON.stringify([permission, reviews]));
  }
});

test('an API error sets the error status and still fails', async () => {
  const { github, context, calls } = fixture({ author: 'stranger', files: [] });
  github.paginate = async () => { throw new Error('boom'); };
  await assert.rejects(gate({ github, context }), /boom/);
  assert.deepEqual(calls, [['abc', 'codeowner-review', 'error']]);
});

test('a review relay run finds its PR by head sha', async () => {
  const { github, context, calls } = fixture({ author: 'owner', files: ['src/llm_prompts/cli.py'] });
  const pr = { ...context.payload.pull_request, head: { sha: 'abc', ref: 'fix', repo: { full_name: 'fork/r' } } };
  github.rest.pulls.list = { items: [{ ...pr, head: { ...pr.head, sha: 'other' } }, pr] };
  context.payload = { workflow_run: { head_sha: 'abc', head_branch: 'fix', head_repository: { full_name: 'fork/r' } } };
  await gate({ github, context });
  assert.deepEqual(calls, [['abc', 'codeowner-review', 'success']]);

  context.payload.workflow_run.head_sha = 'gone';
  await gate({ github, context });
  assert.equal(calls.length, 1);
});

const COPILOT_COMMENTED = { reviews: [['copilot-pull-request-reviewer[bot]', 'COMMENTED', true]], copilotComments: [{ id: 1 }] };

test('a PR Copilot commented on, resolved or not, waits for and asks one needed owner, whoever the author is', async () => {
  for (const [author, files, reviews, state, requested] of [
    ['alice', [OWNED_FILE], [], 'pending', ['owner', 'bob']],
    ['alice', [OWNED_FILE], [['bob', 'APPROVED']], 'success', []],
    ['alice', ['src/llm_prompts/cli.py'], [['bob', 'APPROVED']], 'pending', ['owner']],
    ['owner', [OWNED_FILE], [['owner', 'APPROVED']], 'pending', ['alice', 'bob']],
    ['owner', [OWNED_FILE], [['alice', 'APPROVED'], ['bob', 'CHANGES_REQUESTED']], 'pending', []],
    ['owner', ['src/llm_prompts/cli.py'], [], 'success', []],
  ]) {
    const f = fixture({ author, files, ...COPILOT_COMMENTED, reviews: [...COPILOT_COMMENTED.reviews, ...reviews], permission: 'write' });
    await gate(f);
    const name = `${author} ${files} ${JSON.stringify(reviews)}`;
    assert.deepEqual(f.calls, [['abc', 'codeowner-review', state]], name);
    assert.deepEqual(f.requests, requested.length ? [[7, requested]] : [], name);
  }
});

test('a commented PR with no needed owner succeeds without asking anyone', async () => {
  const f = fixture({ author: 'owner', files: ['abc'], ...COPILOT_COMMENTED });
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'success']], []]);
});

test('a PR Copilot was never asked to review waits for and asks a needed owner', async () => {
  for (const [eventName, reviews, state, requested] of [
    ['pull_request_target', [], 'pending', ['owner']],
    ['workflow_run', [], 'pending', ['owner']],
    ['workflow_run', [['owner', 'APPROVED']], 'success', []],
  ]) {
    const f = fixture({ author: 'alice', files: ['src/llm_prompts/cli.py'], reviews, eventName, copilotApproved: false });
    await gate(f);
    assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', state]], requested.length ? [[7, requested]] : []], eventName);
  }
});

test('a min-reviews label raises the owner approvals a commented PR needs and asks the remaining owner', async () => {
  for (const [reviews, state, requested] of [[[['alice', 'APPROVED']], 'pending', ['bob']], [[['alice', 'APPROVED'], ['stranger', 'APPROVED']], 'pending', ['bob']], [[['alice', 'APPROVED'], ['bob', 'APPROVED']], 'success', []]]) {
    const f = fixture({ author: 'owner', files: [OWNED_FILE], ...COPILOT_COMMENTED, reviews: [...COPILOT_COMMENTED.reviews, ...reviews], labels: ['min-reviews:2'] });
    await gate(f);
    assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', state]], requested.length ? [[7, requested]] : []], JSON.stringify(reviews));
  }
});

test('the last review-owners line matching a changed path names its owners', async () => {
  const saved = process.env.REVIEW_OWNERS;
  process.env.REVIEW_OWNERS = `${saved}\n\n/docs/ Carol owner\n/docs/a* @dave carol\n/docs/private/\n/docs/c* @org/team erin@example.com frank\n`;
  try {
    for (const [author, files, requested] of [
      ['stranger', ['docs/a.md'], ['owner', 'dave', 'carol']],
      ['carol', ['docs/b.md'], ['owner']],
      ['stranger', ['docs/private/a.md'], ['owner']],
      ['stranger', ['docs/c.md'], ['owner', 'frank']],
      ['stranger', ['README.md'], ['owner']],
      ['stranger', [OWNED_FILE, 'docs/b.md'], ['owner', 'alice', 'bob', 'carol']],
    ]) {
      const f = fixture({ author, files, ...COPILOT_COMMENTED });
      await gate(f);
      assert.deepEqual(f.requests, [[7, requested]], `${author} ${files}`);
    }
  } finally {
    process.env.REVIEW_OWNERS = saved;
  }
});

test('the default review-owners names the prompt owners for shared rules, skills, workflows and agents, but not pi or hooks paths', async () => {
  const saved = process.env.REVIEW_OWNERS;
  const lines = fs.readFileSync(path.join(__dirname, '../../workflows/pr-automation.yml'), 'utf8').split('\n');
  const indent = (line) => line.search(/\S/);
  const start = lines.findIndex((line, i) => line.trim() === 'default: |' && lines[lines.findLastIndex((l, j) => j < i && indent(l) < indent(line))].trim() === 'review-owners:');
  const end = lines.findIndex((line, i) => i > start && line.trim() && indent(line) <= indent(lines[start]));
  process.env.REVIEW_OWNERS = lines.slice(start + 1, end).join('\n');
  try {
    for (const [file, matches] of [
      ['src/a/prompts/shared/rules/x.md', true],
      ['src/a/prompts/pi/rules/x.md', false],
      ['src/a/prompts/pi/skills/pi-help/S.md', false],
      ['src/a/prompts/shared/rules/hooks-x.md', false],
      ['src/a/prompts/claude-code/agents/a.md', true],
      ['README.md', false],
    ]) {
      const f = fixture({ author: 'stranger', files: [file], ...COPILOT_COMMENTED });
      await gate(f);
      assert.deepEqual(f.requests, [[7, matches ? ['owner', 'codebeetl', 'unkokaeru'] : ['owner']]], file);
    }
  } finally {
    process.env.REVIEW_OWNERS = saved;
  }
});

test('an empty review-owners asks only the repo owner', async () => {
  const saved = process.env.REVIEW_OWNERS;
  process.env.REVIEW_OWNERS = '';
  try {
    const f = fixture({ author: 'alice', files: [OWNED_FILE], ...COPILOT_COMMENTED });
    await gate(f);
    assert.deepEqual(f.requests, [[7, ['owner']]]);
  } finally {
    process.env.REVIEW_OWNERS = saved;
  }
});

test('a Copilot review with no comments counts as an approval on a collaborator PR', async () => {
  const f = fixture({ author: 'alice', files: [PROMPT_FILE], reviews: [['copilot-pull-request-reviewer[bot]', 'COMMENTED', true]], permission: 'write' });
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'success']], []]);
});

test('a Copilot review whose findings are all low severity counts as an approval', async () => {
  const finding = (severity, id) => `- <img src="x.png" alt="${severity} severity" width="62"> [a](https://github.com/o/r/pull/7#discussion_r${id})`;
  for (const [name, body, ids, state, requests] of [
    ['low only', `<!-- ccr-overview-v2 -->\n${finding('Low', 1)}\n${finding('Low', 2)}`, [1, 2], 'success', []],
    ['a medium finding', `<!-- ccr-overview-v2 -->\n${finding('Low', 1)}\n${finding('Medium', 2)}`, [1, 2], 'pending', [[7, ['owner']]]],
    ['a multi-word label', `<!-- ccr-overview-v2 -->\n${finding('Low', 1)}\n${finding('Very high', 2)}`, [1, 2], 'pending', [[7, ['owner']]]],
    ['a comment missing from the body', `<!-- ccr-overview-v2 -->\n${finding('Low', 1)}`, [1, 2], 'pending', [[7, ['owner']]]],
    ['a comment id that only prefixes a listed id', `<!-- ccr-overview-v2 -->\n${finding('Low', 123)}`, [12], 'pending', [[7, ['owner']]]],
    ['a medium finding without inline comments', `<!-- ccr-overview-v2 -->\n${finding('Medium', 2)}`, [], 'pending', [[7, ['owner']]]],
    ['no markers', '<!-- ccr-overview-v2 -->\nLooks fine', [1], 'pending', [[7, ['owner']]]],
    ['no overview', finding('Low', 1), [1], 'pending', [[7, ['owner']]]],
  ]) {
    const f = fixture({ author: 'alice', files: ['src/llm_prompts/cli.py'], reviews: [['copilot-pull-request-reviewer[bot]', 'COMMENTED', true, 'abc', body]], copilotComments: ids.map((id) => ({ id })), copilotApproved: false, permission: 'write' });
    await gate(f);
    assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', state]], requests], name);
  }
});

test('a Copilot review requesting changes without inline comments is not an approval', async () => {
  const f = fixture({ author: 'alice', files: ['src/llm_prompts/cli.py'], reviews: [['copilot-pull-request-reviewer[bot]', 'CHANGES_REQUESTED', true]], permission: 'write' });
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'pending']], [[7, ['owner']]]]);
});

test('min-reviews ignores a Copilot review even without the Copilot flag', async () => {
  const f = fixture({ author: 'stranger', files: ['README.md'], reviews: [['owner', 'APPROVED'], ['copilot-pull-request-reviewer[bot]', 'APPROVED']], labels: ['min-reviews:2'] });
  await gate(f);
  assert.deepEqual(f.calls, [['abc', 'codeowner-review', 'pending']]);
});

test('a Copilot approval of an older commit stands in for the owners on a collaborator PR', async () => {
  for (const files of [['src/llm_prompts/cli.py'], [OWNED_FILE]]) {
    const f = fixture({ author: 'alice', files, reviews: [['copilot-pull-request-reviewer[bot]', 'APPROVED', true, 'old']], eventName: 'workflow_run', permission: 'write' });
    await gate(f);
    assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'success']], []], JSON.stringify(files));
  }
});

test('a later Copilot review that is not an approval outweighs its older approval', async () => {
  const finding = (severity) => `<!-- ccr-overview-v2 -->\n- <img src="x.png" alt="${severity} severity" width="62"> [a](https://github.com/o/r/pull/7#discussion_r1)`;
  for (const [state, severity] of [['COMMENTED', 'Medium'], ['DISMISSED', 'Low']]) {
    const f = fixture({ author: 'alice', files: ['src/llm_prompts/cli.py'], reviews: [['copilot-pull-request-reviewer[bot]', 'APPROVED', true, 'old'], ['copilot-pull-request-reviewer[bot]', state, true, 'old', finding(severity)]], copilotApproved: false, permission: 'write' });
    await gate(f);
    assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'pending']], [[7, ['owner']]]], state);
  }
});

test('a Copilot review requested again after an old-commit approval holds even the repo owner own PR', async () => {
  const f = fixture({ author: 'owner', files: ['src/llm_prompts/cli.py'], reviews: [['copilot-pull-request-reviewer[bot]', 'APPROVED', true, 'old']], requested: ['Copilot'], copilotApproved: false });
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'pending']], []]);
});

test('a Copilot-approved collaborator PR waiting on min-reviews asks the repo owner', async () => {
  const f = fixture({ author: 'alice', files: ['README.md'], labels: ['min-reviews:2'], permission: 'write' });
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'pending']], [[7, ['owner']]]]);
});

const COPILOT = 'copilot-pull-request-reviewer[bot]';
const copilotHold = (options) => fixture({ author: 'owner', files: ['src/llm_prompts/cli.py'], copilotApproved: false, ...options });
const expect = (state, options) => async () => {
  const f = copilotHold(options);
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', state]], []]);
};

test('passes when no Copilot review was requested', expect('success', { events: [['review_requested', 'owner']] }));
test('waits while Copilot is a requested reviewer', expect('pending', { requested: ['Copilot'] }));
test('waits after a Copilot review request the reviewer list no longer shows', expect('pending', { events: [['review_requested', 'Copilot']] }));
test('passes once the Copilot request was removed', expect('success', { events: [['review_requested', 'Copilot'], ['review_request_removed', 'Copilot']] }));
test('passes once Copilot has submitted a review', expect('success', { requested: ['Copilot'], reviews: [[COPILOT, 'COMMENTED', true]] }));
test('a human review does not count as the Copilot review', expect('pending', { events: [['review_requested', 'Copilot']], reviews: [['friend', 'COMMENTED']] }));
test('waits while the PR is a draft', expect('pending', { draft: true }));
test('a draft PR waits even when Copilot approved and the owner needs no review', expect('pending', { draft: true, copilotApproved: true }));
test('a stranger PR waiting for the requested Copilot review asks no owner', async () => {
  const f = copilotHold({ author: 'stranger', requested: ['Copilot'], eventName: 'workflow_run' });
  await gate(f);
  assert.deepEqual([f.calls, f.requests], [[['abc', 'codeowner-review', 'pending']], []]);
});

const ready = (requestOnCheck, states, options = { createdAt: new Date().toISOString() }, change = () => {}) => async () => {
  const f = copilotHold(options);
  let checks = 0;
  const delay = async () => {
    f.live.created_at = '2020-01-01T00:00:00Z';
    [...f.github.rest.issues.listEventsForTimeline.items, ...f.github.rest.checks.listSuitesForRef.items].forEach((item) => (item.created_at = '2020-01-01T00:00:00Z'));
    change(f.live);
    if (++checks === requestOnCheck) {
      f.github.rest.issues.listEventsForTimeline.items = [{ event: 'review_requested', requested_reviewer: { login: 'Copilot' } }];
    }
  };
  await gate({ ...f, delay });
  assert.deepEqual(f.calls.map(([, , state]) => state), states);
};

test('a ready PR waits for a Copilot review request that comes later', ready(2, ['pending', 'pending']));
test('a ready PR passes once no Copilot review request comes', ready(0, ['pending', 'success']));
test('a ready stranger PR waits for an owner once no Copilot review request comes', ready(0, ['pending', 'pending'], { author: 'stranger', createdAt: new Date().toISOString() }));
test('a run soon after the PR became ready waits out the rest of the window', ready(0, ['pending', 'success'], { events: [['ready_for_review', undefined, new Date().toISOString()]] }));
test('a run soon after the PR reopened waits out the rest of the window', ready(0, ['pending', 'success'], { events: [['ready_for_review', undefined, '2020-01-01T00:00:00Z'], ['reopened', undefined, new Date().toISOString()]] }));
test('a push to a PR ready for long waits for a Copilot review request on the new head', ready(0, ['pending', 'success'], { events: [['ready_for_review', undefined, '2020-01-01T00:00:00Z']], suites: [new Date().toISOString()] }));
test('a head first seen long ago passes without waiting', expect('success', { suites: ['2020-01-01T00:00:00Z', new Date().toISOString()] }));
const stale = { reviews: [[COPILOT, 'APPROVED', true, 'old']] };
test('a Copilot review answering an older request passes without requesting Copilot again', expect('success', { ...stale, events: [['review_requested', 'Copilot'], ['reviewed', 'Copilot']] }));
test('Copilot removed after an older review is not requested again', expect('success', { ...stale, events: [['review_requested', 'Copilot'], ['reviewed', 'Copilot'], ['review_request_removed', 'Copilot']] }));
test('a bot branch PR with an older Copilot review does not request Copilot', expect('success', { ...stale, author: 'renovate[bot]', branch: 'renovate/all-minor-patch' }));
test('a push after an older Copilot review waits out the request window first', ready(0, ['pending', 'success'], { ...stale, suites: [new Date().toISOString()] }));
test('a Copilot review request after its older review waits for the new review', expect('pending', { ...stale, events: [['review_requested', 'Copilot'], ['reviewed', 'Copilot'], ['review_requested', 'Copilot']] }));
test('a PR converted to draft during the wait stays pending', ready(0, ['pending', 'pending'], undefined, (live) => (live.draft = true)));
test('a PR pushed to during the wait gets no final status on the old head', ready(0, ['pending'], undefined, (live) => (live.head.sha = 'def')));
test('a ready PR passes once the wait for a Copilot review request is over', expect('success', { events: [['ready_for_review', undefined, '2020-01-01T00:00:00Z']] }));
