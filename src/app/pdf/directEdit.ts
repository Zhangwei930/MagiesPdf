import type { MagiesPdfBridge, PickedFile } from '../bridge.ts';

/** Creates the same one-page document a desktop office suite opens for “New PDF”. */
export async function createDefaultBlankPdf(
  api: MagiesPdfBridge,
  jobId: string = crypto.randomUUID(),
): Promise<PickedFile> {
  const result = await api.runJob({
    jobId,
    toolId: 'edit.create-blank',
    files: [],
    params: { pages: 1, pageSize: 'a4', labelPages: false, fileName: 'untitled.pdf' },
  });
  const output = result.files[0];
  if (!output || output.mime !== 'application/pdf') {
    throw new Error('The PDF engine produced no PDF');
  }
  return {
    name: output.name,
    path: '',
    size: output.bytes.length,
    mime: output.mime,
    bytes: output.bytes,
  };
}
