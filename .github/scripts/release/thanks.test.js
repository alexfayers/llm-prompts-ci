const test = require('node:test');
const assert = require('node:assert/strict');
const { thank } = require('./thanks.js');

const human = (login) => ({ login, type: 'User' });
const merged = (user) => ({ user, merged_at: '2026-01-01T00:00:00Z' });

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

test('adds sorted, de-duplicated human PR authors since the last release to the release PR body', async () => {
  const github = fakeGithub({
    commits: {
      a: [merged(human('bob'))],
      b: [merged(human('alice'))],
      c: [merged(human('bob'))],
      d: [merged({ login: 'renovate[bot]', type: 'Bot' })],
      e: [merged({ login: 'helper', type: 'Bot' })],
      f: [merged(human('o'))],
      g: [{ user: human('carol'), merged_at: null }],
    },
  });
  await thank({ github, core: fakeCore(), owner: 'o', repo: 'r' });
  assert.deepEqual(github.calls.compare, ['v0.1.0...main']);
  assert.deepEqual(github.calls.updatePull, [
    { owner: 'o', repo: 'r', pull_number: 9, body: 'release body\n\n<!-- thanks -->\n### Thanks\n\n- @alice\n- @bob\n' },
  ]);
});

test('replaces an earlier thanks section and drops it when nobody is left to thank', async () => {
  const earlier = 'release body\n\n<!-- thanks -->\n### Thanks\n\n- @old\n';
  const github = fakeGithub({ pr: { number: 9, body: earlier }, commits: { a: [merged(human('alice'))] } });
  await thank({ github, core: fakeCore(), owner: 'o', repo: 'r' });
  assert.equal(github.calls.updatePull[0].body, 'release body\n\n<!-- thanks -->\n### Thanks\n\n- @alice\n');

  const botsOnly = fakeGithub({ pr: { number: 9, body: earlier }, commits: { a: [merged({ login: 'renovate[bot]', type: 'Bot' })] } });
  await thank({ github: botsOnly, core: fakeCore(), owner: 'o', repo: 'r' });
  assert.equal(botsOnly.calls.updatePull[0].body, 'release body');
});

test('leaves the PR body alone when the thanks section would not change', async () => {
  const unchanged = 'release body\n\n<!-- thanks -->\n### Thanks\n\n- @alice\n';
  const github = fakeGithub({ pr: { number: 9, body: unchanged }, commits: { a: [merged(human('alice'))] } });
  await thank({ github, core: fakeCore(), owner: 'o', repo: 'r' });
  assert.equal(github.calls.updatePull.length, 0);
});

test('adds the thanks section to a created release, counting PRs since the previous release', async () => {
  const github = fakeGithub({
    releases: [
      { id: 2, tag_name: 'v0.2.0', body: 'new notes' },
      { id: 1, tag_name: 'v0.1.0', body: 'old notes' },
    ],
    pr: null,
    commits: { a: [merged(human('alice'))] },
  });
  await thank({ github, core: fakeCore(), owner: 'o', repo: 'r', releaseTag: 'v0.2.0' });
  assert.deepEqual(github.calls.compare, ['v0.1.0...v0.2.0']);
  assert.deepEqual(github.calls.updateRelease, [
    { owner: 'o', repo: 'r', release_id: 2, body: 'new notes\n\n<!-- thanks -->\n### Thanks\n\n- @alice\n' },
  ]);
  assert.equal(github.calls.updatePull.length, 0);
});

test('warns instead of throwing when updating the release fails', async () => {
  const github = fakeGithub({
    releases: [
      { id: 2, tag_name: 'v0.2.0', body: 'new notes' },
      { id: 1, tag_name: 'v0.1.0', body: 'old notes' },
    ],
    commits: { a: [merged(human('alice'))] },
  });
  github.rest.repos.updateRelease = async () => {
    throw new Error('boom');
  };
  const core = fakeCore();
  await thank({ github, core, owner: 'o', repo: 'r', releaseTag: 'v0.2.0' });
  assert.deepEqual(core.warnings, ['Could not add release thanks: boom']);
  assert.deepEqual(github.calls.updatePull, [
    { owner: 'o', repo: 'r', pull_number: 9, body: 'release body\n\n<!-- thanks -->\n### Thanks\n\n- @alice\n' },
  ]);
});
