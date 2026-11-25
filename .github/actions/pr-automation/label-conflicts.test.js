const test = require('node:test');
const assert = require('node:assert/strict');
const { labelConflicts, clearStateLabels } = require('./label-conflicts.js');

async function run({ mergeable, labels = [], reviewDecision = null, reviews = [], actor = 'github-actions[bot]', open = [], rules = [], runs = [], statuses = [], payload = { pull_request: { number: 7, head: { sha: 'abc' }, base: { ref: 'main' } } } }) {
  const changes = [];
  const states = [].concat(mergeable);
  const record = (kind) => async (args) => changes.push([kind, args.issue_number, args.labels ?? args.name]);
  const labelEvent = (login, name = 'blocked') => ({ event: 'labeled', label: { name }, actor: { login } });
  const github = {
    graphql: async () => ({ repository: { pullRequest: { reviewDecision, latestOpinionatedReviews: { nodes: reviews }, mergeable: states.shift() ?? 'UNKNOWN', labels: { nodes: labels.map((name) => ({ name })) } } } }),
    paginate: async (method) => ({ pulls: open, rules, checks: runs })[method] ?? [...labels.flatMap((name) => [labelEvent('someone', name), labelEvent(actor, name)]), labelEvent('someone', 'other')],
    rest: { pulls: { list: 'pulls' }, repos: { getBranchRules: 'rules', listCommitStatusesForRef: async () => ({ data: statuses }) }, checks: { listForRef: 'checks' }, issues: { createLabel: record('createLabel'), addLabels: record('addLabels'), removeLabel: () => assert.fail('removal must use the token client') } },
  };
  const removeClient = { rest: { issues: { removeLabel: record('removeLabel') } } };
  const context = { repo: { owner: 'o', repo: 'r' }, ref: 'refs/heads/main', payload };
  await labelConflicts({ github, removeClient, context, core: { warning() {} }, delay: async () => {} });
  return changes;
}

const conflicts = [['createLabel', undefined, 'blocked:conflicts'], ['addLabels', 7, ['blocked:conflicts']]];

test('conflicts label follows merge conflicts and the legacy blocked label clears, retrying unknown mergeability', async () => {
  const cases = [
    [{ mergeable: 'CONFLICTING' }, conflicts],
    [{ mergeable: 'CONFLICTING', labels: ['blocked:conflicts'] }, []],
    [{ mergeable: 'CONFLICTING', labels: ['blocked'] }, conflicts],
    [{ mergeable: 'MERGEABLE' }, []],
    [{ mergeable: 'MERGEABLE', labels: ['blocked'] }, [['removeLabel', 7, 'blocked']]],
    [{ mergeable: 'MERGEABLE', labels: ['blocked'], actor: 'alex' }, []],
    [{ mergeable: 'MERGEABLE', labels: ['blocked:conflicts'] }, [['removeLabel', 7, 'blocked:conflicts']]],
    [{ mergeable: 'MERGEABLE', labels: ['blocked:conflicts'], actor: 'someone' }, []],
    [{ mergeable: 'UNKNOWN', labels: ['blocked:conflicts'] }, []],
    [{ mergeable: 'MERGEABLE', labels: ['blocked'], reviewDecision: 'CHANGES_REQUESTED' }, []],
    [{ mergeable: 'MERGEABLE', labels: ['blocked'], reviews: [{ state: 'CHANGES_REQUESTED', authorCanPushToRepository: true }] }, []],
    [{ mergeable: 'MERGEABLE', labels: ['blocked'], statuses: [{ context: 'dependencies', state: 'pending' }] }, []],
    [{ mergeable: 'MERGEABLE', labels: ['blocked'], statuses: [{ context: 'dependencies', state: 'success' }] }, [['removeLabel', 7, 'blocked']]],
    [{ mergeable: 'UNKNOWN', labels: ['blocked'] }, []],
    [{ mergeable: ['UNKNOWN', 'UNKNOWN', 'MERGEABLE'], labels: ['blocked'] }, [['removeLabel', 7, 'blocked']]],
  ];
  for (const [options, expected] of cases) {
    assert.deepEqual(await run(options), expected, JSON.stringify(options));
  }
});

test('a push checks every open PR on the pushed branch', async () => {
  const changes = await run({ mergeable: ['CONFLICTING', 'CONFLICTING'], open: [{ number: 3, head: { sha: 'a' }, base: { ref: 'main' } }, { number: 4, head: { sha: 'b' }, base: { ref: 'main' } }], payload: {} });
  assert.deepEqual(changes.filter(([kind]) => kind === 'addLabels').map(([, number]) => number), [3, 4]);
});

const required = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } }];
const added = [['createLabel', undefined, 'blocked:checks'], ['addLabels', 7, ['blocked:checks']]];

test('checks label follows failing required checks on the head commit', async () => {
  const cases = [
    [{ runs: [{ name: 'test', conclusion: 'failure' }] }, added],
    [{ runs: [{ name: 'size-report', conclusion: 'failure' }] }, []],
    [{ runs: [{ name: 'test', conclusion: 'cancelled' }] }, []],
    [{ runs: [{ name: 'test', conclusion: 'failure' }], labels: ['blocked:checks'] }, []],
    [{ runs: [{ name: 'test', conclusion: 'failure' }], labels: ['blocked'] }, added],
    [{ runs: [{ name: 'test', conclusion: 'success' }], labels: ['blocked'] }, [['removeLabel', 7, 'blocked']]],
    [{ runs: [{ name: 'test', conclusion: 'success' }], labels: ['blocked:checks'] }, [['removeLabel', 7, 'blocked:checks']]],
  ];
  for (const [options, expected] of cases) {
    assert.deepEqual(await run({ mergeable: 'MERGEABLE', rules: required, ...options }), expected, JSON.stringify(options));
  }
});

test('only the newest run of each required check counts', async () => {
  const old = { name: 'test', started_at: '2026-01-01T00:00:00Z' };
  const recent = { name: 'test', started_at: '2026-01-02T00:00:00Z' };
  const cases = [
    [{ runs: [{ ...recent, conclusion: 'success' }, { ...old, conclusion: 'failure' }], labels: ['blocked'] }, [['removeLabel', 7, 'blocked']]],
    [{ runs: [{ ...old, conclusion: 'success' }, { ...recent, conclusion: 'failure' }] }, added],
  ];
  for (const [options, expected] of cases) {
    assert.deepEqual(await run({ mergeable: 'MERGEABLE', rules: required, ...options }), expected, JSON.stringify(options));
  }
});

test('a finished CI run checks only the PR with that head commit', async () => {
  const open = [3, 7].map((number) => ({ number, head: { sha: `sha${number}` }, base: { ref: 'main' } }));
  const options = { mergeable: 'MERGEABLE', rules: required, runs: [{ name: 'test', conclusion: 'failure' }], open, payload: { workflow_run: { head_sha: 'sha7' } } };
  assert.deepEqual(await run(options), added);
});

test('a closed PR loses every bot-managed state label it has', async () => {
  const changes = [];
  const github = { rest: { issues: { removeLabel: () => assert.fail('removal must use the token client') } } };
  const removeClient = { rest: { issues: { removeLabel: async (args) => changes.push([args.issue_number, args.name]) } } };
  const names = ['blocked:checks', 'blocked:conflicts', 'blocked:changes-requested', 'pending:approval', 'auto-rebase-active', 'area:ci', 'breaking', 'owner-reviewed', 'blocked'];
  const context = { repo: { owner: 'o', repo: 'r' }, payload: { pull_request: { number: 7, labels: names.map((name) => ({ name })) } } };
  await clearStateLabels({ github, removeClient, context, core: { warning() {} } });
  assert.deepEqual(changes, names.slice(0, 5).map((name) => [7, name]));
});
