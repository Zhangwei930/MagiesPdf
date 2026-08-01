'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { redactedText } = require('./history.cjs');
const { requiresInteractiveApproval } = require('./automationPolicy.cjs');

const MAX_RULES = 20;
const MAX_PENDING = 100;
const MAX_RUNS = 100;
const SUPPORTED_EXTENSIONS = new Set([
  '.doc', '.docx', '.odt', '.rtf',
  '.xls', '.xlsx', '.ods',
  '.ppt', '.pptx', '.odp',
  '.pdf',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function normalizeTrigger(value) {
  if (value?.type === 'daily') {
    const at = boundedText(value.at, 5);
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at)) {
      throw new Error('Daily automation time must use HH:MM');
    }
    return { type: 'daily', at };
  }
  if (value?.type === 'folder') {
    const extensions = [...new Set((Array.isArray(value.extensions) ? value.extensions : [])
      .map((extension) => boundedText(extension, 16).toLowerCase())
      .filter(Boolean)
      .map((extension) => extension.startsWith('.') ? extension : `.${extension}`))]
      .filter((extension) => SUPPORTED_EXTENSIONS.has(extension))
      .sort();
    if (extensions.length === 0) {
      throw new Error('Folder automation requires a supported document extension');
    }
    return { type: 'folder', extensions };
  }
  throw new Error('Automation trigger must be daily or folder');
}

function normalizeAllowedToolIds(value, mode) {
  if (mode === 'review') return [];
  const toolIds = [...new Set((Array.isArray(value) ? value : [])
    .map((toolId) => boundedText(toolId, 200))
    .filter(Boolean))].slice(0, 20);
  if (toolIds.length === 0) {
    throw new Error('Unattended automation requires at least one allowed Office tool');
  }
  if (toolIds.some((toolId) => !toolId.startsWith('office:'))) {
    throw new Error('Unattended automation tools must use the office: namespace');
  }
  if (toolIds.some(requiresInteractiveApproval)) {
    throw new Error('This Office tool requires interactive approval and cannot run unattended');
  }
  return toolIds;
}

function normalizeRule(input, defaults) {
  const name = boundedText(input?.name, 100);
  const prompt = redactedText(input?.prompt, 4000);
  if (!name) throw new Error('Automation rule name is required');
  if (!prompt) throw new Error('Automation rule prompt is required');
  const mode = input?.mode === 'unattended' ? 'unattended' : 'review';
  return {
    id: defaults.id,
    name,
    prompt,
    mode,
    trigger: normalizeTrigger(input?.trigger),
    allowedToolIds: normalizeAllowedToolIds(input?.allowedToolIds, mode),
    maxRunsPerDay: boundedInteger(input?.maxRunsPerDay, 5, 1, 20),
    retryLimit: boundedInteger(input?.retryLimit, 1, 0, 2),
    enabled: input?.enabled !== false,
    failureCount: boundedInteger(input?.failureCount, 0, 0, Number.MAX_SAFE_INTEGER),
    lastError: redactedText(input?.lastError, 1000),
    runDate: boundedText(input?.runDate, 10),
    runCount: boundedInteger(input?.runCount, 0, 0, Number.MAX_SAFE_INTEGER),
    lastDailyDate: boundedText(input?.lastDailyDate, 10),
    createdAt: defaults.createdAt,
    updatedAt: defaults.updatedAt,
  };
}

function normalizePending(value) {
  const id = boundedText(value?.id, 100);
  const ruleId = boundedText(value?.ruleId, 100);
  const createdAt = Number(value?.createdAt);
  const prompt = redactedText(value?.prompt, 4000);
  if (!id || !ruleId || !Number.isFinite(createdAt) || !prompt) return undefined;
  return {
    id,
    ruleId,
    createdAt,
    prompt,
    sourcePath: boundedText(value?.sourcePath, 1000),
  };
}

function normalizeRun(value) {
  const id = boundedText(value?.id, 100);
  const ruleId = boundedText(value?.ruleId, 100);
  const createdAt = Number(value?.createdAt);
  if (!id || !ruleId || !Number.isFinite(createdAt)) return undefined;
  const status = ['queued', 'success', 'error'].includes(value?.status) ? value.status : 'error';
  return {
    id,
    ruleId,
    createdAt,
    status,
    attempts: boundedInteger(value?.attempts, 0, 0, 3),
    message: redactedText(value?.message, 1000),
    sourcePath: boundedText(value?.sourcePath, 1000),
  };
}

function createAutomationStore({
  filePath,
  now = Date.now,
  createId = crypto.randomUUID,
  logger = console,
}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('AI automation file path is required');
  }
  let state;

  function readState() {
    if (state) return state;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const rules = (Array.isArray(parsed?.rules) ? parsed.rules : []).slice(0, MAX_RULES).flatMap((rule) => {
        try {
          const createdAt = Number(rule?.createdAt);
          const updatedAt = Number(rule?.updatedAt);
          if (!rule?.id || !Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return [];
          return [normalizeRule(rule, { id: String(rule.id), createdAt, updatedAt })];
        } catch {
          return [];
        }
      });
      const pending = (Array.isArray(parsed?.pending) ? parsed.pending : [])
        .slice(0, MAX_PENDING).map(normalizePending).filter(Boolean);
      const runs = (Array.isArray(parsed?.runs) ? parsed.runs : [])
        .slice(0, MAX_RUNS).map(normalizeRun).filter(Boolean);
      state = { rules, pending, runs };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`[magiespdf] AI automations unreadable, starting empty: ${error.message}`);
      }
      state = { rules: [], pending: [], runs: [] };
    }
    return state;
  }

  function persist(next) {
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, filePath);
      fs.chmodSync(filePath, 0o600);
      state = next;
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }

  function updateRule(ruleId, updater) {
    const current = readState();
    const index = current.rules.findIndex((rule) => rule.id === String(ruleId));
    if (index < 0) return undefined;
    const rules = [...current.rules];
    rules[index] = updater(rules[index]);
    persist({ ...current, rules });
    return clone(rules[index]);
  }

  return {
    getState() {
      return clone(readState());
    },
    createRule(input) {
      const current = readState();
      const timestamp = Number(now());
      const rule = normalizeRule(input, {
        id: String(createId()),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      persist({ ...current, rules: [rule, ...current.rules].slice(0, MAX_RULES) });
      return clone(rule);
    },
    canTrigger(ruleId, dateKey) {
      const rule = readState().rules.find((candidate) => candidate.id === String(ruleId));
      if (!rule?.enabled) return false;
      return rule.runDate !== dateKey || rule.runCount < rule.maxRunsPerDay;
    },
    recordTrigger(ruleId, dateKey) {
      return updateRule(ruleId, (rule) => ({
        ...rule,
        runDate: dateKey,
        runCount: rule.runDate === dateKey ? rule.runCount + 1 : 1,
        lastDailyDate: rule.trigger.type === 'daily' ? dateKey : rule.lastDailyDate,
        updatedAt: Number(now()),
      }));
    },
    enqueue(ruleId, input) {
      const current = readState();
      if (!current.rules.some((rule) => rule.id === String(ruleId))) {
        throw new Error('Automation rule was not found');
      }
      const pending = normalizePending({
        ...input,
        id: String(createId()),
        ruleId: String(ruleId),
        createdAt: Number(now()),
      });
      if (!pending) throw new Error('Pending automation prompt is required');
      persist({ ...current, pending: [pending, ...current.pending].slice(0, MAX_PENDING) });
      return clone(pending);
    },
    resolvePending(pendingId) {
      const current = readState();
      const pending = current.pending.filter((item) => item.id !== String(pendingId));
      if (pending.length === current.pending.length) return false;
      persist({ ...current, pending });
      return true;
    },
    recordResult(ruleId, result) {
      return updateRule(ruleId, (rule) => ({
        ...rule,
        enabled: result?.pause === true ? false : rule.enabled,
        failureCount: result?.success === true ? 0 : rule.failureCount + 1,
        lastError: result?.success === true ? '' : redactedText(result?.error, 1000),
        updatedAt: Number(now()),
      }));
    },
    setRuleEnabled(ruleId, enabled) {
      return updateRule(ruleId, (rule) => ({
        ...rule,
        enabled: enabled === true,
        failureCount: enabled === true ? 0 : rule.failureCount,
        lastError: enabled === true ? '' : rule.lastError,
        updatedAt: Number(now()),
      }));
    },
    addRun(input) {
      const current = readState();
      const run = normalizeRun({
        ...input,
        id: String(createId()),
        createdAt: Number(now()),
      });
      if (!run) throw new Error('Automation run requires a rule id');
      persist({ ...current, runs: [run, ...current.runs].slice(0, MAX_RUNS) });
      return clone(run);
    },
    deleteRule(ruleId) {
      const current = readState();
      const rules = current.rules.filter((rule) => rule.id !== String(ruleId));
      if (rules.length === current.rules.length) return false;
      persist({
        ...current,
        rules,
        pending: current.pending.filter((pending) => pending.ruleId !== String(ruleId)),
      });
      return true;
    },
  };
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  createAutomationStore,
};
