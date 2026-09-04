'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  buildAgentCommand,
  parseAgentLine,
  createCliRunner,
} = require('./cliRunner.cjs');

function assertPromptLast(args, flagOrIndex, request) {
  // Claude/cursor: -p <prompt>; codex: last arg; gemini/agy: -p <prompt>
  if (typeof flagOrIndex === 'number') {
    assert.ok(String(args[flagOrIndex]).endsWith(request));
    return;
  }
  const i = args.indexOf(flagOrIndex);
  assert.ok(i >= 0, `missing ${flagOrIndex}`);
  assert.ok(String(args[i + 1]).endsWith(request));
}

test('buildAgentCommand asks each CLI for one non-interactive turn', () => {
  // Magies hands preamble is always injected; the user request stays last.
  const claude = buildAgentCommand('claude', 'hello');
  assert.equal(claude.stream, 'json');
  assert.deepEqual(claude.args.slice(0, 1), ['-p']);
  assertPromptLast(claude.args, '-p', 'hello');
  assert.match(claude.args.join(' '), /--output-format stream-json/);

  const codex = buildAgentCommand('codex', 'hello');
  assert.equal(codex.stream, 'json');
  assert.deepEqual(codex.args.slice(0, 2), ['exec', '--json']);
  assertPromptLast(codex.args, codex.args.length - 1, 'hello');

  const cursor = buildAgentCommand('cursor', 'hello');
  assert.equal(cursor.stream, 'json');
  assertPromptLast(cursor.args, '-p', 'hello');

  assertPromptLast(buildAgentCommand('gemini', 'hello').args, '-p', 'hello');
  assertPromptLast(buildAgentCommand('antigravity', 'hello').args, '-p', 'hello');
});

test('never passes a shell-level permission bypass, even if unattended is requested', () => {
  // Magies Office is Terminal-style: CLI must not get --dangerously-skip-permissions.
  for (const id of ['claude', 'antigravity', 'gemini', 'grok']) {
    const withOptIn = buildAgentCommand(id, 'go', {
      permissionMode: 'auto',
      unattended: true,
    }).args.join(' ');
    assert.doesNotMatch(withOptIn, /dangerously-skip-permissions/, id);
  }
});

test('Claude CLI keeps its own tools; Magies gates the work, not the capability', () => {
  const args = buildAgentCommand('claude', 'fill excel', { permissionMode: 'auto' }).args.join(' ');
  assert.doesNotMatch(args, /--disallowedTools/);
  assert.match(args, /acceptEdits/);
});

test('automatic mode grants the CLI its own edit permission, never a bypass', () => {
  // A CLI in print mode cannot show its own approval prompt, so on Confirm it
  // simply refuses to write and the user sees nothing happen. Automatic mode
  // has to say so in the CLI's own vocabulary.
  const claude = buildAgentCommand('claude', 'go', { permissionMode: 'auto' }).args.join(' ');
  assert.match(claude, /--permission-mode acceptEdits/);

  const agy = buildAgentCommand('antigravity', 'go', { permissionMode: 'auto' }).args.join(' ');
  assert.match(agy, /--mode accept-edits/);

  // gemini spells it differently, and has no --mode at all.
  const gemini = buildAgentCommand('gemini', 'go', { permissionMode: 'auto' }).args.join(' ');
  assert.match(gemini, /--approval-mode auto_edit/);

  // Never the blanket bypass from the mode alone.
  for (const id of ['claude', 'codex', 'cursor', 'gemini', 'antigravity']) {
    const args = buildAgentCommand(id, 'x', { permissionMode: 'auto' }).args.join(' ');
    assert.doesNotMatch(args, /dangerously|skip-permissions|--yolo|--full-auto/i, id);
  }
});

test('confirm mode adds no permission flag, leaving the CLI as the user set it', () => {
  assert.doesNotMatch(
    buildAgentCommand('claude', 'go', { permissionMode: 'confirm' }).args.join(' '),
    /--permission-mode/,
  );
});

test('buildAgentCommand never passes a permission-bypass flag by default', () => {
  for (const id of ['claude', 'codex', 'cursor', 'gemini', 'antigravity']) {
    const { args } = buildAgentCommand(id, 'x');
    const joined = args.join(' ');
    assert.doesNotMatch(joined, /dangerously|skip-permissions|--yolo|--full-auto/i, id);
  }
});

test('buildAgentCommand appends the chosen model and effort', () => {
  const withModel = buildAgentCommand('claude', 'hi', { model: 'sonnet', effort: 'high' }).args.join(' ');
  assert.match(withModel, /--model sonnet/);
  assert.match(withModel, /--effort high/);
  assert.match(withModel, /--output-format stream-json/);
  // Unset leaves the CLI on its own default rather than forcing one.
  const bare = buildAgentCommand('claude', 'hi').args.join(' ');
  assert.doesNotMatch(bare, /--model /);
  assert.doesNotMatch(bare, /--effort /);
});

test('buildAgentCommand tells the CLI where it is and what is open', () => {
  const { args } = buildAgentCommand('claude', '把当前 excel 填点数据', {
    cwd: '/Users/x/Downloads/app',
    openDocument: { name: '555.xlsx', path: '/Users/x/Downloads/app/555.xlsx' },
  });
  const prompt = args[1];

  // A CLI agent knows nothing about the app's open document: without this,
  // "the current excel" resolves to nothing and it flails or gives up.
  assert.match(prompt, /555\.xlsx/);
  assert.match(prompt, /\/Users\/x\/Downloads\/app/);
  // Magies tools are preferred, not the only ones allowed.
  assert.match(prompt, /magies-office MCP/i);
  assert.match(prompt, /PREFER magies-office/);
  assert.ok(prompt.endsWith('把当前 excel 填点数据'), 'the request stays last');
});

test('observer mode does not pass acceptEdits and warns in the preamble', () => {
  const { args } = buildAgentCommand('claude', 'read only', {
    permissionMode: 'observer',
    cwd: '/w',
  });
  assert.doesNotMatch(args.join(' '), /acceptEdits/);
  assert.match(args[1], /OBSERVER/i);
});

test('buildAgentCommand carries session memory so follow-ups know prior Office outputs', () => {
  const { args } = buildAgentCommand('claude', '继续改表头', {
    cwd: '/Users/x/Docs',
    openDocument: { name: '555.xlsx', path: '/Users/x/Docs/555.xlsx' },
    sessionMemory: {
      focusPath: 'Magies Office Output/555.xlsx',
      recentWrites: [{ path: 'Magies Office Output/555.xlsx', toolId: 'office:excel:write', at: 1 }],
      recentTools: [],
      notes: [],
    },
  });
  const prompt = args[1];
  assert.match(prompt, /Session focus document/);
  assert.match(prompt, /Magies Office Output\/555\.xlsx/);
  assert.ok(prompt.endsWith('继续改表头'));
});

test('buildAgentCommand says plainly when the open document is not on disk', () => {
  const { args } = buildAgentCommand('claude', 'go', {
    cwd: '/w',
    openDocument: { name: '未命名.xlsx', path: '' },
  });

  assert.match(args[1], /未命名\.xlsx/);
  // Naming a file the CLI cannot open would send it hunting for one.
  assert.match(args[1], /not been saved|尚未保存/i);
});

test('buildAgentCommand always injects Magies-hands policy even without cwd', () => {
  const prompt = buildAgentCommand('claude', 'hello').args[1];
  assert.match(prompt, /magies-office MCP/i);
  assert.ok(prompt.endsWith('hello'));
});

test('a follow-up turn continues the CLI own conversation', () => {
  // Each turn is a fresh process, so without this the agent has no idea what
  // "change it again" refers to.
  assert.match(buildAgentCommand('claude', 'again', { resume: true }).args.join(' '), /--continue/);
  assert.match(buildAgentCommand('antigravity', 'again', { resume: true }).args.join(' '), /--continue/);
  assert.match(buildAgentCommand('grok', 'again', { resume: true }).args.join(' '), /--continue/);
  assert.match(buildAgentCommand('cursor', 'again', { resume: true }).args.join(' '), /--continue/);
});

/**
 * `gemini --help` has no `--continue`. Resuming is `-r, --resume`, and
 * "latest" is how it names the most recent session. The flag it was given
 * failed every follow-up turn — and only follow-ups, which is why it went
 * unnoticed: the first turn of any conversation was fine.
 */
test('gemini resumes with the flag it actually has', () => {
  const resumed = buildAgentCommand('gemini', 'again', { resume: true }).args.join(' ');
  assert.match(resumed, /--resume latest/);
  assert.doesNotMatch(resumed, /--continue/);
});


test('Codex keeps the prompt trailing once model flags are added', () => {
  // Its prompt is a positional, so a flag appended after it would be read as
  // part of the request rather than as an option.
  const args = buildAgentCommand('codex', 'fill the sheet', {
    permissionMode: 'auto',
    model: 'gpt-5-codex',
  }).args;
  assert.ok(String(args.at(-1)).endsWith('fill the sheet'));
  assert.doesNotMatch(args.join(' '), /--sandbox read-only/);
});

test('Codex resumes through its own subcommand, not a flag', () => {
  // `codex exec` takes no --continue; resuming is `exec resume --last`, and the
  // prompt moves after it.
  const resumed = buildAgentCommand('codex', 'again', { resume: true }).args;
  assert.deepEqual(resumed.slice(0, 4), ['exec', 'resume', '--last', '--json']);
  assert.ok(String(resumed.at(-1)).endsWith('again'));
  const first = buildAgentCommand('codex', 'first').args;
  assert.deepEqual(first.slice(0, 2), ['exec', '--json']);
  assert.ok(String(first.at(-1)).endsWith('first'));
});

test('the first turn of a conversation never resumes someone else session', () => {
  for (const id of ['claude', 'codex', 'antigravity', 'grok', 'cursor']) {
    const args = buildAgentCommand(id, 'hello').args.join(' ');
    assert.doesNotMatch(args, /--continue|resume/, id);
  }
});

test('buildAgentCommand rejects an unknown agent', () => {
  assert.throws(() => buildAgentCommand('nope', 'x'), /unknown/i);
});

test('parseAgentLine reads Claude stream-json text and tool calls', () => {
  const events = parseAgentLine(JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.pdf' } },
      ],
    },
  }));

  assert.deepEqual(events[0], { kind: 'text', text: 'working on it' });
  assert.equal(events[1].kind, 'tool');
  assert.equal(events[1].name, 'Read');
  assert.match(events[1].detail, /a\.pdf/);
});

test('parseAgentLine reads the Claude final result', () => {
  const events = parseAgentLine(JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'all done',
  }));
  assert.deepEqual(events, [{ kind: 'final', text: 'all done' }]);
});

test('parseAgentLine surfaces a Claude error result as an error', () => {
  const events = parseAgentLine(JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    result: 'it broke',
  }));
  assert.equal(events[0].kind, 'error');
  assert.match(events[0].message, /it broke/);
});

test('parseAgentLine reads both Codex event shapes', () => {
  const older = parseAgentLine(JSON.stringify({
    msg: { type: 'agent_message', message: 'from codex' },
  }));
  assert.deepEqual(older, [{ kind: 'text', text: 'from codex' }]);

  const newer = parseAgentLine(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'newer codex' },
  }));
  assert.deepEqual(newer, [{ kind: 'text', text: 'newer codex' }]);
});

test('parseAgentLine reports a Codex command execution as a tool call', () => {
  const events = parseAgentLine(JSON.stringify({
    msg: { type: 'exec_command_begin', command: ['ls', '-la'] },
  }));
  assert.equal(events[0].kind, 'tool');
  assert.match(events[0].detail, /ls -la/);
});

test('parseAgentLine ignores bookkeeping events rather than showing them as text', () => {
  assert.deepEqual(parseAgentLine(JSON.stringify({ type: 'system', subtype: 'init' })), []);
  assert.deepEqual(parseAgentLine(''), []);
  assert.deepEqual(parseAgentLine('   '), []);
});

test('parseAgentLine treats an unparsable line as plain output', () => {
  assert.deepEqual(parseAgentLine('just some text'), [{ kind: 'text', text: 'just some text\n' }]);
});

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; };
  child.killed = false;
  return child;
}

/**
 * `run` awaits agent resolution before spawning, so a test must wait for the
 * spawn before pushing output — otherwise it writes to a stream nobody is
 * listening to yet. `spawned` is that signal.
 */
function runnerWith(child, overrides = {}) {
  let signalSpawned;
  const spawned = new Promise((resolve) => { signalSpawned = resolve; });
  const runner = createCliRunner({
    spawn: (...call) => {
      signalSpawned(call);
      return child;
    },
    resolveAgent: async () => ({ id: 'claude', path: '/bin/claude', installed: true }),
    ...overrides,
  });
  return { runner, spawned };
}

test('run streams text and tool events, then resolves with the final message', async () => {
  const child = fakeProcess();
  const events = [];
  const { runner, spawned } = runnerWith(child);

  const running = runner.run({
    agentId: 'claude',
    prompt: 'hi',
    cwd: '/work',
    onEvent: (event) => events.push(event),
  });
  await spawned;

  child.stdout.emit('data', Buffer.from(
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'part ' }] } })}\n`,
  ));
  child.stdout.emit('data', Buffer.from(
    `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } })}\n`,
  ));
  child.stdout.emit('data', Buffer.from(
    `${JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })}\n`,
  ));
  child.emit('close', 0);

  const result = await running;

  assert.equal(result.message, 'done');
  assert.ok(events.some((event) => event.type === 'assistant_delta' && event.delta === 'part '));
  assert.ok(events.some((event) => event.type === 'tool_start'));
  assert.ok(events.some((event) => event.type === 'tool_result'));
});

test('run reassembles a JSON event split across two chunks', async () => {
  const child = fakeProcess();
  const events = [];
  const { runner, spawned } = runnerWith(child);

  const running = runner.run({ agentId: 'claude', prompt: 'hi', cwd: '/w', onEvent: (e) => events.push(e) });
  await spawned;

  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'split' }] } });
  child.stdout.emit('data', Buffer.from(line.slice(0, 20)));
  child.stdout.emit('data', Buffer.from(`${line.slice(20)}\n`));
  child.emit('close', 0);
  await running;

  assert.ok(events.some((event) => event.delta === 'split'));
});

test('reassembles a multi-byte character split across two chunks', async () => {
  const child = fakeProcess();
  const events = [];
  const { runner, spawned } = runnerWith(child);

  const running = runner.run({ agentId: 'claude', prompt: 'hi', cwd: '/w', onEvent: (e) => events.push(e) });
  await spawned;

  // A CLI writing Chinese will sooner or later split a 3-byte character across
  // a chunk boundary; decoding each half on its own yields U+FFFD.
  const line = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '随时等您的指示' }] } })}\n`;
  const bytes = Buffer.from(line, 'utf8');
  // Split one byte into the first multi-byte character, which is where a real
  // chunk boundary does the damage.
  const split = bytes.indexOf(Buffer.from('随', 'utf8')) + 1;
  assert.equal((bytes[split] & 0xc0) === 0x80, true, 'the split must land inside a character');

  child.stdout.emit('data', bytes.subarray(0, split));
  child.stdout.emit('data', bytes.subarray(split));
  child.emit('close', 0);
  const result = await running;

  assert.equal(result.message, '随时等您的指示');
  assert.equal(JSON.stringify(events).includes('\ufffd'), false, 'no replacement characters');
});

test('an explanation on stderr is shown even when the CLI exits cleanly', async () => {
  const child = fakeProcess();
  const { runner, spawned } = runnerWith(child);
  const running = runner.run({ agentId: 'antigravity', prompt: 'hi', cwd: '/w', onEvent: () => {} });
  await spawned;

  // This is how a headless agent reports that it gave up: exit 0, nothing on
  // stdout, the reason on stderr. Dropping it leaves the user with a blank.
  child.stderr.emit('data', Buffer.from(
    'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for.',
  ));
  child.emit('close', 0);

  const result = await running;
  assert.match(result.message, /cannot prompt for/);
});

test('a failed run reports the command and the exit code, not just a message', async () => {
  const child = fakeProcess();
  const { runner, spawned } = runnerWith(child);
  const running = runner.run({ agentId: 'claude', prompt: 'hi', cwd: '/w', onEvent: () => {} });
  await spawned;

  child.emit('close', 3);

  // Without the invocation in the error there is nothing to reproduce from:
  // the app and the shell would have to be compared by hand.
  await assert.rejects(running, (error) => {
    assert.match(error.message, /exited with code 3/);
    assert.match(error.message, /--output-format stream-json/);
    return true;
  });
});

test('run fails with the stderr tail when the CLI exits non-zero', async () => {
  const child = fakeProcess();
  const { runner, spawned } = runnerWith(child);
  const running = runner.run({ agentId: 'claude', prompt: 'hi', cwd: '/w', onEvent: () => {} });
  await spawned;

  child.stderr.emit('data', Buffer.from('not logged in'));
  child.emit('close', 1);

  await assert.rejects(running, /not logged in/);
});

test('run refuses an agent that is not installed', async () => {
  const { runner } = runnerWith(fakeProcess(), {
    resolveAgent: async () => ({ id: 'claude', path: '', installed: false }),
  });
  await assert.rejects(
    () => runner.run({ agentId: 'claude', prompt: 'hi', cwd: '/w', onEvent: () => {} }),
    /not installed/i,
  );
});

test('run refuses to start without a working directory', async () => {
  const { runner } = runnerWith(fakeProcess());
  await assert.rejects(
    () => runner.run({ agentId: 'claude', prompt: 'hi', cwd: '', onEvent: () => {} }),
    /workspace/i,
  );
});

test('cancelling a run kills the child process', async () => {
  const child = fakeProcess();
  const controller = new AbortController();
  const { runner, spawned } = runnerWith(child);

  const running = runner.run({
    agentId: 'claude',
    prompt: 'hi',
    cwd: '/w',
    signal: controller.signal,
    onEvent: () => {},
  });
  await spawned;

  controller.abort();
  assert.equal(child.killed, true);
  child.emit('close', null);
  await assert.rejects(running, /cancel/i);
});

/**
 * A resume that has nothing to resume is not a failed turn.
 *
 * grok keys its sessions by working directory and exits 1 with "No session
 * found for current directory" when there is none — which happens whenever the
 * granted folder changes, or its session store is cleaned, even though this app
 * believes the conversation is ongoing. The turn should start a fresh session
 * rather than hand the user an error about session bookkeeping.
 */
test('a missing session is told apart from a real failure', () => {
  const { isMissingSessionFailure } = require('./cliRunner.cjs');

  assert.equal(isMissingSessionFailure(
    "Error: No session found for current directory. Use 'grok' to start a new session.",
  ), true);
  assert.equal(isMissingSessionFailure('No previous session to continue'), true);
  assert.equal(isMissingSessionFailure('nothing to resume'), true);

  // Real failures must still be reported as failures.
  assert.equal(isMissingSessionFailure('rate limit exceeded'), false);
  assert.equal(isMissingSessionFailure('unexpected argument --ask-for-approval found'), false);
  assert.equal(isMissingSessionFailure('the session produced no output'), false);
  assert.equal(isMissingSessionFailure(''), false);
  assert.equal(isMissingSessionFailure(undefined), false);
});
