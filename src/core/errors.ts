import type { LocalizedText } from './types.ts';

/**
 * Every failure a tool can produce, as a typed value. The renderer switches on
 * `code` to decide what to show (a password prompt, a file picker, a retry button),
 * so new codes must be added here rather than encoded into message strings.
 */
export type ToolErrorCode =
  | 'INVALID_PARAM'
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_FORMAT'
  | 'PASSWORD_REQUIRED'
  | 'WRONG_PASSWORD'
  | 'ENCRYPTED_NOT_PERMITTED'
  | 'CORRUPT_DOCUMENT'
  | 'PAGE_OUT_OF_RANGE'
  | 'EMPTY_RESULT'
  | 'HOST_UNAVAILABLE'
  | 'EXTERNAL_CONVERTER_FAILED'
  | 'CANCELLED'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ToolErrorCode;
  /** User-facing message. `Error.message` stays the developer-facing one. */
  readonly userMessage: LocalizedText;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ToolErrorCode,
    developerMessage: string,
    userMessage: LocalizedText,
    details?: Record<string, unknown>,
  ) {
    super(developerMessage);
    this.name = 'ToolError';
    this.code = code;
    this.userMessage = userMessage;
    this.details = details;
  }

  /** Structured-clone-safe form, for crossing the worker and IPC boundaries. */
  toJSON(): SerializedToolError {
    return {
      __toolError: true,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      details: this.details,
    };
  }
}

export interface SerializedToolError {
  __toolError: true;
  code: ToolErrorCode;
  message: string;
  userMessage: LocalizedText;
  details?: Record<string, unknown>;
}

export function isSerializedToolError(value: unknown): value is SerializedToolError {
  return typeof value === 'object' && value !== null && '__toolError' in value;
}

export function deserializeToolError(value: SerializedToolError): ToolError {
  return new ToolError(value.code, value.message, value.userMessage, value.details);
}

/** Wraps anything thrown by a tool into a `ToolError`, so callers only handle one type. */
export function toToolError(cause: unknown): ToolError {
  if (cause instanceof ToolError) return cause;

  const message = cause instanceof Error ? cause.message : String(cause);

  // MuPDF and pdf-lib both signal encryption through the message text only.
  if (/password|encrypt/i.test(message)) {
    return new ToolError('PASSWORD_REQUIRED', message, {
      zh: '文档已加密，请提供打开密码。',
      en: 'This document is encrypted. Please provide its password.',
    });
  }
  if (/cannot recognize|no objects found|damaged|broken|corrupt/i.test(message)) {
    return new ToolError('CORRUPT_DOCUMENT', message, {
      zh: '文档已损坏或不是有效的 PDF，可以先试试「修复 PDF」。',
      en: 'The document is damaged or not a valid PDF. Try the Repair PDF tool first.',
    });
  }

  return new ToolError('INTERNAL', message, {
    zh: '处理过程中发生未预期的错误，详情见任务日志。',
    en: 'An unexpected error occurred. See the job log for details.',
  });
}
