const test = require('node:test');
const assert = require('node:assert/strict');
const { gate, holdAutoMerge, waitForReview } = require('./copilot-review.js');

function fixture({ requested = [], events = [], reviews = [] } = {}) {
  const calls = [];
  const github = {
    paginate: async (method) => method.items,
    rest: {
      issues: { listEventsForTimeline: { items: events.map(([event, login]) => ({ event, requested_reviewer: { login } })) } },
      pulls: { listReviews: { items: reviews.map(([login, copilot]) => ({ user: { login }, is_copilot_code_review: copilot })) } },
      repos: { createCommitStatus: async ({ sha, context, state }) => calls.push([sha, context, state]) },
    },
  };
  const context = { repo: { owner: 'owner', repo: 'r' }, payload: { pull_request: { number: 7, requested_reviewers: requested.map((login) => ({ login })), head: { sha: 'abc' } } } };
  return { github, context, calls };
}

const expect = (state, options) => async () => {
  const f = fixture(options);
  await gate(f);
  assert.deepEqual(f.calls, [['abc', 'copilot-review', state]]);
};

test('passes when no Copilot review was requested', expect('success', { events: [['review_requested', 'owner']] }));
test('waits while Copilot is a requested reviewer', expect('pending', { requested: ['Copilot'] }));
test('waits after a Copilot review request the reviewer list no longer shows', expect('pending', { events: [['review_requested', 'Copilot']] }));
test('passes once the Copilot request was removed', expect('success', { events: [['review_requested', 'Copilot'], ['review_request_removed', 'Copilot']] }));
test('passes once Copilot has submitted a review', expect('success', { requested: ['Copilot'], reviews: [['copilot-pull-request-reviewer[bot]', true]] }));
test('a human review does not count as the Copilot review', expect('pending', { events: [['review_requested', 'Copilot']], reviews: [['friend', false]] }));

test('reports an error status when the check fails to run', async () => {
  const f = fixture();
  f.github.paginate = async () => {
    throw new Error('boom');
  };
  await assert.rejects(gate(f), /boom/);
  assert.deepEqual(f.calls, [['abc', 'copilot-review', 'error']]);
});

function holdFixture({ autoMerge = true, reviews = [], inline = [], issueComments = [], graphqlError } = {}) {
  const calls = [];
  const warnings = [];
  const github = {
    paginate: async (method) => method.items,
    graphql: async (query, variables) => {
      if (graphqlError) {
        throw new Error(graphqlError);
      }
      calls.push(['disable', variables.id]);
    },
    rest: {
      pulls: {
        listReviews: { items: reviews.map(([id, state]) => ({ id, state, user: { login: 'copilot-pull-request-reviewer[bot]' }, is_copilot_code_review: true })) },
        listReviewComments: { items: inline.map((login) => ({ user: { login } })) },
      },
      issues: {
        listComments: { items: issueComments.map((body) => ({ body })) },
        createComment: async ({ body }) => calls.push(['comment', body.split('\n')[0]]),
      },
    },
  };
  const context = { repo: { owner: 'owner', repo: 'r' }, payload: { pull_request: { number: 7, node_id: 'PR_7', auto_merge: autoMerge ? {} : null, head: { sha: 'abc' } } } };
  const core = { warning: (message) => warnings.push(message) };
  return { github, context, core, calls, warnings };
}

const hold = (options, expected) => async () => {
  const f = holdFixture(options);
  await holdAutoMerge(f);
  assert.deepEqual(f.calls, expected);
};

test('a Copilot review without approval or inline comments disables auto-merge and comments once', hold({ reviews: [[5, 'COMMENTED']] }, [['disable', 'PR_7'], ['comment', '<!-- copilot-review-hold:5 -->']]));
test('an approving Copilot review keeps auto-merge', hold({ reviews: [[5, 'APPROVED']] }, []));
test('a Copilot review with inline comments keeps auto-merge for the thread rule', hold({ reviews: [[5, 'COMMENTED']], inline: ['Copilot'] }, []));
test('a review already held is not held again', hold({ reviews: [[5, 'COMMENTED']], issueComments: ['<!-- copilot-review-hold:5 -->\nheld'] }, []));
test('a PR without auto-merge is left alone', hold({ autoMerge: false, reviews: [[5, 'COMMENTED']] }, []));
test('only the latest Copilot review counts', hold({ reviews: [[4, 'COMMENTED'], [5, 'APPROVED']] }, []));

test('a failed disable only warns and posts no comment', async () => {
  const f = holdFixture({ reviews: [[5, 'COMMENTED']], graphqlError: 'denied' });
  await holdAutoMerge(f);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.warnings, ['Failed to disable auto-merge: denied']);
});

const wait = ({ requested = 'Copilot', polls }, expected, delays) => async () => {
  const waited = [];
  let poll = {};
  const github = {
    paginate: async () => poll.reviews ?? [],
    rest: { pulls: { listReviews: {}, get: async () => { poll = polls.shift() ?? {}; return { data: { state: 'open', draft: false, head: { sha: 'abc' }, ...poll.pr } }; } } },
  };
  const context = { repo: { owner: 'owner', repo: 'r' }, payload: { requested_reviewer: { login: requested }, pull_request: { number: 7, head: { sha: 'abc' } } } };
  assert.equal(await waitForReview({ github, context, delay: async (ms) => waited.push(ms) }), expected);
  assert.equal(waited.length, delays);
};
const copilotOn = (commit_id) => ({ user: { login: 'copilot-pull-request-reviewer[bot]' }, commit_id });

test('a review request for someone else does not wait', wait({ requested: 'owner', polls: [] }, false, 0));
test('waits until Copilot reviews the current head commit', wait({ polls: [{}, { reviews: [copilotOn('old')] }, { reviews: [copilotOn('abc')] }] }, true, 2));
test('stops waiting once the PR has a new head commit', wait({ polls: [{}, { pr: { head: { sha: 'new' } }, reviews: [copilotOn('new')] }] }, false, 1));
test('gives up after ten minutes without a Copilot review', wait({ polls: [] }, false, 30));
test('stops waiting once the PR is closed', wait({ polls: [{}, { pr: { state: 'closed' } }] }, false, 1));
test('stops waiting once the PR is back in draft', wait({ polls: [{ pr: { draft: true } }] }, false, 0));
