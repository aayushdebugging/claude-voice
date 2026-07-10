#!/usr/bin/env node
// A stand-in for the Claude CLI used in tests. It reads the prompt from stdin
// and emits the same newline-delimited stream-json protocol the real CLI does,
// branching on the prompt text so tests can exercise different outcomes.
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

  if (input.includes('FAIL')) {
    process.stderr.write('simulated failure\n');
    process.exit(2);
    return;
  }

  emit({ type: 'system', subtype: 'init', session_id: 'test-session', model: 'opus' });

  // Echo the argv we were spawned with so tests can assert flag construction.
  if (input.includes('ARGS')) {
    emit({
      type: 'result',
      subtype: 'success',
      result: process.argv.slice(2).join(' '),
      session_id: 'test-session',
      duration_ms: 1,
    });
    process.exit(0);
    return;
  }

  if (input.includes('HANG')) {
    emit({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    });
    // Never exit; the client is expected to terminate us on interrupt.
    setInterval(() => {}, 1000);
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
  process.exit(0);
});
