const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { report, reportForRun } = require('./benchmark-comment.js');

const MARKER = '<!-- benchmark-size -->';

function setup(markdown, { comments = [], failWith } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-'));
  fs.writeFileSync(path.join(dir, 'benchmark.md'), markdown);
  fs.writeFileSync(path.join(dir, 'pr-number'), '7\n');
  const calls = { create: [], update: [], warnings: [] };
  const write = (list) => async (params) => {
    if (failWith) throw failWith;
    list.push(params);
  };
  const github = {
    paginate: async () => comments,
    rest: {
      issues: { listComments: () => {}, createComment: write(calls.create), updateComment: write(calls.update) },
      pulls: { get: async () => ({ data: { head: { sha: 'abc' } } }) },
    },
  };
  const core = {
    summary: { addRaw: () => core.summary, write: async () => {} },
    warning: (message) => calls.warnings.push(message),
  };
  const context = {
    repo: { owner: 'o', repo: 'r' },
    payload: { pull_request: { number: 3 }, workflow_run: { head_sha: 'abc' } },
  };
  return { args: { github, context, core, path: `${dir}/benchmark.md`, dir }, calls };
}

test('creates a marked comment, or updates the existing one', async () => {
  const created = setup('changes\n');
  await report(created.args);
  assert.ok(created.calls.create[0].body.startsWith(`${MARKER}\n`));

  const updated = setup('changes\n', { comments: [{ id: 9, body: `${MARKER}\nold` }] });
  await report(updated.args);
  assert.equal(updated.calls.update[0].comment_id, 9);
  assert.equal(updated.calls.create.length, 0);
});

test('drops the details block from an oversize comment', async () => {
  const { args, calls } = setup(`summary line\n<details>\n${'x'.repeat(60000)}\n</details>\n`);
  await report(args);
  assert.ok(calls.create[0].body.length <= 60000);
  assert.ok(calls.create[0].body.includes('summary line'));
  assert.ok(!calls.create[0].body.includes('<details>'));
});

test('warns on a 403 and rethrows other errors', async () => {
  const forbidden = setup('changes\n', { failWith: Object.assign(new Error('forbidden'), { status: 403 }) });
  await report(forbidden.args);
  assert.equal(forbidden.calls.warnings.length, 1);

  const broken = setup('changes\n', { failWith: Object.assign(new Error('boom'), { status: 500 }) });
  await assert.rejects(report(broken.args), /boom/);
});

test('comments on the artifact PR only when its head matches the run', async () => {
  const match = setup('changes\n');
  await reportForRun(match.args);
  assert.equal(match.calls.create[0].issue_number, 7);

  const stale = setup('changes\n');
  stale.args.context.payload.workflow_run.head_sha = 'other';
  await reportForRun(stale.args);
  assert.equal(stale.calls.create.length, 0);
  assert.equal(stale.calls.warnings.length, 1);
});
