const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { test } = require('node:test');
const { reportPermissions } = require('./permissions.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const env = {
  APP_CLIENT_ID: 'example-client', APP_PRIVATE_KEY: privateKey,
  APP_SLUG: 'example-app', INSTALLATION_ID: '123',
};
const app = { id: 456, slug: 'example-app', permissions: { workflows: 'write' } };
const installation = { id: 123, app_id: 456, app_slug: 'example-app', permissions: {} };

async function diagnose(fetch, environment = env) {
  const logs = [], secrets = [], failures = [];
  await reportPermissions({
    env: environment, fetch,
    core: { info: value => logs.push(value), setSecret: value => secrets.push(value), setFailed: value => failures.push(value) },
  });
  return { logs, secrets, failures };
}

const response = body => ({ ok: true, json: async () => body });

test('reports only matching public identity and workflow permissions with authenticated GET requests', async () => {
  const calls = [];
  const result = await diagnose(async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? app : installation);
  });
  assert.deepEqual(result.logs, [
    'App: example-app', 'Installation: 123',
    'App workflows permission: write', 'Installation workflows permission: absent',
  ]);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.github.com/app', 'https://api.github.com/app/installations/123',
  ]);
  assert.equal(result.secrets.length, 1);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers.Authorization, `Bearer ${result.secrets[0]}`);
    assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
  }
  const [encodedHeader, encodedPayload] = result.secrets[0].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url'));
  assert.equal(payload.iss, env.APP_CLIENT_ID);
  assert.equal(payload.exp - payload.iat, 360);
});

test('invalid response shapes and mismatched identities fail before any output', async () => {
  for (const [appBody, installationBody] of [
    [null, installation],
    [{ ...app, permissions: { workflows: 'private permission details' } }, installation],
    [app, { ...installation, permissions: [] }],
    [{ ...app, slug: 'other-app' }, installation],
    [app, { ...installation, app_id: 789 }],
    [app, { ...installation, id: 789 }],
  ]) {
    let calls = 0;
    const result = await diagnose(async () => response(calls++ === 0 ? appBody : installationBody));
    assert.deepEqual(result.logs, []);
    assert.deepEqual(result.failures, ['Unable to read matching app and installation permissions']);
  }
});

test('invalid inputs and signing failures stop before any request', async () => {
  for (const invalid of [
    { APP_CLIENT_ID: '' }, { APP_PRIVATE_KEY: 'invalid private key' },
    { APP_SLUG: '' }, { INSTALLATION_ID: '123/other' },
  ]) {
    let calls = 0;
    const result = await diagnose(async () => { calls++; return response(app); }, { ...env, ...invalid });
    assert.equal(calls, 0);
    assert.deepEqual(result.logs, []);
    assert.deepEqual(result.secrets, []);
    assert.deepEqual(result.failures, ['Unable to read matching app and installation permissions']);
  }
});

test('request failures stop without printing responses or exception details', async () => {
  for (const fetch of [
    async () => ({ ok: false, json: async () => { throw new Error('private body'); } }),
    async () => { throw new Error('private network details'); },
    async () => ({ ok: true, json: async () => { throw new Error('private JSON details'); } }),
  ]) {
    const result = await diagnose(fetch);
    assert.deepEqual(result.logs, []);
    assert.deepEqual(result.failures, ['Unable to read matching app and installation permissions']);
  }
});
