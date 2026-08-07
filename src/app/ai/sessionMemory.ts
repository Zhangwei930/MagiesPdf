/**
 * Working memory for one AI chat session.
 *
 * The model only sees user/assistant text by default — tool results and written
 * Office paths disappear on the next turn, so a follow-up like "再改表头" has
 * nothing to aim at. This structure is re-injected into the system prompt every
 * turn and used to annotate history, without sending full document bytes.
 */

export const MAX_RECENT_WRITES = 8;
export const MAX_RECENT_TOOLS = 12;
export const MAX_NOTES = 6;

export interface SessionWrite {
  /** Workspace-relative path when known. */
  path: string;
  toolId: string;
  at: number;
}

export interface SessionToolFact {
  toolId: string;
  ok: boolean;
  /** Short free-text fact (e.g. "cellsWritten: 40"). */
  detail: string;
  at: number;
}

export interface SessionMemory {
  /** Latest preferred Office path for follow-up edits (usually last write). */
  focusPath: string;
  recentWrites: SessionWrite[];
  recentTools: SessionToolFact[];
  /** Compact bilingual-agnostic notes the panel may set. */
  notes: string[];
}

export function emptySessionMemory(): SessionMemory {
  return {
    focusPath: '',
    recentWrites: [],
    recentTools: [],
    notes: [],
  };
}

function pushBounded<T>(list: T[], item: T, max: number): T[] {
  return [...list, item].slice(-max);
}

function writtenPathsFromResult(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const record = result as Record<string, unknown>;
  const written = record.written;
  if (typeof written === 'string' && written.trim()) return [written.trim()];
  if (Array.isArray(written)) {
    return written
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
  }
  // Batch / archive style payloads.
  if (Array.isArray(record.paths)) {
    return record.paths
      .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim());
  }
  return [];
}

function detailFromResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const record = result as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['cellsWritten', 'sortedRange', 'commentAdded', 'archived', 'mode']) {
    if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
      parts.push(`${key}=${String(record[key])}`);
    }
  }
  if (typeof record.source === 'string' && record.source) {
    parts.push(`source=${record.source}`);
  }
  return parts.join(', ').slice(0, 200);
}

/**
 * Fold one tool_result into session memory.
 * Only successful Office writes update focusPath; reads still leave a tool fact.
 */
export function rememberToolResult(
  memory: SessionMemory,
  event: { toolId: string; ok: boolean; result?: unknown; error?: string },
  now = Date.now,
): SessionMemory {
  const toolId = String(event.toolId || '');
  if (!toolId) return memory;

  const at = now();
  let next: SessionMemory = {
    ...memory,
    recentTools: pushBounded(memory.recentTools, {
      toolId,
      ok: event.ok === true,
      detail: event.ok
        ? detailFromResult(event.result)
        : String(event.error || 'failed').slice(0, 200),
      at,
    }, MAX_RECENT_TOOLS),
  };

  if (event.ok && toolId.startsWith('office:')) {
    const paths = writtenPathsFromResult(event.result);
    if (paths.length > 0) {
      let writes = next.recentWrites;
      for (const path of paths) {
        writes = pushBounded(writes, { path, toolId, at }, MAX_RECENT_WRITES);
      }
      next = {
        ...next,
        recentWrites: writes,
        focusPath: paths[paths.length - 1] || next.focusPath,
      };
    } else if (!next.focusPath) {
      // A successful read of a path can seed focus when nothing has been written yet.
      const source = (event.result as { path?: string; source?: string } | undefined);
      const seed = source?.path || source?.source;
      if (typeof seed === 'string' && seed.trim()) {
        next = { ...next, focusPath: seed.trim() };
      }
    }
  }

  return next;
}

export function rememberNote(memory: SessionMemory, note: string): SessionMemory {
  const text = String(note || '').trim();
  if (!text) return memory;
  return {
    ...memory,
    notes: pushBounded(memory.notes, text.slice(0, 300), MAX_NOTES),
  };
}

/** Lines for the model system prompt / CLI preamble. */
export function sessionMemoryLines(memory: SessionMemory | null | undefined): string[] {
  if (!memory) return [];
  const lines: string[] = [];
  if (memory.focusPath) {
    lines.push(
      `Session focus document (prefer this path for follow-up Office edits unless the user names another): ${memory.focusPath}`,
    );
  }
  if (memory.recentWrites.length > 0) {
    lines.push('Recent Office files written in this chat (newest last):');
    for (const write of memory.recentWrites.slice(-MAX_RECENT_WRITES)) {
      lines.push(`- ${write.path} via ${write.toolId}`);
    }
    lines.push(
      'When the user says "the file we just edited", "刚才那个", or "继续改", use the latest written path above (or session focus).',
    );
  }
  if (memory.recentTools.length > 0) {
    const recent = memory.recentTools.slice(-6);
    lines.push('Recent tool outcomes in this chat:');
    for (const tool of recent) {
      const mark = tool.ok ? 'ok' : 'error';
      lines.push(`- ${tool.toolId} (${mark})${tool.detail ? `: ${tool.detail}` : ''}`);
    }
  }
  for (const note of memory.notes.slice(-MAX_NOTES)) {
    lines.push(`Note: ${note}`);
  }
  return lines;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Build model history from chat messages, attaching a short tool trail so the
 * model still "remembers" what it did after trimHistory drops old turns carefully.
 */
export function historyWithToolMemory(
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    tools?: Array<{ toolId: string; status: string }>;
    artifacts?: Array<{ name: string }>;
  }>,
): HistoryMessage[] {
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return { role: message.role, content: String(message.content || '') };
    }
    const tools = Array.isArray(message.tools) ? message.tools : [];
    const artifacts = Array.isArray(message.artifacts) ? message.artifacts : [];
    if (tools.length === 0 && artifacts.length === 0) {
      return { role: 'assistant', content: String(message.content || '') };
    }
    const toolPart = tools
      .slice(0, 8)
      .map((tool) => `${tool.toolId}:${tool.status}`)
      .join(', ');
    const artifactPart = artifacts
      .slice(0, 6)
      .map((file) => file.name)
      .filter(Boolean)
      .join(', ');
    const extras = [
      toolPart ? `tools: ${toolPart}` : '',
      artifactPart ? `files: ${artifactPart}` : '',
    ].filter(Boolean).join('; ');
    const body = String(message.content || '');
    return {
      role: 'assistant',
      content: extras ? `${body}\n\n[session: ${extras}]` : body,
    };
  });
}
