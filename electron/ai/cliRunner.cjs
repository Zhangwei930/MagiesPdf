'use strict';

const { spawn: defaultSpawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { modelArgsFor } = require('./agentModels.cjs');
const { randomUUID } = require('node:crypto');
const {
  officeHandsPreamble,
  cliConstraintArgs,
  normalizePermissionMode,
  prepareCliAgent,
} = require('./cliPolicy.cjs');

/**
 * Runs one turn through an installed coding-agent CLI and reports it using the
 * same event stream the built-in runtime emits, so the panel renders a CLI turn
 * with the tool cards and streaming text it already has.
 *
 * Terminal-style split (same idea as Magies Terminal):
 *
 * - **CLI = brain** — plans and calls tools.
 * - **Magies = hands** — Office/PDF work must go through magies-office MCP; the
 *   local REST API enforces workspace scope and Magies permission mode.
 * - The CLI only runs inside the granted Office workspace.
 * - Magies "auto" may pass acceptEdits so MCP tool results are not double-gated
 *   by the CLI. --dangerously-skip-permissions is never passed, whatever the
 *   agent's own settings say.
 * - Magies "confirm" asks in this window on every Magies tool call, including
 *   the ones a CLI makes over MCP; "observer" blocks writes on the API.
 */

/**
 * How each CLI is asked to run one turn, and to continue the previous one.
 *
 * Every turn is a separate process, so without `resume` the agent starts from
 * nothing each time and a follow-up like "change it again" refers to a
 * conversation it cannot see. Codex is the odd one out: it has no --continue,
 * and resuming is a subcommand that takes the prompt after it.
 */
const COMMANDS = {
  claude: (prompt, resume) => ({
    args: [
      '-p', prompt, '--output-format', 'stream-json', '--verbose',
      ...(resume ? ['--continue'] : []),
    ],
    stream: 'json',
  }),
  codex: (prompt, resume) => ({
    args: resume ? ['exec', 'resume', '--last', '--json', prompt] : ['exec', '--json', prompt],
    stream: 'json',
    // The prompt is a trailing positional here, not a flag value: anything
    // added later has to go in front of it, or codex reads the flag as part
    // of the request.
    promptLast: true,
  }),
  cursor: (prompt, resume) => ({
    args: ['-p', prompt, '--output-format', 'stream-json', ...(resume ? ['--continue'] : [])],
    stream: 'json',
  }),
  gemini: (prompt, resume) => ({
    args: ['-p', prompt, ...(resume ? ['--continue'] : [])],
    stream: 'text',
  }),
  // agy offers --output-format stream-json too, but its event schema is not
  // one this parser knows; text is what it can actually read.
  antigravity: (prompt, resume) => ({
    args: ['-p', prompt, ...(resume ? ['--continue'] : [])],
    stream: 'text',
  }),
  // grok spells print mode `--single`, and its structured formats are ACP
  // updates or the Anthropic Messages wire format — neither is a shape this
  // parser reads, so plain text it is.
  grok: (prompt, resume) => ({
    args: ['-p', prompt, ...(resume ? ['--continue'] : [])],
    stream: 'text',
  }),
};

/**
 * What the app knows and the CLI does not.
 *
 * The panel shows the granted folder and the open document to the *user*; the
 * CLI is a separate process that sees neither, so a request about "the current
 * spreadsheet" resolves to nothing unless it is said out loud. The request
 * itself stays last so it reads as the instruction, not as part of the notes.
 */
function contextPreamble({ cwd, openDocument, sessionMemory, permissionMode = 'confirm' }) {
  const lines = [
    ...officeHandsPreamble({ permissionMode }),
  ];
  if (cwd) lines.push(`Working folder: ${cwd}`);

  if (openDocument?.name) {
    lines.push(openDocument.path
      ? `The document open in Magies Office right now is ${openDocument.name} at ${openDocument.path}.`
      : `The document open in Magies Office right now is ${openDocument.name}, which has not been saved to disk yet, so it cannot be opened from here (尚未保存).`);
  }

  // Carry prior Office writes so a CLI follow-up like "再改表头" still knows which file.
  if (sessionMemory && typeof sessionMemory === 'object') {
    const focus = String(sessionMemory.focusPath || '').trim();
    if (focus) {
      lines.push(`Session focus document from earlier turns: ${focus}`);
    }
    const writes = Array.isArray(sessionMemory.recentWrites) ? sessionMemory.recentWrites : [];
    if (writes.length > 0) {
      lines.push('Recent Office outputs in this Magies chat (newest last):');
      for (const write of writes.slice(-6)) {
        if (write?.path) lines.push(`- ${write.path}`);
      }
    }
  }
  return lines;
}

/**
 * The full invocation for one turn. Model and effort are appended rather than
 * baked into the templates because they are optional: leaving them off keeps
 * the CLI on whatever the user configured inside it.
 */
function buildAgentCommand(agentId, prompt, {
  model = '',
  effort = '',
  cwd = '',
  openDocument = null,
  sessionMemory = null,
  permissionMode = 'confirm',
  unattended = false,
  resume = false,
} = {}) {
  const build = COMMANDS[agentId];
  if (!build) throw new Error(`Unknown CLI agent: ${agentId}`);

  const mode = normalizePermissionMode(permissionMode);
  const notes = contextPreamble({
    cwd, openDocument, sessionMemory, permissionMode: mode,
  });
  const request = String(prompt ?? '');
  const full = notes.length > 0 ? `${notes.join('\n')}\n\n${request}` : request;

  // Tool lockdown + Magies mode flags. unattended never grants shell bypass.
  const constraints = cliConstraintArgs(agentId, mode, unattended === true);
  const command = build(full, resume);
  const extra = [...modelArgsFor(agentId, model, effort), ...constraints];
  const { promptLast = false, ...rest } = command;
  return {
    ...rest,
    args: promptLast
      ? [...command.args.slice(0, -1), ...extra, ...command.args.slice(-1)]
      : [...command.args, ...extra],
  };
}

function describeInput(input) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2).slice(0, 2000);
  } catch {
    return '';
  }
}

function fromContentBlocks(blocks) {
  const events = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block?.type === 'text' && block.text) {
      events.push({ kind: 'text', text: String(block.text) });
    } else if (block?.type === 'tool_use') {
      events.push({
        kind: 'tool',
        name: String(block.name || 'tool'),
        detail: describeInput(block.input),
      });
    }
  }
  return events;
}

/**
 * Normalizes one line of CLI output.
 *
 * The agents disagree on shape and change it between versions, so this reads
 * the shapes that are known and ignores what it does not recognise rather than
 * dumping bookkeeping JSON into the transcript. A line that is not JSON at all
 * is plain output — that is how the text-mode agents report everything.
 */
function parseAgentLine(line) {
  const text = String(line ?? '');
  if (!text.trim()) return [];

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return [{ kind: 'text', text: `${text}\n` }];
  }
  if (!payload || typeof payload !== 'object') return [];

  // Claude Code / Cursor: assistant messages carry content blocks.
  if (payload.type === 'assistant' && payload.message) {
    return fromContentBlocks(payload.message.content);
  }

  if (payload.type === 'result') {
    const body = String(payload.result ?? '');
    return payload.subtype && payload.subtype !== 'success'
      ? [{ kind: 'error', message: body || String(payload.subtype) }]
      : [{ kind: 'final', text: body }];
  }

  // Codex, older shape: everything hangs off `msg`.
  const message = payload.msg;
  if (message && typeof message === 'object') {
    if (message.type === 'agent_message' && message.message) {
      return [{ kind: 'text', text: String(message.message) }];
    }
    if (message.type === 'exec_command_begin') {
      const command = Array.isArray(message.command)
        ? message.command.join(' ')
        : String(message.command || '');
      return [{ kind: 'tool', name: 'shell', detail: command }];
    }
    if (message.type === 'error' && message.message) {
      return [{ kind: 'error', message: String(message.message) }];
    }
    return [];
  }

  // Codex, newer shape: item lifecycle events.
  const item = payload.item;
  if (item && typeof item === 'object') {
    if (item.type === 'agent_message' && item.text) {
      return [{ kind: 'text', text: String(item.text) }];
    }
    if (item.type === 'command_execution') {
      return payload.type === 'item.started'
        ? [{ kind: 'tool', name: 'shell', detail: String(item.command || '') }]
        : [];
    }
  }

  return [];
}

function createCliRunner({ spawn = defaultSpawn, resolveAgent } = {}) {
  return {
    /**
     * Runs `prompt` through `agentId`, emitting the built-in runtime's events.
     * Resolves with the final assistant message.
     */
    async run({
      agentId,
      prompt,
      cwd,
      model = '',
      effort = '',
      openDocument = null,
      sessionMemory = null,
      permissionMode = 'confirm',
      unattended = false,
      resume = false,
      signal,
      onEvent = () => {},
    }) {
      if (!cwd) {
        const error = new Error('A granted Office workspace is required to run a CLI agent');
        error.code = 'AI_WORKSPACE_REQUIRED';
        throw error;
      }

      const agent = await resolveAgent(agentId);
      if (!agent?.installed || !agent.path) {
        const error = new Error(`${agentId} is not installed on this machine`);
        error.code = 'AI_CLI_NOT_INSTALLED';
        throw error;
      }

      // Antigravity (agy/jetski) headless denies MCP unless allow-rules exist.
      // Patch settings for magies-office only — never shell bypass.
      try {
        const prep = prepareCliAgent(agentId);
        if (prep?.updated) {
          console.info(`[magiespdf] prepared ${agentId} MCP allow rules at ${prep.path}`);
        }
      } catch (cause) {
        console.warn(`[magiespdf] prepareCliAgent(${agentId}) failed:`, cause?.message || cause);
      }

      const { args } = buildAgentCommand(agentId, prompt, {
        model,
        effort,
        cwd,
        openDocument,
        sessionMemory,
        permissionMode,
        unattended,
        resume,
      });
      /**
       * What was actually run, with the prompt collapsed.
       *
       * When a turn ends with nothing to show, the first question is always
       * whether the invocation differs from what works in a shell. Without
       * this in the error and the log there is no way to tell.
       */
      const invocation = [
        agent.path,
        ...args.map((argument) => (
          argument.length > 60 ? `${argument.slice(0, 57).replace(/\n/g, ' ')}…` : argument
        )),
      ].join(' ');
      console.info(`[magiespdf] cli turn: ${invocation} (cwd ${cwd})`);

      const child = spawn(agent.path, args, { cwd, env: process.env });

      let assistantText = '';
      let finalText = '';
      let stderr = '';
      let buffer = '';
      let failure = null;

      const emit = (events) => {
        for (const event of events) {
          if (event.kind === 'text') {
            assistantText += event.text;
            onEvent({ type: 'assistant_delta', delta: event.text });
          } else if (event.kind === 'final') {
            finalText = event.text;
          } else if (event.kind === 'error') {
            failure = event.message;
          } else if (event.kind === 'tool') {
            // A CLI reports a call it has already decided to make, so the card
            // opens and closes together: there is no approval to wait on.
            const callId = randomUUID();
            onEvent({
              type: 'tool_start',
              callId,
              toolId: `cli.${event.name}`,
              toolName: { zh: event.name, en: event.name },
              inputFileNames: [],
              details: event.detail,
            });
            onEvent({ type: 'tool_result', callId, ok: true, files: [] });
          }
        }
      };

      /**
       * Decoding each chunk on its own splits multi-byte characters at the
       * boundary and turns both halves into U+FFFD — which a CJK reply hits
       * within a sentence or two. StringDecoder holds the incomplete tail until
       * the rest of the character arrives.
       */
      const decoder = new StringDecoder('utf8');
      const consume = (chunk) => {
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) emit(parseAgentLine(line));
      };

      child.stdout?.on('data', consume);
      // Same reason as stdout: a failure message in Chinese would otherwise
      // arrive with replacement characters in the middle of the explanation.
      const errorDecoder = new StringDecoder('utf8');
      child.stderr?.on('data', (chunk) => {
        const text = errorDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        stderr = `${stderr}${text}`.slice(-4000);
      });

      let cancelled = false;
      const abort = () => {
        cancelled = true;
        try {
          child.kill();
        } catch {
          // Already gone; the close handler still settles the promise.
        }
      };
      if (signal) {
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }

      try {
        return await new Promise((resolve, reject) => {
          child.on('error', (error) => {
            console.error(`[magiespdf] cli turn could not start: ${error.message} — ${invocation}`);
            reject(new Error(`${error.message}\n${invocation}`));
          });
          child.on('close', (code) => {
            buffer += decoder.end();
            stderr = `${stderr}${errorDecoder.end()}`.slice(-4000);
            if (buffer.trim()) emit(parseAgentLine(buffer));

            if (cancelled) {
              const error = new Error('AI turn cancelled');
              error.name = 'AbortError';
              reject(error);
              return;
            }
            if (failure) {
              reject(new Error(failure));
              return;
            }
            if (code !== 0) {
              const detail = stderr.trim();
              console.error(`[magiespdf] cli turn failed (${code}): ${detail || '(no stderr)'}`);
              reject(new Error(
                `${agentId} exited with code ${code}${detail ? `: ${detail}` : ''}\n${invocation}`,
              ));
              return;
            }

            let message = finalText || assistantText;
            if (!message.trim()) {
              // Exit 0 with nothing on stdout is how a headless agent reports
              // that it gave up — and it explains itself on stderr. Dropping
              // that because the exit code was zero leaves the user with a
              // blank reply and no way to know why.
              console.warn(`[magiespdf] cli turn produced no output: ${invocation}`);
              if (stderr.trim()) {
                console.warn(`[magiespdf] cli said: ${stderr.trim()}`);
                message = stderr.trim();
              }
            }
            onEvent({ type: 'assistant_done', content: message });
            resolve({ message, files: [] });
          });
        });
      } finally {
        signal?.removeEventListener?.('abort', abort);
      }
    },
  };
}

module.exports = { buildAgentCommand, parseAgentLine, createCliRunner };
