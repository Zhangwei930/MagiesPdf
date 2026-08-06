'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_MODEL_PRESETS,
  modelPresetsFor,
  effortLevelsFor,
  modelArgsFor,
  modelListArgsFor,
  parseModelList,
} = require('./agentModels.cjs');

test('every preset entry names a model and a label', () => {
  for (const [agentId, presets] of Object.entries(AGENT_MODEL_PRESETS)) {
    assert.ok(presets.length > 0, `${agentId} has no models`);
    for (const preset of presets) {
      assert.ok(preset.id, `${agentId}: id`);
      assert.ok(preset.name, `${agentId}: name`);
    }
  }
});

test('each CLI gets its own model list, not a shared one', () => {
  assert.notDeepEqual(modelPresetsFor('claude'), modelPresetsFor('codex'));
  // Antigravity is Google's coding agent, so it uses the Gemini model set.
  assert.deepEqual(modelPresetsFor('antigravity'), modelPresetsFor('gemini'));
  assert.ok(modelPresetsFor('gemini').some((preset) => preset.id === 'gemini-3.5-flash'));
  assert.deepEqual(modelPresetsFor('nope'), []);
});

test('effort levels follow what each CLI actually accepts', () => {
  // Verified against the installed binaries' own --help output.
  assert.deepEqual(effortLevelsFor('claude'), ['low', 'medium', 'high', 'xhigh', 'max']);
  // Gemini ids already carry the tier, so no separate level is offered.
  assert.deepEqual(effortLevelsFor('antigravity'), []);
  assert.deepEqual(effortLevelsFor('grok'), ['low', 'medium', 'high']);
  // cursor-agent has no effort flag at all, so it must not be offered one.
  assert.deepEqual(effortLevelsFor('cursor'), []);
});

test('modelArgsFor uses each CLI own flag spelling', () => {
  assert.deepEqual(modelArgsFor('claude', 'sonnet', ''), ['--model', 'sonnet']);
  assert.deepEqual(modelArgsFor('codex', 'gpt-5.6-sol', ''), ['--model', 'gpt-5.6-sol']);
  // grok abbreviates the flag and spells effort differently.
  assert.deepEqual(modelArgsFor('grok', 'grok-4.5', 'high'), [
    '--model', 'grok-4.5', '--reasoning-effort', 'high',
  ]);
  assert.deepEqual(modelArgsFor('claude', 'sonnet', 'xhigh'), [
    '--model', 'sonnet', '--effort', 'xhigh',
  ]);
});

test('modelArgsFor passes Codex its effort as a config override, not a flag', () => {
  // `codex exec` has no --effort; the reasoning level is a config key.
  assert.deepEqual(modelArgsFor('codex', 'gpt-5.6-sol', 'xhigh'), [
    '--model', 'gpt-5.6-sol', '-c', 'model_reasoning_effort="xhigh"',
  ]);
});

test('modelArgsFor drops an effort the CLI does not offer', () => {
  assert.deepEqual(modelArgsFor('cursor', 'composer-2.5', 'high'), ['--model', 'composer-2.5']);
  // The tier rides in the id, so nothing is appended even for a valid level.
  assert.deepEqual(modelArgsFor('antigravity', 'gemini-3.6-flash-high', 'high'), [
    '--model', 'gemini-3.6-flash-high',
  ]);
});

test('modelArgsFor returns nothing when no model is chosen', () => {
  assert.deepEqual(modelArgsFor('claude', '', ''), []);
  assert.deepEqual(modelArgsFor('claude', '   ', 'high'), []);
  assert.deepEqual(modelArgsFor('nope', 'x', 'high'), []);
});

test('modelListArgsFor only names a command the CLI actually has', () => {
  assert.deepEqual(modelListArgsFor('antigravity'), ['models']);
  assert.deepEqual(modelListArgsFor('grok'), ['models']);
  assert.deepEqual(modelListArgsFor('cursor'), ['models']);
  // Neither ships a way to enumerate models, so the static list is all there is.
  assert.equal(modelListArgsFor('claude'), null);
  assert.equal(modelListArgsFor('codex'), null);
});

test('parseModelList reads the plain one-per-line form', () => {
  const output = 'gemini-3.6-flash-high\ngemini-3.6-flash-low\nclaude-sonnet-4-6\n';
  assert.deepEqual(parseModelList('antigravity', output), [
    'gemini-3.6-flash-high',
    'gemini-3.6-flash-low',
    'claude-sonnet-4-6',
  ]);
});

test('parseModelList strips the bullets and annotations grok prints', () => {
  const output = [
    'You are not authenticated.',
    '',
    'Default model: grok-4.5',
    '',
    'Available models:',
    '  * grok-4.5 (default)',
    '  * grok-4.3',
  ].join('\n');

  assert.deepEqual(parseModelList('grok', output), ['grok-4.5', 'grok-4.3']);
});

test('parseModelList ignores prose and returns nothing rather than junk', () => {
  assert.deepEqual(parseModelList('antigravity', ''), []);
  assert.deepEqual(parseModelList('antigravity', 'Error: not logged in\n'), []);
  assert.deepEqual(parseModelList('claude', 'anything'), []);
});

test('sanitizeCliModels keeps only known agents and plain string choices', () => {
  const { sanitizeCliModels } = require('./agentModels.cjs');

  assert.deepEqual(sanitizeCliModels({
    antigravity: { model: 'gemini-3.6-flash-high', effort: 'high' },
    nope: { model: 'x' },
    claude: { model: 'sonnet', effort: 'nonsense' },
    codex: 'not-an-object',
  }), {
    // An agent this app does not drive, and a level its CLI would reject, are
    // both dropped rather than written to disk and passed on later.
    antigravity: { model: 'gemini-3.6-flash-high', effort: '', unattended: false },
    claude: { model: 'sonnet', effort: '', unattended: false },
  });

  assert.deepEqual(sanitizeCliModels(null), {});
  assert.deepEqual(sanitizeCliModels('nope'), {});
});
