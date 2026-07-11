#!/usr/bin/env node
// A stand-in for the Claude CLI used in tests. It runs in persistent
// streaming-input mode: it reads newline-delimited JSON user messages from stdin
// and, per message, emits the same stream-json protocol the real CLI does —
// staying alive between turns. It branches on the message text so tests can
// exercise different outcomes.
let buf = '';
const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

function textOf(line) {
  try {
    const msg = JSON.parse(line);
    const content = msg?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => b?.text ?? '').join(' ');
  } catch {
    // Not JSON — treat the raw line as the text.
  }
  return line;
}

function handle(text) {
  if (text.includes('FAIL')) {
    process.stderr.write('simulated failure\n');
    process.exit(2);
    return;
  }

  emit({ type: 'system', subtype: 'init', session_id: 'test-session', model: 'opus' });

  // Echo the argv we were spawned with so tests can assert flag construction.
  if (text.includes('ARGS')) {
    emit({
      type: 'result',
      subtype: 'success',
      result: process.argv.slice(2).join(' '),
      session_id: 'test-session',
      duration_ms: 1,
    });
    return;
  }

  if (text.includes('HANG')) {
    emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    });
    // Never emit a result; the client is expected to terminate us on interrupt.
    return;
  }

  for (const w of ['Hello', ' there,', ' friend.']) {
    emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: w } },
    });
  }
  emit({
    type: 'result',
    subtype: 'success',
    result: 'Hello there, friend.',
    session_id: 'test-session',
    total_cost_usd: 0.001,
    duration_ms: 42,
  });
}

process.stdin.setEncoding('utf-8');
process.stdin.on('data', (d) => {
  buf += d;
  let newline = buf.indexOf('\n');
  while (newline !== -1) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    newline = buf.indexOf('\n');
    if (line.trim()) handle(textOf(line));
  }
});
process.stdin.on('end', () => process.exit(0));
