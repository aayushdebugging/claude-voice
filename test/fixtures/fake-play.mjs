#!/usr/bin/env node
// Stand-in for sox's `play`: consume the PCM stream on stdin and exit cleanly
// when it ends. Used to test StreamingPlayer without a real audio player.
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => process.exit(0));
