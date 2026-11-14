const test = require('node:test');
const assert = require('node:assert/strict');
const { commitBump, isoWeek, planReleases, backfill } = require('./release-backfill.js');

const commit = (sha, date, message) => ({ sha, date, message });

test('conventional commits map to bumps and chores to none', () => {
  assert.equal(commitBump('feat(x): add'), 'minor');
  assert.equal(commitBump('fix: bug'), 'patch');
  assert.equal(commitBump('refactor!: drop'), 'breaking');
  assert.equal(commitBump('chore: tidy\n\nBREAKING CHANGE: gone'), 'breaking');
  assert.equal(commitBump('perf: fast'), 'patch');
  assert.equal(commitBump('docs: words'), 'patch');
  assert.equal(commitBump('chore: tidy'), undefined);
  assert.equal(commitBump('Merge branch main'), undefined);
});

test('weeks follow ISO numbering across year boundaries', () => {
  assert.equal(isoWeek('2026-01-01T00:00:00Z'), '2026-W01');
  assert.equal(isoWeek('2027-01-01T00:00:00Z'), '2026-W53');
  assert.equal(isoWeek('2026-11-15T12:00:00Z'), '2026-W46');
});

test('one release per releasable week tagged at the last commit of the week', () => {
  const plan = planReleases(
    [
      commit('a', '2026-11-02T10:00:00Z', 'feat: first'),
      commit('b', '2026-11-03T10:00:00Z', 'fix: bug'),
      commit('c', '2026-11-04T10:00:00Z', 'chore: tidy'),
      commit('d', '2026-11-09T10:00:00Z', 'chore: only chores'),
      commit('e', '2026-11-16T10:00:00Z', 'fix: later'),
      commit('f', '2026-11-23T10:00:00Z', 'feat!: break'),
    ],
    '0.1.0'
  );
  assert.deepEqual(plan.map(({ sha, tag }) => [sha, tag]), [['c', 'v0.1.0'], ['e', 'v0.1.1'], ['f', 'v0.2.0']]);
});

test('breaking changes bump the major from 1.0.0 and a short start version is padded', () => {
  const plan = planReleases(
    [commit('a', '2026-11-02T10:00:00Z', 'fix: one'), commit('b', '2026-11-09T10:00:00Z', 'feat!: two')],
    '1.0'
  );
  assert.deepEqual(plan.map(({ tag }) => tag), ['v1.0.0', 'v2.0.0']);
});

function fakeGithub({ existingTags = [], existingReleases = [], pyproject = 'version = "0.1.0"\n' } = {}) {
  const calls = { refs: [], releases: [] };
  const list = { commits: 'commits', tags: 'tags', releases: 'releases' };
  return {
    calls,
    paginate: async (fn) =>
      fn === list.commits
        ? [
            { sha: 'b', commit: { message: 'feat: two', committer: { date: '2026-11-09T10:00:00Z' } } },
            { sha: 'a', commit: { message: 'feat: one', committer: { date: '2026-11-02T10:00:00Z' } } },
          ]
        : fn === list.tags
          ? existingTags.map((name) => ({ name }))
          : existingReleases.map((tag_name) => ({ tag_name })),
    rest: {
      repos: {
        listCommits: list.commits,
        listTags: list.tags,
        listReleases: list.releases,
        getContent: async () => ({ data: pyproject }),
        createRelease: async (params) => calls.releases.push(params),
      },
      git: { createRef: async (params) => calls.refs.push(params) },
    },
  };
}
const core = { info() {} };

test('dry run creates nothing', async () => {
  const github = fakeGithub();
  await backfill({ github, core, owner: 'o', repo: 'r', dryRun: true });
  assert.equal(github.calls.refs.length, 0);
});

test('real run skips finished releases, links the previous tag and marks only the last release latest', async () => {
  const github = fakeGithub({ existingTags: ['v0.1.0'], existingReleases: ['v0.1.0'] });
  await backfill({ github, core, owner: 'o', repo: 'r', dryRun: false });
  assert.deepEqual(github.calls.refs.map((r) => r.ref), ['refs/tags/v0.2.0']);
  assert.deepEqual(github.calls.releases.map((r) => [r.previous_tag_name, r.make_latest]), [['v0.1.0', 'true']]);
});

test('a rerun creates the release for a tag that has none', async () => {
  const github = fakeGithub({ existingTags: ['v0.1.0', 'v0.2.0'], existingReleases: ['v0.1.0'] });
  await backfill({ github, core, owner: 'o', repo: 'r', dryRun: false });
  assert.equal(github.calls.refs.length, 0);
  assert.deepEqual(github.calls.releases.map((r) => r.tag_name), ['v0.2.0']);
});
