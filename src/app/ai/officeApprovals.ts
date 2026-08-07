import type { OfficeToolApproval } from '../bridge.ts';

/**
 * Confirm-mode approvals for Office tools called from outside this window
 * (a CLI agent going through the local REST API / magies-office MCP).
 *
 * The question and the answer both belong in the AI panel: that is where the
 * user is watching the agent work, and an approval torn out of that context is
 * a dialog about a tool name with nothing to judge it by. Same split as Magies
 * Terminal — a pending card to decide on, and a record of what was decided.
 */

export type ApprovalDecision = 'once' | 'session' | 'deny';

export interface OfficeApprovalRecord {
  approvalId: string;
  functionName: string;
  path: string;
  decision: ApprovalDecision | 'timeout';
  at: number;
}

export interface OfficeApprovalState {
  pending: OfficeToolApproval[];
  /** Newest first, capped — this is a trail, not an audit log. */
  records: OfficeApprovalRecord[];
}

export const MAX_APPROVAL_RECORDS = 20;

export const EMPTY_APPROVAL_STATE: OfficeApprovalState = { pending: [], records: [] };

/** A request the main process is waiting on. Ignores one it already holds. */
export function withRequest(
  state: OfficeApprovalState,
  request: OfficeToolApproval,
): OfficeApprovalState {
  if (state.pending.some((entry) => entry.approvalId === request.approvalId)) return state;
  return { ...state, pending: [...state.pending, request] };
}

/**
 * The user answered. The card goes, and what they chose is remembered so the
 * panel can show why a later call did not ask again.
 */
export function withDecision(
  state: OfficeApprovalState,
  approvalId: string,
  decision: ApprovalDecision,
  at: number,
): OfficeApprovalState {
  const answered = state.pending.find((entry) => entry.approvalId === approvalId);
  if (!answered) return state;
  const record: OfficeApprovalRecord = {
    approvalId,
    functionName: answered.functionName,
    path: answered.path,
    decision,
    at,
  };
  return {
    pending: state.pending.filter((entry) => entry.approvalId !== approvalId),
    records: [record, ...state.records].slice(0, MAX_APPROVAL_RECORDS),
  };
}

/**
 * The main process gave up waiting. It records as a refusal, because that is
 * what the caller was told.
 */
export function withTimeout(
  state: OfficeApprovalState,
  approvalId: string,
  at: number,
): OfficeApprovalState {
  const abandoned = state.pending.find((entry) => entry.approvalId === approvalId);
  if (!abandoned) return state;
  return {
    pending: state.pending.filter((entry) => entry.approvalId !== approvalId),
    records: [
      {
        approvalId,
        functionName: abandoned.functionName,
        path: abandoned.path,
        decision: 'timeout' as const,
        at,
      },
      ...state.records,
    ].slice(0, MAX_APPROVAL_RECORDS),
  };
}

/**
 * Plain-language subject for a tool call: `office_excel_write` is not a
 * sentence, and the card is asking the user to agree to something.
 */
export function approvalSubject(functionName: string, locale: 'zh' | 'en'): string {
  const name = String(functionName || '');
  const surface = name.startsWith('office_word_')
    ? { zh: 'Word 文档', en: 'a Word document' }
    : name.startsWith('office_excel_')
      ? { zh: 'Excel 表格', en: 'an Excel sheet' }
      : name.startsWith('office_presentation_')
        ? { zh: 'PPT 演示文稿', en: 'a presentation' }
        : { zh: '工作区文件', en: 'workspace files' };
  const reads = /_read$|_read_changes$|_list$/.test(name);
  if (locale === 'zh') return reads ? `读取 ${surface.zh}` : `修改 ${surface.zh}`;
  return reads ? `Read ${surface.en}` : `Modify ${surface.en}`;
}
