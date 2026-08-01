'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');

const DEFAULT_POLL_MS = 30_000;
const OUTPUT_DIRECTORY = 'Magies Office Output/';

function pad(number) {
  return String(number).padStart(2, '0');
}

function localClock(timestamp) {
  const date = new Date(timestamp);
  return {
    dateKey: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createAutomationEngine({
  store,
  officeProvider,
  aiService,
  emit = () => {},
  now = Date.now,
  createId = randomUUID,
  pollMs = DEFAULT_POLL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  let timer;
  let polling;
  let workspacePath = '';
  const folderBaselines = new Map();

  async function executeRule(rule, dateKey, sourcePath = '') {
    if (!store.canTrigger(rule.id, dateKey)) return;
    store.recordTrigger(rule.id, dateKey);
    const prompt = sourcePath
      ? `${rule.prompt}\n\n[Triggered file]\n${sourcePath}`
      : rule.prompt;

    if (rule.mode === 'review') {
      const pending = store.enqueue(rule.id, { prompt, sourcePath });
      const run = store.addRun({
        ruleId: rule.id,
        status: 'queued',
        attempts: 0,
        message: 'Waiting for review',
        sourcePath,
      });
      emit({ type: 'pending', pending, run });
      return;
    }

    for (let attempt = 1; attempt <= rule.retryLimit + 1; attempt += 1) {
      let successfulTool = false;
      try {
        const result = await aiService.runUnattended({
          requestId: `automation-${createId()}`,
          prompt,
          history: [],
          files: [],
          locale: 'zh',
          allowedToolIds: rule.allowedToolIds,
        }, (event) => {
          if (event?.type === 'tool_result' && event.ok === true
            && String(event.toolId || '').startsWith('office:')) {
            successfulTool = true;
          }
          emit({ type: 'run_event', ruleId: rule.id, event });
        });
        store.recordResult(rule.id, { success: true });
        const run = store.addRun({
          ruleId: rule.id,
          status: 'success',
          attempts: attempt,
          message: result?.message || 'Completed',
          sourcePath,
        });
        emit({ type: 'completed', ruleId: rule.id, run });
        return;
      } catch (error) {
        const finalAttempt = attempt > rule.retryLimit;
        if (!successfulTool && !finalAttempt) continue;
        store.recordResult(rule.id, {
          success: false,
          error: errorMessage(error),
          pause: true,
        });
        const run = store.addRun({
          ruleId: rule.id,
          status: 'error',
          attempts: attempt,
          message: errorMessage(error),
          sourcePath,
        });
        emit({ type: 'failed', ruleId: rule.id, run });
        return;
      }
    }
  }

  async function scanDocuments() {
    const result = await officeProvider.callTool('office_workspace_list', { recursive: true });
    return Array.isArray(result?.documents) ? result.documents : [];
  }

  async function pollOnce() {
    const { dateKey, time } = localClock(now());
    const status = officeProvider.getWorkspaceStatus();
    const configured = status?.configured === true;
    const rules = store.getState().rules;

    for (const rule of rules) {
      if (!rule.enabled || rule.trigger.type !== 'daily') continue;
      if (time < rule.trigger.at || rule.lastDailyDate === dateKey) continue;
      if (rule.mode === 'unattended' && !configured) continue;
      await executeRule(rule, dateKey);
    }

    const folderRules = rules.filter((rule) => rule.enabled && rule.trigger.type === 'folder');
    if (!configured || folderRules.length === 0) return;
    if (workspacePath !== status.path) {
      workspacePath = status.path;
      folderBaselines.clear();
    }
    const documents = await scanDocuments();
    for (const rule of folderRules) {
      const extensions = new Set(rule.trigger.extensions);
      const current = new Set(documents.flatMap((document) => {
        const relativePath = String(document?.path || '').replaceAll('\\', '/');
        const extension = String(document?.extension || path.extname(relativePath)).toLowerCase();
        return relativePath && !relativePath.startsWith(OUTPUT_DIRECTORY) && extensions.has(extension)
          ? [relativePath]
          : [];
      }));
      const previous = folderBaselines.get(rule.id);
      folderBaselines.set(rule.id, current);
      if (!previous) continue;
      const added = [...current].filter((relativePath) => !previous.has(relativePath)).sort();
      for (const relativePath of added) {
        if (!store.canTrigger(rule.id, dateKey)) break;
        await executeRule(rule, dateKey, relativePath);
      }
    }
  }

  return {
    async poll() {
      if (polling) return polling;
      polling = pollOnce().finally(() => { polling = undefined; });
      return polling;
    },
    start() {
      if (timer) return;
      timer = setIntervalFn(() => {
        this.poll().catch((error) => emit({ type: 'engine_error', message: errorMessage(error) }));
      }, pollMs);
      this.poll().catch((error) => emit({ type: 'engine_error', message: errorMessage(error) }));
    },
    stop() {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = undefined;
    },
  };
}

module.exports = {
  createAutomationEngine,
  localClock,
};
