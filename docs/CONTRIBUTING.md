# Contributing to claude-voice

Thanks for your interest in improving `claude-voice`! This project aims to be a
clean, well-tested, extensible voice layer for the Claude CLI, and contributions
of all sizes are welcome.

## Development setup

```bash
git clone https://github.com/claude-voice/claude-voice.git
cd claude-voice
npm install
```

Useful scripts:

| Command | Description |
| --- | --- |
| `npm run dev -- <args>` | Run the CLI from source (via `tsx`), e.g. `npm run dev -- doctor` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the unit tests once |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Tests with a coverage report |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

## Project layout

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and design
principles. In short: small modules, an event-driven core, providers behind
interfaces, and no business logic in the CLI layer.

## Coding standards

- **TypeScript strict mode.** No `any` unless truly unavoidable (and lint-flagged).
- **Small files, single responsibility.** If a file is doing two jobs, split it.
- **Comment the *why*.** Explain non-obvious decisions, not what the code plainly says.
- **No crashes.** Recoverable failures become typed errors and `Error` events; the process should never take down a conversation.
- **Match the surrounding style.** Prettier + ESLint are enforced in CI and via a pre-commit hook (Husky + lint-staged).

Before opening a PR:

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

## Adding a provider

1. Implement `SttProvider` or `TtsProvider` (see [API.md](./API.md)).
2. Register it in `src/stt/factory.ts` or `src/tts/factory.ts`.
3. Add its name to the union in `src/types/index.ts`.
4. Add config defaults in `src/config/defaults.ts` and a `doctor` health check.
5. Add tests with the network layer mocked.

## Adding a plugin

Implement the `Plugin` interface (`src/plugins/types.ts`) and, if it's built-in,
export it from `src/plugins/index.ts`. Keep plugins decoupled — they interact
only through the event bus and the public `Conversation` API.

## Tests

- Put tests in `test/` (or alongside as `*.test.ts`). We use [Vitest](https://vitest.dev).
- **Mock STT and TTS** — never hit real provider APIs in tests.
- The streaming sentence parser, speech queue interruption, config merge, event
  bus, Claude stream parsing, and the conversation pipeline all have coverage;
  keep new logic tested to the same bar.
- The Claude client is tested against a fake CLI fixture (`test/fixtures/fake-claude.mjs`) that speaks the real stream-json protocol.

## Commit & PR conventions

- Write clear, present-tense commit messages (e.g. "add openai stt provider").
- Keep PRs focused. Describe the change, the motivation, and how you tested it.
- Update docs when behavior changes.

## Reporting bugs

Open an issue with:

- your OS and Node version,
- the output of `claude-voice doctor`,
- steps to reproduce and what you expected.

## Code of conduct

Be kind and constructive. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](../LICENSE).
