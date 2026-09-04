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
  // Only a fallback: `cursor-agent models` answers, and its answer wins. Kept
  // in step with that answer anyway, because a fallback that offers models the
  // CLI does not have fails the turn rather than the lookup.
  cursor: [
    { id: 'auto', name: 'Auto', description: 'Recommended' },
    { id: 'composer-2.5', name: 'Composer 2.5' },
    { id: 'gpt-5.3-codex-low', name: 'Codex 5.3 Low', description: 'Fastest' },
    { id: 'gpt-5.3-codex', name: 'Codex 5.3' },
    { id: 'gpt-5.3-codex-high', name: 'Codex 5.3 High' },
    { id: 'gpt-5.3-codex-xhigh', name: 'Codex 5.3 Extra High' },
    { id: 'claude-opus-5-thinking-high', name: 'Claude Opus 5 Thinking' },
    { id: 'claude-sonnet-5-thinking-high', name: 'Claude Sonnet 5 Thinking' },
    { id: 'gpt-5.6-sol-high', name: 'GPT-5.6 Sol High' },
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
  // cursor-agent and gemini have no effort flag — `--help` on the installed
  // binaries does not mention one, and their tiers are part of the model id
  // instead (`gpt-5.3-codex-xhigh`, `gemini-3.8-flash-low`). So the model list
  // is the tier selector for these two, which is why it has to be the CLI's
  // own list and not a shipped one that has gone stale.
  cursor: { model: '--model', levels: [] },
  gemini: { model: '--model', levels: [] },
  // agy does document one: `--effort  Reasoning effort ... (low|medium|high)`.
  antigravity: { model: '--model', effort: '--effort', levels: ['low', 'medium', 'high'] },
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

/**
 * Variants left out of the list the panel offers.
 *
 * cursor-agent answers with every model twice — `gpt-5.3-codex-high` and
 * `gpt-5.3-codex-high-fast` — which was 70 of the 217 entries it returned. That
 * is a second axis wearing the model's clothes, and it doubles a dropdown that
 * is already long. Every `-fast` had a plain twin, so nothing here becomes
 * unreachable: the id can still be typed into the CLI itself, which is true of
 * every model this app does not list.
 */
const HIDDEN_MODEL_VARIANTS = {
  cursor: /-fast$/,
};

function modelListArgsFor(agentId) {
  return MODEL_LIST_ARGS[agentId] ? [...MODEL_LIST_ARGS[agentId]] : null;
}

/**
 * Reads the models out of that output.
 *
 * Every CLI here prints the id beside a human label, and each does it
 * differently — `cursor-agent` writes `gpt-5.3-codex-low - Codex 5.3 Low`,
 * `agy` separates with a tab, `grok` bullets a bare id under prose. The parser
 * used to demand a bare token, so two of the three never matched and fell back
 * to the shipped list on every launch; that list had drifted far enough to
 * offer cursor models the CLI does not have.
 *
 * The label is kept, because for cursor and gemini the tier *is* the model —
 * "Codex 5.3 Extra High" is the thing a person is choosing, and reading it off
 * `gpt-5.3-codex-xhigh` is work the CLI already did.
 *
 * Anything it cannot read yields nothing, which sends the caller back to the
 * static list rather than into a menu of prose.
 */
function parseModelList(agentId, output) {
  if (!MODEL_LIST_ARGS[agentId]) return [];

  const models = [];
  const seen = new Set();
  for (const raw of String(output || '').split('\n')) {
    const line = raw.trim()
      .replace(/^[*\-•]\s*/, '')
      .replace(/\s*\((default|recommended)\)\s*$/i, '')
      .trim();
    if (!line) continue;

    // `id - Label`, `id\tLabel`, or `id   Label`; otherwise the whole line.
    const split = /^(\S+)(?:\s+-\s+|\t+|\s{2,})(.*)$/.exec(line);
    const id = (split ? split[1] : line).trim();
    const label = split ? split[2].trim() : '';

    // A model id is a bare token: no spaces, no punctuation of prose. This is
    // what keeps `Available models` and `You are not authenticated.` out.
    if (!/^[A-Za-z][\w.\-/]*$/.test(id)) continue;
    if (HIDDEN_MODEL_VARIANTS[agentId]?.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: label || id });
  }
  return models;
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
