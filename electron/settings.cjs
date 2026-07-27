const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

/**
 * User settings, stored as a single JSON file under the OS app-data directory.
 *
 * Everything MagiesPdf keeps lives on this machine — there is no account, no sync
 * and no telemetry — so a plain file is the whole persistence story.
 */

const DEFAULTS = {
  locale: 'zh',
  theme: 'system',
  /** Where "save all" starts. Empty means "ask every time". */
  defaultOutputDirectory: '',
  /** Overwrite silently, or add " (2)" to the name. */
  onNameCollision: 'rename',
  /**
   * Tool ids most recently run, newest first. Kept here rather than in
   * localStorage: the packaged renderer is served over file://, where storage
   * access throws outright — so it would work in dev and silently forget in
   * production, which is the worst possible failure mode.
   */
  recentToolIds: [],
  /**
   * Check for updates on launch and auto-download when a newer release exists.
   * User can still choose when to install. Default on (same expectation as MagiesTerminal).
   */
  autoUpdate: true,
  /** Local REST API, off unless the user turns it on. */
  api: {
    enabled: false,
    port: 8737,
    /** Requests must present this as `Authorization: Bearer <token>`. */
    token: '',
    /** Bind to loopback only; exposing it on the LAN has to be deliberate. */
    allowLan: false,
  },
  /**
   * Optional external command-line document converter, used by the Office
   * conversion tools when configured. MagiesPdf ships no converter of its own
   * and makes no assumption about which one this is.
   */
  externalConverter: {
    executable: '',
    /** `{in}` and `{out}` are substituted with the input file and output directory. */
    argumentTemplate: '',
    timeoutMs: 120000,
  },
  /**
   * User-saved pipeline definitions for the visual builder.
   * Each entry: { id, name, steps: [{ toolId, params }], updatedAt }.
   */
  pipelinePresets: [],
};

let cache = null;
let settingsPath = null;

function filePath() {
  if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'settings.json');
  return settingsPath;
}

/** Deep merge of stored values over defaults, so a new setting appears without migration. */
function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base)) continue;
    const current = base[key];
    result[key] =
      current && typeof current === 'object' && !Array.isArray(current)
        ? merge(current, value)
        : value;
  }
  return result;
}

function read() {
  if (cache) return cache;

  try {
    cache = merge(DEFAULTS, JSON.parse(fs.readFileSync(filePath(), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[magiespdf] settings unreadable, falling back to defaults:', error.message);
    }
    cache = { ...DEFAULTS };
  }
  return cache;
}

function write(patch) {
  cache = merge(read(), patch);
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (error) {
    // Surfacing this beats silently losing the user's preferences.
    console.error('[magiespdf] failed to persist settings:', error.message);
    throw error;
  }
  return cache;
}

module.exports = { DEFAULTS, read, write, merge };
