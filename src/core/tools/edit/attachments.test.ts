import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolError } from '../../errors.ts';
import { executeTool } from '../../execute.ts';
import { asInput, samplePdf } from '../../testing/fixtures.ts';
import { addAttachmentsTool, extractAttachmentsTool } from './attachments.ts';

describe('edit.attachments', () => {
  it('adds and then extracts attachments', async () => {
    const pdfBytes = await samplePdf({ pages: 1 });
    const host = asInput(pdfBytes, 'host.pdf');
    const attachment = asInput(new TextEncoder().encode('Hello Attachment'), 'hello.txt', 'text/plain');

    const addResult = await executeTool(addAttachmentsTool, {
      files: [host, attachment],
      params: {},
    });

    assert.equal(addResult.files.length, 1);
    assert.equal(addResult.files[0]!.name, 'host_bundled.pdf');

    const bundled = asInput(addResult.files[0]!.bytes, 'bundled.pdf');

    const extractResult = await executeTool(extractAttachmentsTool, {
      files: [bundled],
      params: {},
    });

    assert.equal(extractResult.files.length, 1);
    assert.equal(extractResult.files[0]!.name, 'hello.txt');
    assert.deepEqual(extractResult.files[0]!.bytes, new TextEncoder().encode('Hello Attachment'));
  });

  it('extractAttachmentsTool throws when no attachments exist', async () => {
    const pdfBytes = await samplePdf({ pages: 1 });
    const host = asInput(pdfBytes, 'host.pdf');
    await assert.rejects(
      executeTool(extractAttachmentsTool, { files: [host], params: {} }),
      (e: unknown) => e instanceof ToolError && e.code === 'EMPTY_RESULT'
    );
  });

  it('addAttachmentsTool requires at least one attachment', async () => {
    const pdfBytes = await samplePdf({ pages: 1 });
    const host = asInput(pdfBytes, 'host.pdf');
    await assert.rejects(
      executeTool(addAttachmentsTool, { files: [host], params: {} }),
      (e: unknown) => e instanceof ToolError && e.code === 'INVALID_INPUT'
    );
  });
});
