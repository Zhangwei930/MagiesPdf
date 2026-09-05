import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ToolMeta, ToolOutputFile } from '@core/types.ts';
import {
  canApplyInstantly,
  canApplyToDocument,
  canOpenFromDocument,
  canQuickApplyWithConfirm,
  classifyOutput,
  documentTaskParams,
} from './toolApply.ts';

const tool = (
  input: Partial<ToolMeta['input']> = {},
  params: ToolMeta['params'] = [],
  output: ToolMeta['output'] = 'single',
): ToolMeta =>
  ({
    id: 'organize.rotate',
    input: { accept: ['.pdf'], min: 1, max: 1, ...input },
    params,
    output,
  }) as ToolMeta;

const output = (name: string, size = 4): ToolOutputFile => ({
  name,
  mime: 'application/pdf',
  bytes: new Uint8Array(size),
});

describe('canApplyToDocument', () => {
  it('accepts a tool that takes exactly one PDF', () => {
    assert.equal(canApplyToDocument(tool({})), true);
  });

  it('rejects a tool that needs several files, which the open document cannot supply', () => {
    assert.equal(canApplyToDocument(tool({ min: 2, max: null })), false);
    assert.equal(canApplyToDocument(tool({ min: 1, max: null })), false);
    assert.equal(canApplyToDocument(tool({ min: 1, max: 4 })), false);
  });

  it('rejects a tool that does not read PDFs at all', () => {
    assert.equal(canApplyToDocument(tool({ accept: ['.docx'] })), false);
  });

  it('accepts a tool whose second file is optional', () => {
    // A stamp takes the document plus an image, but the image is picked
    // separately — the document is still the one required input.
    assert.equal(canApplyToDocument(tool({ min: 0, max: 1 })), true);
  });

  it('rejects a tool that takes no files, since there is nothing to apply it to', () => {
    assert.equal(canApplyToDocument(tool({ min: 0, max: 0 })), false);
  });
});

describe('canOpenFromDocument', () => {
  it('accepts multi-file PDF tools so the task pane can collect extras', () => {
    assert.equal(canOpenFromDocument(tool({ min: 2, max: null })), true);
    assert.equal(canOpenFromDocument(tool({ min: 1, max: 4 })), true);
  });

  it('rejects tools that never take a PDF', () => {
    assert.equal(canOpenFromDocument(tool({ accept: ['.docx'], min: 1, max: 1 })), false);
  });

  it('rejects tools that take no files', () => {
    assert.equal(canOpenFromDocument(tool({ min: 0, max: 0 })), false);
  });
});

describe('documentTaskParams', () => {
  it('drops password fields that the open document already supplies', () => {
    const params = documentTaskParams(
      tool({}, [
        { key: 'password', type: 'password', label: { zh: 'p', en: 'p' }, default: '' },
        {
          key: 'level',
          type: 'select',
          label: { zh: 'l', en: 'l' },
          default: 'a',
          options: [{ value: 'a', label: { zh: 'a', en: 'a' } }],
        },
      ] as ToolMeta['params']),
    );
    assert.equal(params.length, 1);
    assert.equal(params[0]?.key, 'level');
  });

  /**
   * Only the document's *own* open password comes for free. A password the
   * user is setting — the open password on `security.add-password`, its
   * permissions password, a certificate's passphrase — is an answer nothing
   * else can supply, and dropping the field left those tools unusable from
   * the pane: no way to type one, and a run with an empty password.
   */
  it('keeps a password the user has to choose', () => {
    const params = documentTaskParams(
      tool({}, [
        { key: 'password', type: 'password', label: { zh: 'p', en: 'p' }, default: '' },
        { key: 'userPassword', type: 'password', label: { zh: 'u', en: 'u' }, default: '' },
        { key: 'ownerPassword', type: 'password', label: { zh: 'o', en: 'o' }, default: '' },
        { key: 'passphrase', type: 'password', label: { zh: 'c', en: 'c' }, default: '' },
      ] as ToolMeta['params']),
    );

    assert.deepEqual(
      params.map((param) => param.key),
      ['userPassword', 'ownerPassword', 'passphrase'],
    );
  });
});

describe('canApplyInstantly', () => {
  it('accepts a single-PDF tool with no options', () => {
    assert.equal(canApplyInstantly(tool()), true);
  });

  it('accepts a tool whose only param is the document password', () => {
    assert.equal(
      canApplyInstantly(
        tool({}, [
          { key: 'password', type: 'password', label: { zh: 'p', en: 'p' }, default: '' },
        ] as ToolMeta['params']),
      ),
      true,
    );
  });

  it('rejects tools that still need a user-facing option', () => {
    assert.equal(
      canApplyInstantly(
        tool({}, [
          {
            key: 'level',
            type: 'select',
            label: { zh: 'l', en: 'l' },
            default: 'a',
            options: [{ value: 'a', label: { zh: 'a', en: 'a' } }],
          },
        ] as ToolMeta['params']),
      ),
      false,
    );
  });

  it('rejects multi-file tools that need extras in the pane', () => {
    assert.equal(canApplyInstantly(tool({ min: 2, max: null })), false);
  });

  it('rejects report tools — they need a surface for the result', () => {
    assert.equal(canApplyInstantly(tool({}, [], 'report')), false);
  });
});

describe('canQuickApplyWithConfirm', () => {
  it('accepts a single-PDF tool whose options are all simple defaults', () => {
    assert.equal(
      canQuickApplyWithConfirm(
        tool({}, [
          {
            key: 'level',
            type: 'select',
            label: { zh: 'l', en: 'l' },
            default: 'a',
            options: [{ value: 'a', label: { zh: 'a', en: 'a' } }],
          },
        ] as ToolMeta['params']),
      ),
      true,
    );
  });

  it('rejects free-text options that need the task pane', () => {
    assert.equal(
      canQuickApplyWithConfirm(
        tool({}, [
          {
            key: 'text',
            type: 'text',
            label: { zh: 't', en: 't' },
            default: '',
          },
        ] as ToolMeta['params']),
      ),
      false,
    );
  });

  it('accepts pageRange only when the default is the whole document', () => {
    assert.equal(
      canQuickApplyWithConfirm(
        tool({}, [
          {
            key: 'pages',
            type: 'pageRange',
            label: { zh: 'p', en: 'p' },
            default: 'all',
          },
        ] as ToolMeta['params']),
      ),
      true,
    );
    assert.equal(
      canQuickApplyWithConfirm(
        tool({}, [
          {
            key: 'pages',
            type: 'pageRange',
            label: { zh: 'p', en: 'p' },
            default: '1',
          },
        ] as ToolMeta['params']),
      ),
      false,
    );
  });

  it('rejects zero-option tools (those use instant apply instead)', () => {
    assert.equal(canQuickApplyWithConfirm(tool()), false);
  });
});

describe('classifyOutput', () => {
  it('treats a lone PDF as the document itself, so it can replace it', () => {
    const result = classifyOutput([output('report.pdf')]);
    assert.equal(result.kind, 'document');
  });

  it('matches the extension case-insensitively', () => {
    assert.equal(classifyOutput([output('REPORT.PDF')]).kind, 'document');
  });

  it('treats a lone non-PDF as a file to save, not a new document', () => {
    // Converting to Word cannot replace the PDF being viewed.
    assert.equal(classifyOutput([output('report.docx')]).kind, 'files');
  });

  it('treats several outputs as files to save', () => {
    // Splitting produces many PDFs; none of them is "the" document.
    assert.equal(classifyOutput([output('a.pdf'), output('b.pdf')]).kind, 'files');
  });

  it('treats no output as files, so a report tool does not blank the document', () => {
    assert.equal(classifyOutput([]).kind, 'files');
  });

  it('carries the bytes through when it is a document', () => {
    const only = output('report.pdf', 7);
    const result = classifyOutput([only]);
    assert.equal(result.kind, 'document');
    if (result.kind === 'document') assert.equal(result.bytes.length, 7);
  });
});
