const { sign } = require('node:crypto');

async function reportPermissions({ core, env = process.env, fetch = globalThis.fetch }) {
  try {
    if (![env.APP_CLIENT_ID, env.APP_PRIVATE_KEY, env.APP_SLUG].every(value => typeof value === 'string' && value.trim())
        || !/^\d+$/.test(env.INSTALLATION_ID) || !Number.isSafeInteger(Number(env.INSTALLATION_ID))
        || Number(env.INSTALLATION_ID) <= 0) {
      throw new Error();
    }
    const now = Math.floor(Date.now() / 1000);
    const unsigned = [
      { alg: 'RS256', typ: 'JWT' },
      { iss: env.APP_CLIENT_ID, iat: now - 60, exp: now + 300 },
    ].map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    const jwt = `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), env.APP_PRIVATE_KEY).toString('base64url')}`;
    core.setSecret(jwt);
    const results = [];
    for (const path of ['/app', `/app/installations/${env.INSTALLATION_ID}`]) {
      const response = await fetch(`https://api.github.com${path}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
      });
      if (!response.ok) throw new Error();
      results.push(await response.json());
    }
    const [app, installation] = results;
    for (const result of results) {
      if (!result || !Number.isSafeInteger(result.id) || result.id <= 0
          || !result.permissions || typeof result.permissions !== 'object' || Array.isArray(result.permissions)
          || (result.permissions.workflows !== undefined && !['read', 'write'].includes(result.permissions.workflows))) {
        throw new Error();
      }
    }
    if (app.slug !== env.APP_SLUG || installation.app_slug !== app.slug
        || installation.app_id !== app.id || installation.id !== Number(env.INSTALLATION_ID)) {
      throw new Error();
    }
    core.info(`App: ${app.slug}`);
    core.info(`Installation: ${installation.id}`);
    core.info(`App workflows permission: ${app.permissions.workflows ?? 'absent'}`);
    core.info(`Installation workflows permission: ${installation.permissions.workflows ?? 'absent'}`);
  } catch {
    core.setFailed('Unable to read matching app and installation permissions');
  }
}

module.exports = { reportPermissions };
