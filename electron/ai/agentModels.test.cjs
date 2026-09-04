'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AGENT_MODEL_FLAGS,
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
  // agy documents `--effort ... (low|medium|high)`; gemini documents none.
  assert.deepEqual(effortLevelsFor('antigravity'), ['low', 'medium', 'high']);
  assert.deepEqual(effortLevelsFor('gemini'), []);
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
  // Neither has an effort flag; passing one makes the CLI exit before it runs.
  assert.deepEqual(modelArgsFor('cursor', 'composer-2.5', 'high'), ['--model', 'composer-2.5']);
  assert.deepEqual(modelArgsFor('gemini', 'gemini-3.8-flash-high', 'high'), [
    '--model', 'gemini-3.8-flash-high',
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
    { id: 'gemini-3.6-flash-high', name: 'gemini-3.6-flash-high' },
    { id: 'gemini-3.6-flash-low', name: 'gemini-3.6-flash-low' },
    { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6' },
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

  assert.deepEqual(parseModelList('grok', output), [
    { id: 'grok-4.5', name: 'grok-4.5' },
    { id: 'grok-4.3', name: 'grok-4.3' },
  ]);
});

/**
 * Read off the installed binaries on 2026-09-04. Every CLI this asks prints
 * the id beside a human label, and the parser used to require a bare token —
 * so cursor and antigravity fell back to the shipped list on every launch, and
 * that list had gone stale enough to offer models the CLI does not have.
 */
test('parseModelList reads the id and its label out of cursor-agent output', () => {
  const output = [
    'Available models',
    '',
    'auto - Auto (current, default)',
    'gpt-5.3-codex-low - Codex 5.3 Low',
    'gpt-5.3-codex-xhigh - Codex 5.3 Extra High',
    'composer-2.5 - Composer 2.5',
  ].join('\n');

  assert.deepEqual(parseModelList('cursor', output), [
    { id: 'auto', name: 'Auto (current, default)' },
    { id: 'gpt-5.3-codex-low', name: 'Codex 5.3 Low' },
    { id: 'gpt-5.3-codex-xhigh', name: 'Codex 5.3 Extra High' },
    { id: 'composer-2.5', name: 'Composer 2.5' },
  ]);
});

test('parseModelList reads the tab-separated form agy prints', () => {
  const output = [
    'Fetching available models...',
    'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
    'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  ].join('\n');

  assert.deepEqual(parseModelList('antigravity', output), [
    { id: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
    { id: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  ]);
});

test('parseModelList names a model after itself when the CLI gives no label', () => {
  assert.deepEqual(parseModelList('antigravity', 'gemini-3.6-flash-high\n'), [
    { id: 'gemini-3.6-flash-high', name: 'gemini-3.6-flash-high' },
  ]);
});

/**
 * The tier is the model for these two — `gpt-5.3-codex-xhigh`, not
 * `gpt-5.3-codex` plus a level — so the list has to survive to be useful.
 */
test('a header line is not mistaken for a model', () => {
  const parsed = parseModelList('cursor', 'Available models\n\ngpt-5.2 - GPT-5.2\n');
  assert.deepEqual(parsed, [{ id: 'gpt-5.2', name: 'GPT-5.2' }]);
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
    // both dropped rather than written to disk and passed on later. `high` is
    // a level agy does accept, so it survives.
    antigravity: { model: 'gemini-3.6-flash-high', effort: 'high', unattended: false },
    claude: { model: 'sonnet', effort: '', unattended: false },
  });

  assert.deepEqual(sanitizeCliModels(null), {});
  assert.deepEqual(sanitizeCliModels('nope'), {});
});

/**
 * `agy --help` lists `--effort  Reasoning effort for the current CLI session
 * (low|medium|high)`. It was the one runnable agent with a real effort flag and
 * no levels offered, so the panel drew no selector for it.
 */
test('antigravity offers the effort levels its CLI documents', () => {
  assert.deepEqual(effortLevelsFor('antigravity'), ['low', 'medium', 'high']);
  assert.deepEqual(modelArgsFor('antigravity', 'gemini-3.8-flash-high', 'low'), [
    '--model',
    'gemini-3.8-flash-high',
    '--effort',
    'low',
  ]);
});

/**
 * `gemini --help` contains no effort flag at all — the word does not appear.
 * Claiming one here was harmless only because no levels were offered; a level
 * added later would have passed a flag the CLI does not know, and it exits
 * before it starts.
 */
test('gemini claims no effort flag, because its CLI has none', () => {
  assert.equal(AGENT_MODEL_FLAGS.gemini.effort, undefined);
  assert.deepEqual(effortLevelsFor('gemini'), []);
});

/**
 * cursor-agent has no effort flag either; its tiers are part of the model id
 * (`gpt-5.3-codex-xhigh`), which is why the model list has to be the real one.
 */
test('cursor takes its tier from the model, not a separate level', () => {
  assert.equal(AGENT_MODEL_FLAGS.cursor.effort, undefined);
  assert.deepEqual(effortLevelsFor('cursor'), []);
});

/**
 * cursor-agent lists every model twice — `gpt-5.3-codex-high` and
 * `-high-fast` — which was 70 of the 217 it answered with on 2026-09-04. That
 * is a second axis wearing the model's clothes, and it doubled a dropdown that
 * is already long. Every `-fast` had a plain twin in that answer, so dropping
 * them makes nothing unreachable.
 */
test('cursor keeps one entry per model rather than a fast twin for each', () => {
  const output = [
    'Available models',
    '',
    'gpt-5.3-codex-high - Codex 5.3 High',
    'gpt-5.3-codex-high-fast - Codex 5.3 High Fast',
    'composer-2.5 - Composer 2.5',
  ].join('\n');

  assert.deepEqual(parseModelList('cursor', output), [
    { id: 'gpt-5.3-codex-high', name: 'Codex 5.3 High' },
    { id: 'composer-2.5', name: 'Composer 2.5' },
  ]);
});

test('the fast filter is cursor own, not a rule for every CLI', () => {
  // Nothing else names a variant that way; a model that happens to end in
  // -fast elsewhere must survive.
  assert.deepEqual(parseModelList('antigravity', 'gemini-9-fast\n'), [
    { id: 'gemini-9-fast', name: 'gemini-9-fast' },
  ]);
});
