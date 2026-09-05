const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { app, BrowserWindow } = require('electron');
const settings = require('./settings.cjs');
const { safeFileName } = require('./security.cjs');
const {
  officeRuntimeRoot,
  resolveLibreOfficeExecutable,
} = require('./office/libreOffice.cjs');

/**
 * The main-process capabilities handed to `runtime: 'main'` tools as `ctx.host`.
 *
 * - `htmlToPdf` prints HTML through a hidden window with Chromium's own print
 *   pipeline — the layout engine behind every HTML/Markdown/Office conversion.
 * - `externalConvert` uses a configured command-line converter, or the detected
 *   LibreOffice executable for high-fidelity Office-to-PDF conversion.
 */

/** Prints are serialised: hidden windows are cheap but not free. */
let printChain = Promise.resolve();

const PRINT_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  javascript: false,
  partition: 'magiespdf-secure-print',
});

function isSafePrintRequest(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'data:' || protocol === 'blob:';
  } catch {
    return false;
  }
}

const safeTemporaryName = safeFileName;

function htmlToPdf(html, options, signal) {
  const job = printChain.then(() => printHtml(html, options, signal));
  // Keep the chain alive even when a job fails.
  printChain = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

async function printHtml(html, options, signal) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: PRINT_WEB_PREFERENCES,
  });
  const abort = () => window.destroy();

  try {
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isSafePrintRequest(details.url) });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!isSafePrintRequest(url)) event.preventDefault();
    });

    if (signal?.aborted) throw Object.assign(new Error('Print cancelled'), { code: 'ABORT_ERR' });
    signal?.addEventListener('abort', abort, { once: true });

    await window.loadURL(
      `data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`,
    );

    // Give webfonts/images referenced by the document one tick to settle.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const buffer = await window.webContents.printToPDF({
      pageSize: options.pageSize ?? 'A4',
      landscape: options.landscape ?? false,
      printBackground: options.printBackground ?? true,
      margins: {
        top: options.margins?.top ?? 0.6,
        bottom: options.margins?.bottom ?? 0.6,
        left: options.margins?.left ?? 0.6,
        right: options.margins?.right ?? 0.6,
      },
    });

    return new Uint8Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length));
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!window.isDestroyed()) window.destroy();
  }
}

function isExecutable(candidate) {
  if (!candidate) return false;
  try {
    require('node:fs').accessSync(candidate, require('node:fs').constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function converterConfigFrom(currentSettings, deps = {}) {
  const canRun = deps.isExecutable ?? isExecutable;
  const resolveLibreOffice = deps.resolveLibreOffice ?? resolveLibreOfficeExecutable;
  const external = currentSettings.externalConverter ?? {};
  if (canRun(external.executable)) {
    return {
      kind: 'custom',
      executable: external.executable,
      argumentTemplate: external.argumentTemplate ?? '',
      timeoutMs: external.timeoutMs ?? 120000,
    };
  }

  const libreOffice = resolveLibreOffice({
    bundledRoot: officeRuntimeRoot({
      packaged: deps.packaged ?? app?.isPackaged ?? false,
      resourcesPath: deps.resourcesPath ?? process.resourcesPath ?? '',
      projectRoot: deps.projectRoot ?? path.join(__dirname, '..'),
      platform: deps.platform ?? process.platform,
      arch: deps.arch ?? process.arch,
    }),
    configured: currentSettings.office?.libreOfficeExecutable ?? '',
    packaged: deps.packaged ?? app?.isPackaged ?? false,
    platform: deps.platform ?? process.platform,
  });
  if (libreOffice) {
    return {
      kind: 'libreoffice',
      executable: libreOffice,
      argumentTemplate: '--headless --nologo --nodefault --nofirststartwizard --norestore --convert-to {target} --outdir {out} {in}',
      timeoutMs: 120000,
    };
  }

  return { kind: 'none', executable: '', argumentTemplate: '', timeoutMs: 120000 };
}

function externalConverterConfig() {
  return converterConfigFrom(settings.read());
}

function converterSupports(config, targetExtension) {
  return config.kind === 'custom' || (config.kind === 'libreoffice' && targetExtension === 'pdf');
}

function hasExternalConverter(targetExtension) {
  return converterSupports(externalConverterConfig(), targetExtension);
}

/**
 * Runs the selected local converter: writes the input to a temp dir, substitutes
 * `{in}`/`{out}` in the argument template, and picks up `<stem>.<extension>`
 * from the output dir.
 */
async function externalConvert(input, targetExtension, signal) {
  const config = externalConverterConfig();
  if (!converterSupports(config, targetExtension)) {
    throw new Error('No local converter supports this format');
  }
  const { executable, argumentTemplate, timeoutMs } = config;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magiespdf-conv-'));
  try {
    const inputName = safeTemporaryName(input.name);
    if (!/^[a-z0-9]+$/i.test(targetExtension)) {
      throw new Error('External converter target extension is invalid');
    }
    const inputPath = path.join(workDir, inputName);
    await fs.writeFile(inputPath, Buffer.from(input.bytes));

    const args = argumentTemplate
      .split(/\s+/)
      .filter(Boolean)
      .map((argument) =>
        argument
          .replaceAll('{in}', inputPath)
          .replaceAll('{out}', workDir)
          .replaceAll('{target}', targetExtension),
      );

    await new Promise((resolve, reject) => {
      const child = execFile(executable, args, { timeout: timeoutMs || 120000 }, (error, _stdout, stderr) => {
        signal?.removeEventListener('abort', abort);
        if (error) reject(new Error(`External converter failed: ${error.message}\n${stderr}`));
        else resolve(undefined);
      });
      const abort = () => {
        child.kill();
        reject(Object.assign(new Error('External converter cancelled'), { code: 'ABORT_ERR' }));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });

    const stem = inputName.replace(/\.[^.]+$/, '');
    const expected = path.join(workDir, `${stem}.${targetExtension}`);
    const bytes = await fs.readFile(expected).catch(() => {
      throw new Error(`External converter produced no ${stem}.${targetExtension}`);
    });

    return {
      name: `${stem}.${targetExtension}`,
      bytes: new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)),
      mime: targetExtension === 'pdf' ? 'application/pdf' : 'application/octet-stream',
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {object} [options]
 * @param {(toolId: string, files: unknown[], params: object, signal?: AbortSignal,
 *          onProgress?: Function) => Promise<unknown>} [options.runTool]
 *   Runs another tool off this process. `advanced.batch` and
 *   `advanced.pipeline` have to run here — a step might need this bridge — but
 *   most steps do not, and doing their work here froze the window, the cancel
 *   button and the local API for the length of the run. Left out when there is
 *   nowhere to dispatch to, in which case the caller runs the step itself.
 */
function createHostBridge({ runTool } = {}) {
  const bridge = { htmlToPdf, externalConvert, hasExternalConverter };
  if (typeof runTool === 'function') bridge.runTool = runTool;
  return bridge;
}

module.exports = {
  converterConfigFrom,
  converterSupports,
  createHostBridge,
  htmlToPdf,
  PRINT_WEB_PREFERENCES,
  isSafePrintRequest,
  safeTemporaryName,
};
