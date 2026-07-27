import type { PipelinePreset } from './bridge.ts';

/**
 * Built-in starter pipelines. Not stored in settings — always available, cannot
 * be deleted from the list (users can still save a copy under their own name).
 */
export const BUILTIN_PIPELINE_PRESETS: readonly PipelinePreset[] = [
  {
    id: 'builtin.compress-watermark',
    name: '压缩 + 水印',
    steps: [
      { toolId: 'edit.compress', params: {} },
      {
        toolId: 'security.add-watermark',
        params: { text: 'CONFIDENTIAL', opacity: 0.15, rotation: 45 },
      },
    ],
    updatedAt: 0,
  },
  {
    id: 'builtin.rotate-pagenumbers',
    name: '旋转 90° + 页码',
    steps: [
      { toolId: 'organize.rotate', params: { degrees: '90' } },
      {
        toolId: 'edit.add-page-numbers',
        params: { format: 'ofTotal', position: 'bottom-center' },
      },
    ],
    updatedAt: 0,
  },
  {
    id: 'builtin.split-gray',
    name: '拆分（每页）+ 灰度',
    steps: [
      { toolId: 'organize.split', params: { mode: 'everyN', everyN: 1 } },
      { toolId: 'edit.grayscale', params: { dpi: 150, pages: 'all' } },
    ],
    updatedAt: 0,
  },
];

export function isBuiltinPreset(id: string): boolean {
  return id.startsWith('builtin.');
}
