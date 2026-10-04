const path = require('node:path');

/**
 * The x2t converter — the only thing that reads or writes document bytes.
 *
 * The editor never sees a .docx. It edits `Editor.bin`, an internal format that
 * x2t converts to and from. So every open is `document → bin` and every save is
 * `bin → document`, and this module owns both directions.
 *
 * Two things about x2t cost real time to discover:
 *
 * - **It must be driven by a params XML.** Passing the two paths as arguments
 *   fails with "Couldn't create temp folder", because it then resolves its
 *   scratch directory relative to the executable — which is inside the read-only
 *   app bundle. The XML lets us hand it a writable `m_sTempDir`.
 * - **The output format is a numeric id, not an extension.** Getting it wrong
 *   produces a file that opens nowhere, with no error, so the ids are pinned by
 *   test rather than inferred at runtime.
 */

/**
 * x2t's own format ids, from the converter's `OfficeFileFormatDefines`.
 *
 * Every id here was confirmed against the real converter by putting a document
 * through it. PDF (513) is left out on purpose: the converter renders it through
 * DoctRenderer, which needs a font manifest describing the machine it runs on —
 * one that cannot be shipped — and without it fails with `<error code="open"/>`,
 * which reads like a broken format id and is not one. PDF is the bundled
 * LibreOffice's job (`libreOfficeRender.cjs`).
 */
const DOCUMENT_FORMATS = new Map([
  ['.docx', 65],
  ['.doc', 66],
  ['.odt', 67],
  ['.rtf', 68],
  ['.pptx', 129],
  ['.ppt', 130],
  ['.odp', 131],
  ['.xlsx', 257],
  ['.xls', 258],
  ['.ods', 259],
]);

/** One canvas format per editor: text, spreadsheet, presentation. */
const EDITOR_FORMATS = new Map([
  ['.docx', 8193],
  ['.doc', 8193],
  ['.odt', 8193],
  ['.rtf', 8193],
  ['.xlsx', 8194],
  ['.xls', 8194],
  ['.ods', 8194],
  ['.pptx', 8195],
  ['.ppt', 8195],
  ['.odp', 8195],
]);

function extensionOf(candidate) {
  return path.extname(String(candidate)).toLowerCase();
}

function documentFormatId(candidate) {
  return DOCUMENT_FORMATS.get(extensionOf(candidate)) ?? 0;
}

function editorFormatId(candidate) {
  return EDITOR_FORMATS.get(extensionOf(candidate)) ?? 0;
}

function x2tExecutablePath(runtimeRoot, platform = process.platform) {
  const name = platform === 'win32' ? 'x2t.exe' : 'x2t';
  return path.join(runtimeRoot, 'converter', name);
}

/** XML has five characters that must never reach the parser raw. */
function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function paramsXml({ from, to, formatTo, tempDir, fontsDir }) {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    `  <m_sFileFrom>${escapeXml(from)}</m_sFileFrom>`,
    `  <m_sFileTo>${escapeXml(to)}</m_sFileTo>`,
    `  <m_nFormatTo>${formatTo}</m_nFormatTo>`,
    `  <m_sTempDir>${escapeXml(tempDir)}</m_sTempDir>`,
    `  <m_sFontDir>${escapeXml(fontsDir)}</m_sFontDir>`,
    '  <m_bIsNoBase64>true</m_bIsNoBase64>',
    '</TaskQueueDataConvert>',
    '',
  ].join('\n');
}

function createX2t(deps) {
  const { executable, fontsDir, tempRoot, fs, run, uniqueId } = deps;

  function requireAbsolute(candidate) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) {
      throw new Error('An absolute document path is required');
    }
    return candidate;
  }

  async function convert({ from, to, formatTo, workDir }) {
    const paramsPath = path.join(workDir, 'params.xml');
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(
      paramsPath,
      paramsXml({ from, to, formatTo, tempDir: workDir, fontsDir }),
      'utf8',
    );
    const result = await run(executable, [paramsPath]);
    if (result.code !== 0) {
      throw new Error(`x2t failed with exit ${result.code}: ${result.stderr ?? ''}`.trim());
    }
  }

  return {
    /** Document on disk → `Editor.bin` in a fresh work directory. */
    async toEditorFormat(sourcePath) {
      requireAbsolute(sourcePath);
      const formatTo = editorFormatId(sourcePath);
      if (formatTo === 0) throw new Error(`Unsupported document format: ${sourcePath}`);

      const workDir = path.join(tempRoot, uniqueId());
      const binPath = path.join(workDir, 'Editor.bin');
      await convert({ from: sourcePath, to: binPath, formatTo, workDir });
      return { binPath, workDir };
    },

    /** `Editor.bin` → a document on disk, in the format the target names. */
    async fromEditorFormat(binPath, targetPath) {
      requireAbsolute(binPath);
      requireAbsolute(targetPath);
      const formatTo = documentFormatId(targetPath);
      if (formatTo === 0) throw new Error(`Unsupported document format: ${targetPath}`);

      await convert({
        from: binPath,
        to: targetPath,
        formatTo,
        workDir: path.dirname(binPath),
      });
      return targetPath;
    },

    /**
     * Work directories hold a copy of the user's document, so they are removed
     * as soon as a session ends — but only ever inside our own temp root, so a
     * bad path from the renderer cannot turn this into a delete primitive.
     */
    async discard(workDir) {
      const resolved = path.resolve(String(workDir));
      const root = path.resolve(tempRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('Refusing to remove a directory outside the converter temp root');
      }
      await fs.rm(resolved, { recursive: true, force: true });
    },
  };
}

module.exports = { createX2t, documentFormatId, editorFormatId, x2tExecutablePath };
