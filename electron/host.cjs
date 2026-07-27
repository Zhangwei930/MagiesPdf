const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { BrowserWindow } = require('electron');
const settings = require('./settings.cjs');

/**
 * The main-process capabilities handed to `runtime: 'main'` tools as `ctx.host`.
 *
 * - `htmlToPdf` prints HTML through a hidden window with Chromium's own print
 *   pipeline — the layout engine behind every HTML/Markdown/Office conversion.
 * - `externalConvert` shells out to whatever command-line converter the user
 *   configured in Settings. MagiesPdf ships none and names none; the hook just
 *   exists for users who want maximum layout fidelity from their own tooling.
 */

/** Prints are serialised: hidden windows are cheap but not free. */
let printChain = Promise.resolve();

function htmlToPdf(html, options) {
  const job = printChain.then(() => printHtml(html, options));
  // Keep the chain alive even when a job fails.
  printChain = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

async function printHtml(html, options) {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });

  try {
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
    window.destroy();
  }
}

function externalConverterConfig() {
  const { executable, argumentTemplate, timeoutMs } = settings.read().externalConverter;
  return { executable, argumentTemplate, timeoutMs };
}

function hasExternalConverter() {
  const { executable } = externalConverterConfig();
  if (!executable) return false;
  try {
    require('node:fs').accessSync(executable, require('node:fs').constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the configured converter: writes the input to a temp dir, substitutes
 * `{in}`/`{out}` in the argument template, and picks up `<stem>.<extension>`
 * from the output dir.
 */
async function externalConvert(input, targetExtension) {
  const { executable, argumentTemplate, timeoutMs } = externalConverterConfig();
  if (!hasExternalConverter()) {
    throw new Error('No external converter is configured');
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'magiespdf-conv-'));
  try {
    const inputPath = path.join(workDir, input.name);
    await fs.writeFile(inputPath, Buffer.from(input.bytes));

    const args = argumentTemplate
      .split(/\s+/)
      .filter(Boolean)
      .map((argument) => argument.replaceAll('{in}', inputPath).replaceAll('{out}', workDir));

    await new Promise((resolve, reject) => {
      execFile(executable, args, { timeout: timeoutMs || 120000 }, (error, _stdout, stderr) => {
        if (error) reject(new Error(`External converter failed: ${error.message}\n${stderr}`));
        else resolve(undefined);
      });
    });

    const stem = input.name.replace(/\.[^.]+$/, '');
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

function createHostBridge() {
  return { htmlToPdf, externalConvert, hasExternalConverter };
}

module.exports = { createHostBridge, htmlToPdf };
