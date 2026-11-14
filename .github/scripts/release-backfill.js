const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:/;
const BUMP_RANK = { patch: 1, minor: 2, breaking: 3 };

function commitBump(message) {
  const match = CONVENTIONAL.exec(message.split('\n')[0]);
  if (match?.[2] || /^BREAKING[ -]CHANGE:/m.test(message)) {
    return 'breaking';
  }
  return { feat: 'minor', fix: 'patch', perf: 'patch', deps: 'patch', revert: 'patch', docs: 'patch' }[match?.[1]];
}

function isoWeek(dateString) {
  const date = new Date(dateString);
  const day = date.getUTCDay() || 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 4 - day));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normaliseVersion(version) {
  const parts = version.split('.').map(Number);
  while (parts.length < 3) {
    parts.push(0);
  }
  return parts;
}

function bumpVersion([major, minor, patch], bump) {
  if (bump === 'breaking') {
    return major >= 1 ? [major + 1, 0, 0] : [major, minor + 1, 0];
  }
  return bump === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
}

function strongestBump(bumps) {
  return bumps.reduce((best, bump) => (BUMP_RANK[bump] > BUMP_RANK[best] ? bump : best));
}

// commits: oldest first, { sha, message, date }. One release per ISO week with a feat, fix or breaking commit,
// tagged at the last commit of that week. The first release uses startVersion.
function planReleases(commits, startVersion) {
  const weeks = new Map();
  for (const commit of commits) {
    const week = isoWeek(commit.date);
    const entry = weeks.get(week) ?? { week, sha: commit.sha, bumps: [] };
    entry.sha = commit.sha;
    const bump = commitBump(commit.message);
    if (bump) {
      entry.bumps.push(bump);
    }
    weeks.set(week, entry);
  }
  let version;
  return [...weeks.values()]
    .filter((entry) => entry.bumps.length)
    .map(({ week, sha, bumps }) => {
      version = version ? bumpVersion(version, strongestBump(bumps)) : normaliseVersion(startVersion);
      return { week, sha, tag: `v${version.join('.')}` };
    })
    .map((release, index, all) => ({ ...release, previousTag: all[index - 1]?.tag }));
}

async function backfill({ github, core, owner, repo, dryRun, branch = 'main', fallbackVersion = '0.1.0' }) {
  const commits = (await github.paginate(github.rest.repos.listCommits, { owner, repo, sha: branch, per_page: 100 }))
    .reverse()
    .map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer.date }));
  let startVersion = fallbackVersion;
  try {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: 'pyproject.toml', ref: commits[0].sha, mediaType: { format: 'raw' } });
    startVersion = /^version\s*=\s*"([^"]+)"/m.exec(data)?.[1] ?? fallbackVersion;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }
  const names = (items, key) => new Set(items.map((item) => item[key]));
  const existingTags = names(await github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 }), 'name');
  const existingReleases = names(await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 }), 'tag_name');
  const releases = planReleases(commits, startVersion);
  for (const [index, { week, sha, tag, previousTag }] of releases.entries()) {
    const missingTag = !existingTags.has(tag);
    const missingRelease = !existingReleases.has(tag);
    if (!missingTag && !missingRelease) {
      continue;
    }
    core.info(`${dryRun ? 'Would create' : 'Creating'} ${missingTag ? 'tag and release' : 'release'} ${tag} at ${sha.slice(0, 7)} (${week})`);
    if (dryRun) {
      continue;
    }
    if (missingTag) {
      await github.rest.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha });
    }
    await github.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: tag,
      generate_release_notes: true,
      previous_tag_name: previousTag,
      make_latest: index === releases.length - 1 ? 'true' : 'false',
    });
  }
  core.info(`${releases.length} release(s) in plan`);
}

module.exports = { commitBump, isoWeek, planReleases, backfill };
