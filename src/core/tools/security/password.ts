import { ToolError } from '../../errors.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { PERMISSIONS, permissionsToBitfield, type PermissionKey } from '../../pdf/permissions.ts';
import { suffixedName } from '../../naming.ts';
import type { ToolDescriptor } from '../../types.ts';
import {
  PDF_ONE,
  listParam,
  passwordParam,
  pdfOutput,
  soleFile,
  stringParam,
} from '../shared.ts';

/**
 * Decides the owner password actually written into the file.
 *
 * A reader that authenticates with the *owner* password is granted every
 * permission. So if the owner password were simply defaulted to the user
 * password, anyone able to open the document would also hold owner rights and
 * the restrictions would do nothing at all. When restrictions are requested but
 * no owner password was supplied, a random one is generated instead: the user
 * still opens the file with their own password, and the limits actually bind.
 */
export function resolveOwnerPassword(
  supplied: string,
  userPassword: string,
  denied: readonly PermissionKey[],
): string {
  if (supplied !== '') return supplied;
  if (denied.length === 0) return userPassword;

  const random = new Uint8Array(24);
  crypto.getRandomValues(random);
  return Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Permission checkboxes, generated from the spec table so the two cannot drift. */
const PERMISSION_OPTIONS = PERMISSIONS.map((permission) => ({
  value: permission.key,
  label: permission.label,
  help: permission.help,
}));

export const addPasswordTool: ToolDescriptor = {
  id: 'security.add-password',
  category: 'security',
  name: { zh: '添加密码', en: 'Add Password' },
  description: {
    zh: '给 PDF 加上打开密码，并可限制打印、复制等操作。',
    en: 'Protect a PDF with a password, and optionally restrict printing, copying and more.',
  },
  icon: 'ShieldCheck',
  keywords: ['password', 'encrypt', 'protect', 'lock', '加密', '密码', '保护', '加锁'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'userPassword',
      type: 'password',
      label: { zh: '打开密码', en: 'Open password' },
      help: {
        zh: '打开文档时需要输入。留空则任何人都能打开，但仍受下面的权限限制。',
        en: 'Required to open the document. Leave empty to let anyone open it while still applying the restrictions below.',
      },
      default: '',
    },
    {
      key: 'ownerPassword',
      type: 'password',
      label: { zh: '权限密码', en: 'Permissions password' },
      help: {
        zh: '用于解除下面的限制。留空且设置了限制时，会自动生成一个随机密码——否则能打开文件的人就自动拥有全部权限，限制等于没设。',
        en: 'Lifts the restrictions below. If left empty while restrictions are set, a random one is generated — otherwise anyone who can open the file would hold owner rights and the restrictions would not bind.',
      },
      default: '',
      advanced: true,
    },
    {
      key: 'denied',
      type: 'multiselect',
      label: { zh: '禁止以下操作', en: 'Disallow these actions' },
      help: {
        zh: '注意：权限限制依赖阅读器自觉遵守，并非强加密保护。真正的保密请设置打开密码。',
        en: 'Note: restrictions rely on the reader honouring them — they are not cryptographic. For real confidentiality, set an open password.',
      },
      default: [],
      options: PERMISSION_OPTIONS,
    },
    {
      key: 'method',
      type: 'select',
      label: { zh: '加密算法', en: 'Encryption' },
      default: 'aes-256',
      options: [
        { value: 'aes-256', label: { zh: 'AES-256（推荐）', en: 'AES-256 (recommended)' } },
        { value: 'aes-128', label: { zh: 'AES-128', en: 'AES-128' } },
        {
          value: 'rc4-128',
          label: { zh: 'RC4-128（兼容旧阅读器，不安全）', en: 'RC4-128 (legacy readers, insecure)' },
        },
      ],
      advanced: true,
    },
    passwordParam(),
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);
    const userPassword = stringParam(ctx, 'userPassword');
    const denied = listParam(ctx, 'denied') as PermissionKey[];
    const ownerPassword = resolveOwnerPassword(stringParam(ctx, 'ownerPassword'), userPassword, denied);

    if (userPassword === '' && ownerPassword === '' && denied.length === 0) {
      throw new ToolError('INVALID_PARAM', 'Nothing to apply: no passwords and no restrictions', {
        zh: '请至少设置一个密码，或勾选要禁止的操作。',
        en: 'Set at least one password, or tick an action to disallow.',
      });
    }

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      const bytes = saveDocument(doc, {
        encryption: {
          method: stringParam(ctx, 'method') as 'aes-256' | 'aes-128' | 'rc4-128',
          userPassword,
          ownerPassword,
          permissions: permissionsToBitfield(denied),
        },
      });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_protected', '.pdf'), bytes)],
        summary: {
          zh: userPassword ? '已加密，需要密码才能打开' : '已设置权限限制',
          en: userPassword ? 'Encrypted — a password is now required' : 'Permission restrictions applied',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};

export const removePasswordTool: ToolDescriptor = {
  id: 'security.remove-password',
  category: 'security',
  name: { zh: '移除密码', en: 'Remove Password' },
  description: {
    zh: '用已知密码解密 PDF，输出一个无密码、无权限限制的副本。',
    en: 'Decrypt a PDF you know the password to, producing an unrestricted copy.',
  },
  icon: 'ShieldCheck',
  keywords: ['decrypt', 'unlock', 'remove password', '解密', '解锁', '去密码'],
  input: PDF_ONE,
  output: 'single',
  params: [
    {
      key: 'password',
      type: 'password',
      label: { zh: '当前密码', en: 'Current password' },
      help: {
        zh: '打开密码或权限密码都可以。MagiesPdf 不会尝试破解密码。',
        en: 'Either the open or the permissions password. MagiesPdf will not attempt to crack one.',
      },
      default: '',
      required: true,
    },
  ],
  runtime: 'worker',

  async run(ctx) {
    const file = soleFile(ctx);

    const doc = openDocument(file.bytes, stringParam(ctx, 'password'));
    try {
      // A plain save writes `encrypt=none`, dropping both passwords and the
      // permission bits along with them.
      const bytes = saveDocument(doc, { garbage: 'compact' });
      ctx.report(1);

      return {
        files: [pdfOutput(suffixedName(file.name, '_unlocked', '.pdf'), bytes)],
        summary: {
          zh: '已移除密码与所有权限限制',
          en: 'Password and all restrictions removed',
        },
      };
    } finally {
      doc.destroy();
    }
  },
};
