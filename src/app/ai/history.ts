/**
 * How much of the conversation is sent back to the model.
 *
 * The panel used to send every message it had ever shown. That works for a
 * while and then stops working entirely: past the model's context window the
 * provider rejects the whole request rather than truncating, so a long session
 * fails on every turn with an error about token count that says nothing about
 * what to do. Dropping the oldest turns keeps it working, and the recent ones
 * are the ones a follow-up refers to.
 *
 * Counted in characters rather than tokens because the tokeniser differs per
 * provider and this only needs to be the right order of magnitude. Roughly
 * 48k characters is well inside a 32k-token window even for CJK, which costs
 * more tokens per character than English.
 */
export const HISTORY_CHAR_BUDGET = 48_000;

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export function trimHistory(
  history: HistoryMessage[],
  budget = HISTORY_CHAR_BUDGET,
): HistoryMessage[] {
  const kept: HistoryMessage[] = [];
  let used = 0;

  // Newest first: a follow-up refers to what was just said.
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (!message) continue;

    const size = message.content.length;
    if (used + size > budget) {
      // One message larger than the whole budget would otherwise leave nothing
      // to send. Keep its tail, which is where the conclusion is.
      if (kept.length === 0) {
        kept.push({ ...message, content: message.content.slice(-budget) });
      }
      break;
    }

    kept.push(message);
    used += size;
  }

  return kept.reverse();
}
