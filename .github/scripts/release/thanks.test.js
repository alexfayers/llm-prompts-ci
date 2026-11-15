const test = require('node:test');
const assert = require('node:assert/strict');
const { thank } = require('./thanks.js');

const human = (login) => ({ login, type: 'User' });
const merged = (user, number) => ({ user, merged_at: '2026-01-01T00:00:00Z', number });

function fakeCore() {
  const warnings = [];
  return { warnings, warning: (message) => warnings.push(message) };
}

function fakeGithub({ releases = [{ id: 1, tag_name: 'v0.1.0', body: 'notes' }], pr = { number: 9, body: 'release body' }, commits = {} } = {}) {
  const calls = { compare: [], updatePull: [], updateRelease: [] };
  const compareCommitsWithBasehead = () => {};
  return {
    calls,
    paginate: async (fn, params, map) => {
      assert.equal(fn, compareCommitsWithBasehead);
      calls.compare.push(params.basehead);
      return map({ data: { commits: Object.keys(commits).map((sha) => ({ sha })) } });
    },
    rest: {
      repos: {
        compareCommitsWithBasehead,
        listReleases: async () => ({ data: releases }),
        listPullRequestsAssociatedWithCommit: async ({ commit_sha }) => ({ data: commits[commit_sha] }),
        updateRelease: async (params) => calls.updateRelease.push(params),
      },
      pulls: {
        list: async (params) => {
          assert.equal(params.head, 'o:release-please--branches--main');
          return { data: pr ? [pr] : [] };
        },
        update: async (params) => calls.updatePull.push(params),
      },
    },
  };
}

function changelogLine(number, summary) {
  return `* **deps:** ${summary} ([#${number}](https://github.com/o/r/issues/${number})) ([650178f](https://github.com/o/r/commit/650178f))`;
}

test('credits each changelog line with its PR author, skipping bots and the repo owner', async () => {
  const body = [changelogLine(489, 'update x'), changelogLine(490, 'fix y'), changelogLine(491, 'tidy z')].join('\n');
  const github = fakeGithub({
    pr: { number: 9, body },
    commits: {
      a: [merged(human('alice'), 489)],
      b: [merged(human('o'), 490)],
      c: [merged({ login: 'renovate[bot]', type: 'Bot' }, 491)],
    },
  });
  await thank({ github, core: fakeCore(), owner: 'o', repo: 'r' });
  const [line489, line490, line491] = github.calls.updatePull[0].body.split('\n');
  assert.match(line489, / by @alice$/);
  assert.doesNotMatch(line490, / by @/);
  assert.doesNotMatch(line491, / by @/);
});

test('rewrites release-please issues links to pull links for PR numbers it looked up', async () => {
  const body = changelogLine(489, 'update x');
  const github = fakeGithub({
    pr: { number: 9, body },
    commits: { a: [merged(human('alice'), 489)] },
  });
  await thank({ github, core: fakeCore(), owner: 'o', repo: 'r' });
  const updated = github.calls.updatePull[0].body;
  assert.match(updated, /\/pull\/489/);
  assert.doesNotMatch(updated, /\/issues\/489/);
});

test('stays idempotent: running the script again on its own output makes no further change', async () => {
  const body = changelogLine(489, 'update x');
  const first = fakeGithub({ pr: { number: 9, body }, commits: { a: [merged(human('alice'), 489)] } });
  await thank({ github: first, core: fakeCore(), owner: 'o', repo: 'r' });
  const onceCredited = first.calls.updatePull[0].body;

  const second = fakeGithub({ pr: { number: 9, body: onceCredited }, commits: { a: [merged(human('alice'), 489)] } });
  await thank({ github: second, core: fakeCore(), owner: 'o', repo: 'r' });

  assert.equal(second.calls.updatePull.length, 0);
});
