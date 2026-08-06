'use strict';

/**
 * The models and effort levels each coding-agent CLI accepts.
 *
 * These are per-CLI, not shared: `claude --model` takes Anthropic aliases,
 * `codex --model` takes OpenAI ids, and the Antigravity CLI takes Gemini ids
 * with the tier baked into the name. The flag spellings differ too, and every
 * one below was read off the installed binary's own `--help` rather than
 * assumed — passing a flag a CLI does not know makes it exit before it starts.
 *
 * A model an agent does not list can still be typed by hand in the CLI itself;
 * this is the set the panel offers, not a restriction on the agent.
 */

const GEMINI_MODELS = [
  { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro', description: 'Recommended' },
  { id: 'gemini-3.1-pro-high', name: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-3.1-pro-low', name: 'Gemini 3.1 Pro (Low)' },
  { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', description: 'Everyday' },
  { id: 'gemini-3.5-flash-high', name: 'Gemini 3.5 Flash (High)' },
  { id: 'gemini-3.5-flash-medium', name: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-3.5-flash-low', name: 'Gemini 3.5 Flash (Low)', description: 'Fastest' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
];

const AGENT_MODEL_PRESETS = {
  claude: [
    { id: 'default', name: 'Opus 4.6', description: 'Recommended' },
    { id: 'sonnet', name: 'Sonnet 4.6', description: 'Everyday tasks' },
    { id: 'haiku', name: 'Haiku 4.5', description: 'Fastest' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', description: 'Latest flagship' },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', description: 'Balanced' },
    { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', description: 'Fast / cost' },
    { id: 'gpt-5.6', name: 'GPT-5.6' },
    { id: 'gpt-5.5', name: 'GPT-5.5' },
    { id: 'gpt-5.1', name: 'GPT-5.1' },
    { id: 'o4-mini', name: 'o4-mini', description: 'Fast reasoning' },
    { id: 'o3', name: 'o3', description: 'Reasoning' },
  ],
  cursor: [
    { id: 'composer-2.5', name: 'Composer 2.5', description: 'Recommended' },
    { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6', name: 'GPT-5.6' },
    { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4.6', name: 'Claude Sonnet 4.6' },
    { id: 'grok-4.5', name: 'Grok 4.5' },
    { id: 'gemini-3.1-pro', name: 'Gemini 3.1 Pro' },
  ],
  gemini: GEMINI_MODELS,
  antigravity: GEMINI_MODELS,
  grok: [
    { id: 'grok-4.5', name: 'Grok 4.5', description: 'Latest flagship' },
    { id: 'grok-4.3', name: 'Grok 4.3' },
    { id: 'grok-build-0.1', name: 'Grok Build 0.1', description: 'Coding' },
    { id: 'grok-4.20-0309-reasoning', name: 'Grok 4.20 Reasoning' },
    { id: 'grok-4.20-0309-non-reasoning', name: 'Grok 4.20' },
  ],
};

/**
 * How each CLI is told which model and how hard to think. Read from `--help`:
 * cursor-agent has no effort flag, and `codex exec` takes the level as a config
 * override rather than a flag of its own.
 */
const AGENT_MODEL_FLAGS = {
  claude: { model: '--model', effort: '--effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  codex: { model: '--model', effortConfig: 'model_reasoning_effort', levels: ['low', 'medium', 'high', 'xhigh'] },
  cursor: { model: '--model', levels: [] },
  // Gemini ids carry their tier — `gemini-3.6-flash-high` — so offering a
  // separate effort would ask the same question twice, and the two answers
  // could disagree. The CLI accepts --effort; the model list makes it moot.
  gemini: { model: '--model', effort: '--effort', levels: [] },
  antigravity: { model: '--model', effort: '--effort', levels: [] },
  grok: { model: '--model', effort: '--reasoning-effort', levels: ['low', 'medium', 'high'] },
};

/**
 * How to ask a CLI for its own model list, where it can answer.
 *
 * The static lists above go stale — `agy` reports gemini-3.6 while the list
 * shipped here knows only 3.5 — so the CLI's own answer wins when there is one.
 * Claude Code and Codex enumerate nothing, so for them the static list is it.
 */
const MODEL_LIST_ARGS = {
  antigravity: ['models'],
  gemini: ['models'],
  grok: ['models'],
  cursor: ['models'],
};

function modelListArgsFor(agentId) {
  return MODEL_LIST_ARGS[agentId] ? [...MODEL_LIST_ARGS[agentId]] : null;
}

/**
 * Reads model ids out of that output.
 *
 * The shapes differ — `agy` prints one id per line, `grok` prints a bulleted
 * list under prose — so this keeps only lines that look like a model id and
 * strips the decoration. Anything it cannot read yields nothing, which sends
 * the caller back to the static list rather than into a menu of prose.
 */
function parseModelList(agentId, output) {
  if (!MODEL_LIST_ARGS[agentId]) return [];

  const ids = [];
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim()
      .replace(/^[*\-•]\s*/, '')
      .replace(/\s*\((default|recommended)\)\s*$/i, '')
      .trim();
    // A model id is a single bare token: no spaces, no punctuation of prose.
    if (!line || /\s/.test(line) || /[:,]/.test(line)) continue;
    if (!/^[A-Za-z][\w.\-/]*$/.test(line)) continue;
    if (!ids.includes(line)) ids.push(line);
  }
  return ids;
}

function modelPresetsFor(agentId) {
  return AGENT_MODEL_PRESETS[agentId] ? [...AGENT_MODEL_PRESETS[agentId]] : [];
}

function effortLevelsFor(agentId) {
  return AGENT_MODEL_FLAGS[agentId] ? [...AGENT_MODEL_FLAGS[agentId].levels] : [];
}

/** The arguments that select a model and an effort, or none when unset. */
function modelArgsFor(agentId, model, effort) {
  const flags = AGENT_MODEL_FLAGS[agentId];
  const chosen = String(model || '').trim();
  if (!flags || !chosen) return [];

  const args = [flags.model, chosen];

  const level = String(effort || '').trim();
  if (level && flags.levels.includes(level)) {
    if (flags.effort) args.push(flags.effort, level);
    else if (flags.effortConfig) args.push('-c', `${flags.effortConfig}="${level}"`);
  }
  return args;
}

/**
 * Trims a stored per-CLI choice down to what this app can act on.
 *
 * `merge` takes this dictionary whole — its keys are data, so the settings
 * whitelist cannot vet them — which makes this the boundary that does. An
 * unknown agent, or a level its CLI would reject, is dropped rather than
 * written to disk and passed to the CLI later.
 */
function sanitizeCliModels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const clean = {};
  for (const [agentId, choice] of Object.entries(value)) {
    if (!AGENT_MODEL_FLAGS[agentId]) continue;
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)) continue;

    const model = String(choice.model || '').trim();
    const effort = String(choice.effort || '').trim();
    clean[agentId] = {
      model,
      effort: effortLevelsFor(agentId).includes(effort) ? effort : '',
      // Opt-in to unattended running for this CLI. Never inferred.
      unattended: choice.unattended === true,
    };
  }
  return clean;
}

module.exports = {
  AGENT_MODEL_PRESETS,
  AGENT_MODEL_FLAGS,
  modelPresetsFor,
  effortLevelsFor,
  modelArgsFor,
  modelListArgsFor,
  parseModelList,
  sanitizeCliModels,
};
