const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rebase } = require('./rebase-prs.js');

const context = { repo: { owner: 'octo', repo: 'r' }, ref: 'refs/heads/main', payload: {} };

function pr(number, overrides = {}) {
  return {
    id: `id${number}`, number, headRefOid: `oid${number}`, baseRefName: 'main',
    createdAt: `2026-01-${String(number).padStart(2, '0')}`, state: 'OPEN',
    isDraft: false, autoMergeRequest: {}, mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED', author: { login: 'builder' }, labels: { nodes: [] },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}

function setup(nodes) {
  const calls = [];
  const github = {
    graphql: async (query, variables) => {
      if (query.includes('mutation')) {
        calls.push(['update', variables.id]);
        return {};
      }
      if (query.includes('pullRequest(number:')) {
        return { repository: { pullRequest: nodes.find((pr) => pr.number === variables.number) } };
      }
      return { repository: { pullRequests: { nodes, pageInfo: { hasNextPage: false } } } };
    },
    paginate: async (endpoint) => {
      if (endpoint === 'rules') return [
        { type: 'pull_request', parameters: { required_review_thread_resolution: true } },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'test' }] } },
      ];
      if (endpoint === 'checks') return [{ name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-01-01', app: { id: 1 } }];
      if (endpoint === 'statuses') return [{ context: 'codeowner-review', state: 'success' }];
      return [];
    },
    rest: {
      repos: {
        getBranchRules: 'rules', listCommitStatusesForRef: 'statuses',
        getCombinedStatusForRef: async () => ({ data: { statuses: [{ context: 'codeowner-review', state: 'success' }] } }),
        compareCommitsWithBasehead: async () => ({ data: { behind_by: 1 } }),
      },
      checks: { listForRef: 'checks' },
      issues: {
        listForRepo: 'active',
        createLabel: async () => {},
        addLabels: async ({ issue_number }) => {
          calls.push(['claim', issue_number]);
          nodes.find((pr) => pr.number === issue_number).labels = { nodes: [{ name: 'auto-rebase-active' }] };
        },
        removeLabel: async ({ issue_number }) => { calls.push(['release', issue_number]); },
      },
    },
  };
  const core = { info: () => {}, warning: () => {} };
  return { github, context, core, calls };
}

const active = { nodes: [{ name: 'auto-rebase-active' }] };
const unresolved = { nodes: [{ isResolved: false, isOutdated: true }], pageInfo: { hasNextPage: false } };

test('a pending incumbent holds its place ahead of ready PRs', async () => {
  for (const conclusion of ['success', null]) {
    const args = setup([pr(1), pr(2, { labels: active, reviewDecision: 'REVIEW_REQUIRED' })]);
    const paginate = args.github.paginate;
    args.github.paginate = async (endpoint, options) => endpoint === 'checks' && options.ref === 'oid2'
      ? [{ name: 'test', status: 'completed', conclusion }]
      : paginate(endpoint, options);
    args.github.rest.repos.getCombinedStatusForRef = async ({ ref }) => ({ data: { statuses: [{ context: 'codeowner-review', state: ref === 'oid2' ? 'pending' : 'success' }] } });
    args.github.rest.repos.compareCommitsWithBasehead = async () => ({ data: { behind_by: 0 } });
    await rebase(args);
    assert.deepEqual(args.calls, []);
  }
});

test('a PR awaiting required review is not newly selected and its retained slot gets no update', async () => {
  const initial = setup([pr(1, { reviewDecision: 'REVIEW_REQUIRED' }), pr(2, { reviewDecision: null })]);
  await rebase(initial);
  assert.deepEqual(initial.calls, [['claim', 2], ['update', 'id2']]);

  const incumbent = setup([pr(1, { labels: active, reviewDecision: 'REVIEW_REQUIRED' }), pr(2)]);
  await rebase(incumbent);
  assert.deepEqual(incumbent.calls, []);
});

test('required results block selection and release a definitely failed incumbent', async () => {
  for (const conclusion of [null, 'failure', 'cancelled', 'action_required', 'timed_out', 'startup_failure']) {
    const args = setup([pr(1)]);
    const original = args.github.paginate;
    args.github.paginate = async (endpoint, options) => endpoint === 'checks'
      ? [
        { id: 2, name: 'test', status: conclusion ? 'completed' : 'queued', conclusion, started_at: null, app: { id: 1 } },
        { id: 1, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-01-01', app: { id: 1 } },
      ]
      : original(endpoint, options);
    await rebase(args);
    assert.deepEqual(args.calls, [], String(conclusion));
  }
  for (const override of [{}, { isDraft: true }, { autoMergeRequest: null }, { labels: { nodes: [...active.nodes, { name: 'blocked:checks' }] } }, { reviewDecision: null, latestOpinionatedReviews: { nodes: [{ state: 'CHANGES_REQUESTED' }] } }, { reviewThreads: unresolved }]) {
    const args = setup([pr(1, { labels: active, ...override }), pr(2)]);
    const original = args.github.paginate;
    args.github.paginate = async (endpoint, options) => endpoint === 'checks' && options.ref === 'oid1' && !Object.keys(override).length
      ? [{ name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-01-01', app: { id: 1 } }]
      : original(endpoint, options);
    await rebase(args);
    assert.deepEqual(args.calls, [['release', 1], ['claim', 2], ['update', 'id2']]);
  }
});

test('required commit statuses and check runs use the latest matching app result', async () => {
  for (const state of ['success', 'pending', 'failure', 'error']) {
    const args = setup([pr(1)]);
    const original = args.github.paginate;
    args.github.paginate = async (endpoint, options) => {
      if (endpoint === 'rules') return [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'dependencies', integration_id: 7 }] } }];
      if (endpoint === 'checks') return [{ name: 'dependencies', status: 'completed', conclusion: 'success', app: { id: 8 } }];
      if (endpoint === 'statuses') return [
        { context: 'dependencies', state: 'success', creator: { type: 'Bot', login: 'other[bot]' }, id: 3 },
        { context: 'dependencies', state, creator: { type: 'Bot', login: 'ci[bot]' }, id: 2 },
        { context: 'dependencies', state: 'success', creator: { type: 'Bot', login: 'ci[bot]' }, id: 1 },
      ];
      return original(endpoint, options);
    };
    args.github.request = async (_, { app_slug }) => ({ data: { id: app_slug === 'ci' ? 7 : 8 } });
    await rebase(args);
    assert.deepEqual(args.calls, state === 'success' ? [['claim', 1], ['update', 'id1']] : [], state);
  }
});

test('paginated candidates retain one active PR and clean closed and duplicate claims', async () => {
  const nodes = [pr(1, { isDraft: true }), pr(2, { state: 'CLOSED', labels: active }), pr(3, { labels: active }), pr(4, { labels: active })];
  const args = setup(nodes);
  const query = args.github.graphql;
  args.github.graphql = async (text, variables) => text.includes('pullRequests(')
    ? { repository: { pullRequests: { nodes: variables.cursor ? nodes.slice(2) : [nodes[0]], pageInfo: { hasNextPage: !variables.cursor, endCursor: 'next' } } } }
    : query(text, variables);
  const paginate = args.github.paginate;
  args.github.paginate = async (endpoint, options) => endpoint === 'active' ? [{ number: 2, pull_request: {} }] : paginate(endpoint, options);
  await rebase(args);
  assert.deepEqual(args.calls, [['release', 2], ['release', 4], ['update', 'id3']]);
});

test('acquisition and revalidation protect branch updates and preserve the exact-head fallback', async () => {
  const acquisition = setup([pr(1), pr(2)]);
  acquisition.github.rest.issues.addLabels = async () => { throw new Error('claim failed'); };
  await assert.rejects(rebase(acquisition), /claim failed/);
  assert.deepEqual(acquisition.calls, []);

  const incomplete = setup([pr(1, { reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } })]);
  await assert.rejects(rebase(incomplete), /Incomplete PR metadata/);
  assert.deepEqual(incomplete.calls, []);

  const revalidation = setup([pr(1)]);
  const revalidationQuery = revalidation.github.graphql;
  revalidation.github.graphql = async (text, variables) => text.includes('pullRequest(number:')
    ? { repository: { pullRequest: pr(1, { labels: active, reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } }) } }
    : revalidationQuery(text, variables);
  await assert.rejects(rebase(revalidation), /Cannot revalidate active PR/);
  assert.deepEqual(revalidation.calls, [['claim', 1]]);

  for (const override of [{ headRefOid: 'changed' }, { baseRefName: 'release' }, { isDraft: true }, { autoMergeRequest: null }, { reviewDecision: 'CHANGES_REQUESTED' }, { mergeable: 'UNKNOWN' }, { reviewThreads: unresolved }]) {
    const args = setup([pr(1), pr(2)]);
    const query = args.github.graphql;
    args.github.graphql = async (text, variables) => text.includes('pullRequest(number:')
      ? { repository: { pullRequest: { ...pr(1, { labels: active }), ...override } } }
      : query(text, variables);
    await rebase(args);
    assert.deepEqual(args.calls, [['claim', 1]]);
  }

  const args = setup([pr(1), pr(2)]);
  const query = args.github.graphql;
  args.github.graphql = async (text, variables) => {
    if (!text.includes('mutation')) return query(text, variables);
    args.calls.push([text.includes('REBASE') ? 'rebase' : 'merge', variables.id, variables.head]);
    throw new Error('update failed');
  };
  await rebase(args);
  assert.deepEqual(args.calls, [['claim', 1], ['rebase', 'id1', 'oid1'], ['merge', 'id1', 'oid1']]);
});

test('the serialized selector replaces both update paths and receives recovery events', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
  const action = fs.readFileSync(path.join(__dirname, 'action.yml'), 'utf8');
  assert.doesNotMatch(action, /rebase-prs.js/);
  assert.match(action, /if: github.event_name == 'pull_request_target'\n      uses: actions\/labeler/);
  const reusable = read('workflows/pr-automation.yml');
  assert.match(reusable, /needs: automate/);
  assert.match(reusable, /group: auto-rebase-\$\{\{ github.repository \}\}/);
  assert.match(reusable, /cancel-in-progress: false/);
  assert.doesNotMatch(reusable, /if: github.event_name != 'schedule'/);
  assert.match(action, /- name: Refresh answered Copilot review waits\n      if: github.event_name == 'schedule'\n      continue-on-error: true\n      uses: actions\/github-script@v9/);
  assert.match(action, /const \{ recover \} = require\(`\$\{process.env.ACTION_PATH\}\/codeowner-review.js`\)\n          await recover\(\{ github, context, core \}\)/);
  assert.match(read('workflows/project-automation.yml'), /auto_merge_disabled/);
  assert.match(read('workflows/project-automation.yml'), /schedule:/);
  assert.match(read('workflows/sync-shared-files.yml'), /target\/\.github\/workflows\/project-automation.yml/);
});

test('only the oldest currently ready PR is claimed and updated', async () => {
  const args = setup([pr(2), pr(1), pr(3, { isDraft: true, labels: { nodes: [{ name: 'auto-rebase' }] } })]);
  await rebase(args);
  assert.deepEqual(args.calls, [['claim', 1], ['update', 'id1']]);

  for (const required of [true, false]) {
    const args = setup([pr(1, { reviewThreads: unresolved }), pr(2)]);
    const paginate = args.github.paginate;
    args.github.paginate = async (endpoint, options) => endpoint === 'rules'
      ? [{ type: 'pull_request', parameters: { required_review_thread_resolution: required } }]
      : paginate(endpoint, options);
    await rebase(args);
    const selected = required ? 2 : 1;
    assert.deepEqual(args.calls, [['claim', selected], ['update', `id${selected}`]]);
  }
});
