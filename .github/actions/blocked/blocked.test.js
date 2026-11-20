const test = require('node:test');
const assert = require('node:assert/strict');
const { report } = require('./blocked.js');

function run(payload, failWhenBlocked = false) {
  const outputs = {};
  const failures = [];
  report({ context: { payload }, core: { setOutput: (name, value) => { outputs[name] = value; }, setFailed: (message) => failures.push(message) }, failWhenBlocked });
  return failWhenBlocked ? failures : outputs.blocked;
}

const pr = (...names) => ({ pull_request: { labels: names.map((name) => ({ name })) } });

for (const [labels, blocked] of [
  [['blocked'], 'true'],
  [['area', 'blocked:conflicts'], 'true'],
  [[], 'false'],
  [['blocked:'], 'false'],
  [['blocked: '], 'false'],
  [['blockedx', 'not-blocked', 'Blocked'], 'false'],
]) {
  test(`labels [${labels}] report blocked=${blocked}`, () => {
    assert.equal(run(pr(...labels)), blocked);
  });
}

test('an event without a PR is not blocked', () => {
  assert.equal(run({}), 'false');
});

test('failWhenBlocked fails only a blocked PR, naming its blocked labels', () => {
  assert.deepEqual(run(pr('blocked', 'blocked:deps', 'area'), true), ['Blocked by labels: blocked, blocked:deps']);
  assert.deepEqual(run(pr('area'), true), []);
});
