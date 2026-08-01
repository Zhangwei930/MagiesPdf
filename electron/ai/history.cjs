const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_AI_HISTORY_ENTRIES = 50;
const MAX_PROMPT_LENGTH = 4000;
const MAX_RESPONSE_LENGTH = 4000;

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function redactedText(value, maxLength) {
  return boundedText(value, maxLength)
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [redacted]')
    .replace(
      /((?:api[\s_-]?key|password|passwd|secret|access[\s_-]?token|refresh[\s_-]?token|token|密码|口令)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi,
      '$1[redacted]',
    );
}

function localizedName(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = {};
  const zh = boundedText(value.zh, 128);
  const en = boundedText(value.en, 128);
  if (zh) name.zh = zh;
  if (en) name.en = en;
  return Object.keys(name).length > 0 ? name : undefined;
}

function workflowSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((step) => {
    const toolId = boundedText(step?.toolId, 200);
    if (!toolId) return [];
    const toolName = localizedName(step.toolName);
    return [{ toolId, ...(toolName ? { toolName } : {}) }];
  });
}

function toolActivities(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((tool) => {
    const toolId = boundedText(tool?.toolId, 200);
    if (!toolId) return [];
    const toolName = localizedName(tool.toolName);
    return [{
      toolId,
      ...(toolName ? { toolName } : {}),
      status: tool.status === 'done' ? 'done' : 'error',
    }];
  });
}

function artifactNames(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((artifact) => {
    const name = boundedText(artifact?.name, 255);
    return name ? [{ name }] : [];
  });
}

function historyEntry(input, { id, createdAt }) {
  const prompt = redactedText(input?.prompt, MAX_PROMPT_LENGTH);
  if (!prompt) throw new Error('AI history prompt is required');
  return {
    id,
    createdAt,
    prompt,
    response: redactedText(input?.response, MAX_RESPONSE_LENGTH),
    success: input?.success === true,
    workflow: workflowSteps(input?.workflow),
    tools: toolActivities(input?.tools),
    artifacts: artifactNames(input?.artifacts),
  };
}

function storedEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_AI_HISTORY_ENTRIES).flatMap((entry) => {
    const id = boundedText(entry?.id, 100);
    const createdAt = Number(entry?.createdAt);
    if (!id || !Number.isFinite(createdAt)) return [];
    try {
      return [historyEntry(entry, { id, createdAt })];
    } catch {
      return [];
    }
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createAiHistoryStore({
  filePath,
  now = Date.now,
  createId = crypto.randomUUID,
  logger = console,
}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw new Error('AI history file path is required');
  }
  let cache;

  function readEntries() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      cache = storedEntries(parsed?.entries);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        logger.error(`[magiespdf] AI history unreadable, starting empty: ${error.message}`);
      }
      cache = [];
    }
    return cache;
  }

  function persist(entries) {
    const directory = path.dirname(filePath);
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporaryPath, filePath);
      fs.chmodSync(filePath, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not have been created.
      }
      throw error;
    }
  }

  return {
    list() {
      return clone(readEntries());
    },
    append(input) {
      const entry = historyEntry(input, {
        id: String(createId()),
        createdAt: Number(now()),
      });
      const next = [entry, ...readEntries()].slice(0, MAX_AI_HISTORY_ENTRIES);
      persist(next);
      cache = next;
      return clone(entry);
    },
    clear() {
      persist([]);
      cache = [];
      return true;
    },
  };
}

module.exports = {
  MAX_AI_HISTORY_ENTRIES,
  createAiHistoryStore,
  redactedText,
};
