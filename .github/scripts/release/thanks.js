const MARKER = '<!-- thanks -->';
const RELEASE_BRANCH = 'release-please--branches--main';
const PR_LINK = /\(\[#(\d+)\]\(([^)]+?)\/issues\/\1\)\)/;
const CREDIT = / by @[\w-]+$/;

function isBot(user) {
  return user.type === 'Bot' || user.login.endsWith('[bot]');
}

async function prCredits(github, { owner, repo, base, head }) {
  const commits = await github.paginate(
    github.rest.repos.compareCommitsWithBasehead,
    { owner, repo, basehead: `${base}...${head}`, per_page: 100 },
    (response) => response.data.commits,
  );
  const credits = new Map();
  for (const { sha } of commits) {
    const { data: pulls } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: sha });
    for (const { number, user, merged_at } of pulls) {
      if (!merged_at) {
        continue;
      }
      credits.set(number, isBot(user) || user.login === owner ? null : user.login);
    }
  }
  return credits;
}

function annotate(body, credits) {
  const rest = (body ?? '').split(MARKER)[0].trimEnd();
  return rest
    .split('\n')
    .map((line) => {
      const match = line.match(PR_LINK);
      if (!match || !credits.has(Number(match[1]))) {
        return line;
      }
      const [full, number, base] = match;
      const login = credits.get(Number(number));
      const linked = line.replace(full, `([#${number}](${base}/pull/${number}))`);
      const stripped = linked.replace(CREDIT, '');
      return login ? `${stripped} by @${login}` : stripped;
    })
    .join('\n');
}

async function thank({ github, core, owner, repo, releaseTag }) {
  const { data } = await github.rest.repos.listReleases({ owner, repo, per_page: 100 });
  const releases = data.filter((release) => !release.draft);
  const index = releases.findIndex((release) => release.tag_name === releaseTag);
  if (index !== -1 && releases[index + 1]) {
    try {
      const release = releases[index];
      const credits = await prCredits(github, { owner, repo, base: releases[index + 1].tag_name, head: releaseTag });
      const body = annotate(release.body, credits);
      if (body !== release.body) {
        await github.rest.repos.updateRelease({ owner, repo, release_id: release.id, body });
      }
    } catch (error) {
      core.warning(`Could not credit release authors: ${error.message}`);
    }
  }

  const {
    data: [pr],
  } = await github.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${RELEASE_BRANCH}` });
  if (pr && releases[0]) {
    try {
      const credits = await prCredits(github, { owner, repo, base: releases[0].tag_name, head: 'main' });
      const body = annotate(pr.body, credits);
      if (body !== pr.body) {
        await github.rest.pulls.update({ owner, repo, pull_number: pr.number, body });
      }
    } catch (error) {
      core.warning(`Could not credit release authors: ${error.message}`);
    }
  }
}

module.exports = { thank };
