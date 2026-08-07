'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { strictPrivacyRefusal } = require('./privacy.cjs');

test('lets everything through when strict local privacy is off', () => {
  assert.equal(strictPrivacyRefusal({ strict: false, baseUrl: 'https://api.deepseek.com/v1' }), null);
  assert.equal(strictPrivacyRefusal({ strict: false, agent: 'cli:claude' }), null);
});

test('allows a loopback endpoint under strict privacy', () => {
  for (const baseUrl of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:11434/v1',
  ]) {
    assert.equal(strictPrivacyRefusal({ strict: true, baseUrl }), null, baseUrl);
  }
});

test('refuses a remote model endpoint under strict privacy', () => {
  const refusal = strictPrivacyRefusal({ strict: true, baseUrl: 'https://api.deepseek.com/v1' });
  assert.ok(refusal);
  assert.equal(refusal.code, 'AI_STRICT_LOCAL_PRIVACY');
  assert.match(refusal.userMessage.zh, /严格本地隐私/);
  assert.match(refusal.userMessage.en, /strict local privacy/i);
});

test('refuses an endpoint that does not parse, rather than assuming it is local', () => {
  assert.ok(strictPrivacyRefusal({ strict: true, baseUrl: 'not a url' }));
  assert.ok(strictPrivacyRefusal({ strict: true, baseUrl: '' }));
});

test('refuses a CLI agent under strict privacy whatever its endpoint', () => {
  // A coding-agent CLI talks to its vendor's cloud on its own account; this app
  // cannot see or restrict that, so strict mode has to refuse the whole turn.
  const refusal = strictPrivacyRefusal({
    strict: true,
    agent: 'cli:claude',
    baseUrl: 'http://127.0.0.1:11434/v1',
  });
  assert.ok(refusal);
  assert.equal(refusal.code, 'AI_STRICT_LOCAL_PRIVACY');
  assert.match(refusal.userMessage.zh, /命令行/);
});
