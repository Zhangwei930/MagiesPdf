import type { LocalizedText } from '../types.ts';

/**
 * PDF user-access permissions (ISO 32000-1, table 22).
 *
 * The encryption dictionary stores permissions as a bitfield where a *set* bit
 * grants the operation. Reserved bits must stay set, so the baseline is all-ones
 * and each denial clears specific bits.
 */

export interface PermissionDescriptor {
  key: PermissionKey;
  /** Bits cleared when this permission is denied. */
  bits: number;
  label: LocalizedText;
  help: LocalizedText;
}

export type PermissionKey =
  | 'print'
  | 'modify'
  | 'copy'
  | 'annotate'
  | 'fillForms'
  | 'accessibility'
  | 'assemble';

/** All bits set: nothing is denied. Signed 32-bit -1, which is what the spec expects. */
export const ALL_PERMISSIONS = -1;

export const PERMISSIONS: readonly PermissionDescriptor[] = [
  {
    key: 'print',
    // Bit 3 is "print"; bit 12 is "print at high resolution". Denying print must
    // clear both, otherwise a viewer can still produce a full-quality printout.
    bits: 4 | 2048,
    label: { zh: '打印', en: 'Print' },
    help: { zh: '允许打印文档，含高分辨率打印', en: 'Allow printing, including high-resolution output' },
  },
  {
    key: 'modify',
    bits: 8,
    label: { zh: '修改内容', en: 'Modify contents' },
    help: { zh: '允许编辑页面内容', en: 'Allow editing page content' },
  },
  {
    key: 'copy',
    bits: 16,
    label: { zh: '复制文字与图片', en: 'Copy text and images' },
    help: { zh: '允许选中并复制内容', en: 'Allow selecting and copying content' },
  },
  {
    key: 'annotate',
    bits: 32,
    label: { zh: '添加批注', en: 'Annotate' },
    help: { zh: '允许添加或修改注释', en: 'Allow adding or changing annotations' },
  },
  {
    key: 'fillForms',
    bits: 256,
    label: { zh: '填写表单', en: 'Fill forms' },
    help: { zh: '允许填写交互式表单域', en: 'Allow filling in interactive form fields' },
  },
  {
    key: 'accessibility',
    bits: 512,
    label: { zh: '辅助功能提取', en: 'Accessibility extraction' },
    help: {
      zh: '允许屏幕阅读器提取内容，通常应保持开启',
      en: 'Allow screen readers to extract content — normally best left enabled',
    },
  },
  {
    key: 'assemble',
    bits: 1024,
    label: { zh: '组织页面', en: 'Assemble document' },
    help: { zh: '允许插入、删除和旋转页面', en: 'Allow inserting, deleting and rotating pages' },
  },
];

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key);

const BY_KEY = new Map(PERMISSIONS.map((p) => [p.key, p]));

/** Builds the encryption bitfield from the list of permissions the user denied. */
export function permissionsToBitfield(denied: readonly PermissionKey[]): number {
  let bits = ALL_PERMISSIONS;
  for (const key of denied) {
    const descriptor = BY_KEY.get(key);
    if (descriptor) bits &= ~descriptor.bits;
  }
  return bits;
}

/** Inverse of {@link permissionsToBitfield}, for showing an existing document's restrictions. */
export function bitfieldToPermissions(bits: number): PermissionKey[] {
  return PERMISSIONS.filter((p) => (bits & p.bits) !== p.bits).map((p) => p.key);
}
