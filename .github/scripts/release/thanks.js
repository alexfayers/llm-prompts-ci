const MARKER = '<!-- thanks -->';
const RELEASE_BRANCH = 'release-please--branches--main';

function isBot(user) {
  return user.type === 'Bot' || user.login.endsWith('[bot]');
}

async function contributors(github, { owner, repo, base, head }) {
  const commits = await github.paginate(
    github.rest.repos.compareCommitsWithBasehead,
    { owner, repo, basehead: `${base}...${head}`, per_page: 100 },
    (response) => response.data.commits,
  );
  const logins = new Set();
  for (const { sha } of commits) {
    const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
    for (const { user, merged_at } of pulls) {
      if (merged_at && !isBot(user) && user.login !== owner) {
        logins.add(user.login);
      }
    }
  }
  return [...logins].sort((a, b) => a.localeCompare(b));
}

function withThanks(body, logins) {
  const rest = (body ?? '').split(MARKER)[0].trimEnd();
  if (logins.length === 0) {
    return rest;
  }
  return `${rest}\n\n${MARKER}\n### Thanks\n\n${logins.map((login) => `- @${login}`).join('\n')}\n`;
}

async function thank({ github, core, owner, repo, releaseTag }) {
  const { data } = await github.rest.repos.listReleases({ owner, repo, per_page: 100 });
  const releases = data.filter((release) => !release.draft);
  const index = releases.findIndex((release) => release.tag_name === releaseTag);
  if (index !== -1 && releases[index + 1]) {
    try {
      const release = releases[index];
      const logins = await contributors(github, { owner, repo, base: releases[index + 1].tag_name, head: releaseTag });
      const body = withThanks(release.body, logins);
      if (body !== release.body) {
        await github.rest.repos.updateRelease({ owner, repo, release_id: release.id, body });
      }
    } catch (error) {
      core.warning(`Could not add release thanks: ${error.message}`);
    }
  }

  const {
    data: [pr],
  } = await github.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${RELEASE_BRANCH}` });
  if (pr && releases[0]) {
    try {
      const logins = await contributors(github, { owner, repo, base: releases[0].tag_name, head: 'main' });
      const body = withThanks(pr.body, logins);
      if (body !== pr.body) {
        await github.rest.pulls.update({ owner, repo, pull_number: pr.number, body });
      }
    } catch (error) {
      core.warning(`Could not add release thanks: ${error.message}`);
    }
  }
}

module.exports = { thank };
