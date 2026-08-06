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
  /** Which palette each mode paints; ids come from src/app/theme/themes.ts. */
  themeLight: 'indigo-light',
  themeDark: 'indigo-dark',
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
  /** Documents opened most recently, stored as paths only and never uploaded. */
  recentDocuments: [],
  /**
   * Check for updates on launch and download in the background when a newer
   * build is found. Installation still always requires an explicit restart
   * click — packages are unsigned, so we never install silently.
   */
  autoUpdate: true,
  /**
   * The welcome tour has been dismissed for good. It must be named here or the
   * whitelist in `merge` throws the flag away on write, and the tour returns on
   * every launch however often it is closed.
   */
  onboardingComplete: false,
  /** Local REST API, off unless the user turns it on. */
  api: {
    enabled: false,
    port: 8737,
    /** Requests must present this as `Authorization: Bearer <token>`. */
    token: '',
    /** Bind to loopback only; exposing it on the LAN has to be deliberate. */
    allowLan: false,
    /** LAN binding is HTTPS-only and requires user-provided PEM files. */
    tlsCertPath: '',
    tlsKeyPath: '',
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
  /** Local Office-suite engine. */
  office: {
    /** Empty means auto-detect the platform's standard LibreOffice installation. */
    libreOfficeExecutable: '',
  },
  /**
   * OpenAI-compatible model providers used by the local Agent runtime. API keys
   * live in safeStorage, one per provider — never here.
   *
   * `baseUrl` and `model` are the pre-list shape, kept so an older settings
   * file still merges; `electron/ai/providerStore.cjs` migrates them into the
   * list on read. Do not write to them.
   */
  ai: {
    /**
     * A fresh install starts on DeepSeek so the only step left is pasting a
     * key. Deleting it sticks: `merge` replaces arrays rather than merging
     * them, so an empty stored list is not refilled from here.
     */
    providers: [{
      id: 'deepseek',
      providerId: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      enabled: true,
    }],
    activeProviderId: 'deepseek',
    /**
     * 'confirm' asks before every tool call that writes a file or leaves the
     * machine. 'auto' runs them unattended — except the interactive-only list
     * in automationPolicy.cjs, which always stops for a person.
     */
    permissionMode: 'confirm',
    /**
     * Per-CLI model and effort, keyed by agent id. Each CLI takes its own model
     * ids and its own effort levels, so one shared value would be wrong for all
     * but one of them.
     */
    cliModels: {},
    /** Refuse any turn that would leave this machine. Off by default. */
    strictLocalPrivacy: false,
    /**
     * The one tool that reaches the public internet. Its key lives in
     * safeStorage under `webSearch`, never here.
     */
    webSearch: {
      enabled: false,
      provider: 'tavily',
      /** Only used by a self-hosted SearXNG. */
      endpoint: '',
    },
    /**
     * Pictures for documents. Its key lives in safeStorage under `imageSearch`.
     *
     * 'auto' asks the configured model provider for them, using the key that is
     * already there — nobody sets up a second one, so any other default would
     * make this a feature almost no installation has. It resolves to nothing on
     * a provider that serves no images, which withdraws the tool.
     */
    images: {
      enabled: true,
      provider: 'auto',
      /** Only for a self-named OpenAI-compatible endpoint. */
      endpoint: '',
      model: '',
    },
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    maxSteps: 6,
  },
  /**
   * User-saved pipeline definitions for the visual builder.
   * Each entry: { id, name, steps: [{ toolId, params }], updatedAt }.
   */
  pipelinePresets: [],
};

let cache = null;
let settingsPath = null;

function preserveLegacyUserDataPath(electronApp = app) {
  electronApp.setPath('userData', path.join(electronApp.getPath('appData'), 'MagiesPdf'));
}

function filePath() {
  if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'settings.json');
  return settingsPath;
}

/**
 * Deep merge of stored values over defaults, so a new setting appears without
 * migration.
 *
 * Keys the defaults do not name are dropped: that whitelist is what keeps
 * unknown fields out of the settings file. An **empty** object in the defaults
 * is the exception — it names no keys because its keys are data (an agent id, a
 * provider id), so recursing into it would throw every entry away. Those are
 * taken whole, and validated at the IPC boundary instead.
 */
function isOpenDictionary(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;

  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (!(key in base)) continue;
    const current = base[key];
    result[key] =
      current && typeof current === 'object' && !Array.isArray(current) && !isOpenDictionary(current)
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
    fs.writeFileSync(filePath(), `${JSON.stringify(cache, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(filePath(), 0o600);
  } catch (error) {
    // Surfacing this beats silently losing the user's preferences.
    console.error('[magiespdf] failed to persist settings:', error.message);
    throw error;
  }
  return cache;
}

module.exports = { DEFAULTS, read, write, merge, preserveLegacyUserDataPath };
