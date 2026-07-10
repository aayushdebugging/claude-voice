import { Box, render, Static, Text, useApp, useInput, useStdout } from 'ink';
import { useEffect, useRef, useState } from 'react';

import { VoiceEvent, type VoiceBus } from '../../events/index.js';
import type { Conversation } from '../../core/conversation.js';
import type { ConversationState, VoiceConfig } from '../../types/index.js';
import { describeError } from '../../utils/errors.js';
import { parseSpeed } from '../../utils/rate.js';

/** A rendered transcript entry. */
type Role = 'header' | 'you' | 'claude' | 'notice' | 'error' | 'help';
interface Msg {
  id: number;
  role: Role;
  text: string;
  meta?: string;
}

type Mode = 'normal' | 'type' | 'command';

/** Slash commands available from the command palette. */
const COMMANDS: Array<{ name: string; desc: string }> = [
  { name: 'help', desc: 'show keys & commands' },
  { name: 'clear', desc: 'clear the transcript' },
  { name: 'mute', desc: 'stop speaking responses (text-only)' },
  { name: 'speak', desc: 'resume speaking responses' },
  { name: 'voice', desc: 'change TTS voice — /voice <name>' },
  { name: 'model', desc: 'switch Claude model — /model <opus|sonnet|fable>' },
  { name: 'speed', desc: 'set speech rate — /speed <0.5–3.0> (e.g. /speed 1.5)' },
  { name: 'lang', desc: 'switch language — /lang <code> (e.g. /lang hi, /lang auto)' },
  { name: 'stream', desc: 'toggle speaking as Claude writes vs all at once' },
  { name: 'quit', desc: 'exit claude-voice' },
];

const HELP_TEXT = [
  'SPACE   tap to talk · tap again to send · interrupt while Claude replies',
  't       type a message to Claude (↑/↓ recalls history)',
  '/       command palette',
  'q       quit',
  '',
  'Commands: /help /clear /mute /speak /voice <name> /model <name>',
  '          /speed <0.5–3.0> /lang <code> /stream /quit',
].join('\n');

/** Brand gradient stops — amber → pink → violet → blue. */
const BRAND = ['#f5a623', '#e8618c', '#a66cff', '#5b8cff'];
const BRAND_ACCENT = '#a66cff';
const YOU_COLOR = '#4dd0e1';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
  );
}
/** Interpolate `count` colors evenly across the given hex stops. */
function gradient(stops: string[], count: number): string[] {
  if (count <= 1) return [stops[0]!];
  const rgb = stops.map(hexToRgb);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i / (count - 1)) * (rgb.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(rgb.length - 1, lo + 1);
    const f = t - lo;
    const [r1, g1, b1] = rgb[lo]!;
    const [r2, g2, b2] = rgb[hi]!;
    out.push(toHex(r1 + (r2 - r1) * f, g1 + (g2 - g1) * f, b1 + (b2 - b1) * f));
  }
  return out;
}

/** Render text with a per-character brand gradient. */
function GradientText({ text, bold }: { text: string; bold?: boolean }): JSX.Element {
  const colors = gradient(BRAND, text.length);
  return (
    <Text bold={bold}>
      {[...text].map((ch, i) => (
        <Text key={i} color={colors[i]}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** A color per spinner frame, so the loader shimmers through the brand palette. */
const SPIN_COLORS = gradient(
  ['#f5a623', '#e8618c', '#a66cff', '#5b8cff', '#a66cff', '#e8618c'],
  SPINNER.length,
);

/** Returns the current spinner frame index while active, or -1 when idle. */
function useSpinner(active: boolean): number {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 80);
    return () => clearInterval(t);
  }, [active]);
  return active ? frame : -1;
}

/** Vertical bar glyphs from empty → full, for the waveform. */
const BARS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** A counter that advances every `ms` while active — drives animations. */
function useTick(active: boolean, ms = 100): number {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT((n) => (n + 1) % 100000), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return t;
}

/**
 * An animated audio waveform: gradient bars that react to `level` and travel
 * sideways with `phase`, so it looks alive while listening or speaking.
 */
function Waveform({
  level,
  phase,
  cells = 16,
}: {
  level: number;
  phase: number;
  cells?: number;
}): JSX.Element {
  const colors = gradient(BRAND, cells);
  const bars: JSX.Element[] = [];
  for (let i = 0; i < cells; i++) {
    const travel = (Math.sin(phase / 2 + i * 0.55) + 1) / 2; // 0..1 moving wave
    const h = Math.max(0, Math.min(1, level * (0.45 + 0.75 * travel)));
    bars.push(
      <Text key={i} color={colors[i]}>
        {BARS[Math.round(h * (BARS.length - 1))]}
      </Text>,
    );
  }
  return <Text>{bars}</Text>;
}

/** Brand text whose gradient flows sideways with `offset` — a techy shimmer. */
function GradientFlow({
  text,
  offset,
  bold,
}: {
  text: string;
  offset: number;
  bold?: boolean;
}): JSX.Element {
  const loop = gradient([...BRAND, ...[...BRAND].reverse()], text.length + 16);
  return (
    <Text bold={bold}>
      {[...text].map((ch, i) => (
        <Text key={i} color={loop[(i + offset) % loop.length]}>
          {ch}
        </Text>
      ))}
    </Text>
  );
}

function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  const start = useRef(0);
  useEffect(() => {
    if (!active) {
      setMs(0);
      return;
    }
    start.current = performance.now();
    const t = setInterval(() => setMs(performance.now() - start.current), 100);
    return () => clearInterval(t);
  }, [active]);
  return ms;
}

function fmt(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function countWords(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

function Message({ msg }: { msg: Msg }): JSX.Element {
  switch (msg.role) {
    case 'header': {
      const chips = msg.text.split(' → ');
      const chipColors = ['#4dd0e1', '#a66cff', '#e8618c'];
      return (
        <Box
          marginBottom={1}
          borderStyle="round"
          borderColor={BRAND_ACCENT}
          paddingX={1}
          flexDirection="column"
        >
          <Box>
            <Text>🎙️ </Text>
            <GradientText text=" Claude Voice AI" bold />
            <Text dimColor> · talk to Claude, hear it think back</Text>
          </Box>
          <Box marginTop={1}>
            {chips.map((c, i) => (
              <Text key={i}>
                {i > 0 ? <Text dimColor> ▸ </Text> : null}
                <Text backgroundColor={chipColors[i % chipColors.length]!} color="#11111b" bold>
                  {' '}
                  {c}{' '}
                </Text>
              </Text>
            ))}
          </Box>
        </Box>
      );
    }
    case 'you':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={YOU_COLOR}>
            ❯ You{msg.meta ? <Text dimColor> · {msg.meta}</Text> : null}
          </Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'claude':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={BRAND_ACCENT}>
            ✦ Claude{msg.meta ? <Text dimColor> · {msg.meta}</Text> : null}
          </Text>
          <Text>{msg.text}</Text>
        </Box>
      );
    case 'help':
      return (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={BRAND_ACCENT}
          paddingX={1}
          flexDirection="column"
        >
          <Text bold color={BRAND_ACCENT}>
            ✦ Claude Voice AI · keys & commands
          </Text>
          <Text dimColor>{msg.text}</Text>
        </Box>
      );
    case 'notice':
      return (
        <Box marginTop={1}>
          <Text color="yellow">⚠  {msg.text}</Text>
        </Box>
      );
    default:
      return (
        <Box marginTop={1}>
          <Text color="red">✖  {msg.text}</Text>
        </Box>
      );
  }
}

interface StatusProps {
  phase: ConversationState;
  config: VoiceConfig;
  /** Current spinner frame index, or -1 when idle. */
  spinner: number;
  elapsedMs: number;
  words: number;
  wps: number;
  level: number;
  speaking: boolean;
}

function statusText(phase: ConversationState, config: VoiceConfig, elapsedMs: number): {
  text: string;
  color: string;
} {
  switch (phase) {
    case 'listening':
      return { text: '🎤  Listening…', color: 'green' };
    case 'transcribing':
      return { text: '📝  Transcribing…', color: 'blue' };
    case 'thinking':
      return { text: `🧠  Thinking… ${fmt(elapsedMs)}`, color: 'magenta' };
    case 'speaking':
      return { text: '🔊  Speaking…', color: 'yellow' };
    default:
      return config.pushToTalk
        ? { text: 'Ready — tap SPACE to talk', color: 'gray' }
        : { text: 'Ready — just start talking', color: 'gray' };
  }
}

function StatusBar({
  phase,
  config,
  spinner,
  elapsedMs,
  words,
  wps,
  level,
  speaking,
}: StatusProps): JSX.Element {
  // Speaking takes visual priority (it can happen while still generating), so
  // the user sees it read aloud rather than a misleading "Thinking".
  const showSpeaking = speaking && phase !== 'listening' && phase !== 'transcribing';
  const { text, color } = showSpeaking
    ? { text: phase === 'thinking' ? '🔊  Speaking… (writing more…)' : '🔊  Speaking…', color: 'yellow' }
    : statusText(phase, config, elapsedMs);
  const busy = phase !== 'idle' || speaking;
  const tick = useTick(busy, 100);
  const throughput = phase === 'thinking' && !showSpeaking && words > 0 ? `  ${words}w · ${wps} w/s` : '';
  const hint =
    phase === 'thinking' || phase === 'speaking'
      ? 'SPACE interrupt · q quit'
      : phase === 'listening'
        ? 'SPACE send · q quit'
        : config.pushToTalk
          ? 'SPACE talk · t type · / cmds · q quit'
          : 'SPACE send · t type · / cmds · q quit';
  const spin =
    busy && spinner >= 0 ? (
      <Text color={SPIN_COLORS[spinner % SPIN_COLORS.length]!}>{SPINNER[spinner]!} </Text>
    ) : null;
  // A live waveform: mic-reactive while listening, an activity dance while speaking.
  const wave =
    phase === 'listening' ? (
      <Text> <Waveform level={level} phase={tick} /></Text>
    ) : showSpeaking ? (
      <Text> <Waveform level={0.72} phase={tick} /></Text>
    ) : null;
  return (
    <Box marginTop={1} flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={color}>
          {spin}
          {text}
          {wave}
          <Text dimColor>{throughput}</Text>
        </Text>
        <Text dimColor>{hint}</Text>
      </Box>
      {busy ? (
        <GradientFlow text="✦ Claude Voice AI ✦" offset={tick} />
      ) : (
        <Text dimColor>✦ Claude Voice AI</Text>
      )}
    </Box>
  );
}

const CHECK_COLOR = '#7cfc00';

/**
 * A quick animated boot sequence: the brand logo shimmers while system checks
 * light up one-by-one, then it hands off to the live UI. Any key skips it.
 */
function BootSequence({
  config,
  onDone,
}: {
  config: VoiceConfig;
  onDone: () => void;
}): JSX.Element {
  const [step, setStep] = useState(0);
  const flow = useTick(true, 80);
  const steps = [
    { label: 'speech-to-text', value: config.stt },
    { label: 'text-to-speech', value: config.autoSpeak ? config.tts : 'muted' },
    { label: 'claude cli', value: String(config.model) },
    { label: 'audio engine', value: config.streamSpeech ? 'streaming' : 'batch' },
  ];
  useEffect(() => {
    if (step > steps.length) {
      const t = setTimeout(onDone, 320);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), step === 0 ? 260 : 150);
    return () => clearTimeout(t);
  }, [step]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <GradientFlow text="✦  Claude Voice AI  ✦" offset={flow} bold />
      <Box marginTop={1} flexDirection="column">
        {steps.map((s, i) => {
          const done = step > i;
          return (
            <Text key={i}>
              <Text color={done ? CHECK_COLOR : 'gray'}>{done ? '✓' : '◦'}</Text>
              <Text dimColor> {s.label.padEnd(16)} </Text>
              {done ? <Text color={BRAND_ACCENT}>{s.value}</Text> : null}
            </Text>
          );
        })}
        {step > steps.length ? (
          <Text bold color={CHECK_COLOR}>
            ▸ ready — start talking
          </Text>
        ) : (
          <Text dimColor>◇ initializing…</Text>
        )}
      </Box>
    </Box>
  );
}

interface AppProps {
  config: VoiceConfig;
  bus: VoiceBus;
  conversation: Conversation;
  subtitle: string;
  notices?: string[];
  onReady?: () => void;
}

export function App({
  config,
  bus,
  conversation,
  subtitle,
  notices = [],
  onReady,
}: AppProps): JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const idRef = useRef(1);
  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: 0, role: 'header', text: subtitle },
    ...notices.map((text) => ({ id: idRef.current++, role: 'notice' as const, text })),
  ]);
  const [staticKey, setStaticKey] = useState(0);
  const [phase, setPhase] = useState<ConversationState>('idle');
  const [liveText, setLiveText] = useState('');
  const [mode, setMode] = useState<Mode>('normal');
  const [draft, setDraft] = useState('');
  const [level, setLevel] = useState(0);
  const levelRef = useRef(0);
  const [speaking, setSpeaking] = useState(false);
  const speakingTimer = useRef<NodeJS.Timeout | null>(null);
  const [booting, setBooting] = useState(true);
  const readyRef = useRef(false);

  // Start the pipeline only once the boot sequence finishes (or is skipped),
  // so the mic doesn't open behind the splash.
  const finishBoot = (): void => {
    if (readyRef.current) return;
    readyRef.current = true;
    setBooting(false);
    onReady?.();
  };

  const liveRef = useRef('');
  const flushRef = useRef<NodeJS.Timeout | null>(null);
  const firstTokenAt = useRef<number | null>(null);
  const history = useRef<string[]>([]);
  const historyIdx = useRef(0);

  const spinner = useSpinner((phase !== 'idle' || speaking) && mode === 'normal');
  const elapsedMs = useElapsed(phase === 'thinking');

  const push = (m: Omit<Msg, 'id'>): void =>
    setMessages((cur) => [...cur, { id: idRef.current++, ...m }]);

  useEffect(() => {
    const clearLive = (): void => {
      if (flushRef.current) {
        clearTimeout(flushRef.current);
        flushRef.current = null;
      }
      liveRef.current = '';
      firstTokenAt.current = null;
      setLiveText('');
    };
    const offs = [
      bus.on(VoiceEvent.StateChanged, ({ to }) => {
        setPhase(to);
        // Reset the mic meter on any phase change.
        levelRef.current = 0;
        setLevel(0);
      }),
      bus.on(VoiceEvent.AudioLevel, ({ level: l }) => {
        // Rise fast, fall slowly — a VU-meter feel.
        levelRef.current = Math.max(l, levelRef.current * 0.65);
        setLevel(levelRef.current);
      }),
      bus.on(VoiceEvent.SpeechRecognized, (r) => {
        if (r.text) push({ role: 'you', text: r.text, meta: fmt(r.latencyMs) });
      }),
      bus.on(VoiceEvent.ClaudeToken, ({ text }) => {
        if (firstTokenAt.current === null) firstTokenAt.current = performance.now();
        liveRef.current += text;
        if (!flushRef.current) {
          flushRef.current = setTimeout(() => {
            flushRef.current = null;
            setLiveText(liveRef.current);
          }, 40);
        }
      }),
      bus.on(VoiceEvent.ClaudeFinished, ({ text, elapsedMs: took }) => {
        clearLive();
        if (text) push({ role: 'claude', text, meta: `${fmt(took)} · ${countWords(text)}w` });
      }),
      // Track speaking independently of the thinking/generating phase so the UI
      // shows "Speaking" whenever audio is actually playing — even mid-generation.
      // A short debounce keeps it steady across the tiny gaps between sentences.
      bus.on(VoiceEvent.SpeechStarted, () => {
        if (speakingTimer.current) {
          clearTimeout(speakingTimer.current);
          speakingTimer.current = null;
        }
        setSpeaking(true);
      }),
      bus.on(VoiceEvent.SpeechFinished, () => {
        if (speakingTimer.current) clearTimeout(speakingTimer.current);
        speakingTimer.current = setTimeout(() => setSpeaking(false), 500);
      }),
      bus.on(VoiceEvent.Interrupted, () => {
        clearLive();
        if (speakingTimer.current) clearTimeout(speakingTimer.current);
        setSpeaking(false);
        push({ role: 'notice', text: 'interrupted' });
      }),
      bus.on(VoiceEvent.Error, ({ scope, error }) => {
        push({ role: scope === 'microphone' ? 'notice' : 'error', text: describeError(error) });
      }),
      bus.on(VoiceEvent.ConversationEnded, () => exit()),
    ];
    return () => {
      for (const off of offs) off();
      if (flushRef.current) clearTimeout(flushRef.current);
      if (speakingTimer.current) clearTimeout(speakingTimer.current);
    };
  }, [bus]);

  const clearTranscript = (): void => {
    stdout?.write('\x1b[2J\x1b[3J\x1b[H');
    setMessages([{ id: idRef.current++, role: 'header', text: subtitle }]);
    setStaticKey((k) => k + 1);
  };

  const runCommand = (line: string): void => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '':
        break;
      case 'help':
        push({ role: 'help', text: HELP_TEXT });
        break;
      case 'clear':
        clearTranscript();
        break;
      case 'mute':
        conversation.setAutoSpeak(false);
        push({ role: 'notice', text: 'muted — responses are text-only' });
        break;
      case 'speak':
      case 'unmute':
        conversation.setAutoSpeak(true);
        push({ role: 'notice', text: 'speaking enabled' });
        break;
      case 'voice':
        if (arg) {
          conversation.setVoice(arg);
          push({ role: 'notice', text: `voice → ${arg}` });
        } else {
          push({ role: 'error', text: 'usage: /voice <name>' });
        }
        break;
      case 'model':
        if (arg) {
          conversation.setModel(arg);
          push({ role: 'notice', text: `model → ${arg} (applies next turn)` });
        } else {
          push({ role: 'error', text: 'usage: /model <opus|sonnet|fable>' });
        }
        break;
      case 'speed': {
        const rate = parseSpeed(arg);
        if (rate === null) {
          push({ role: 'error', text: 'usage: /speed <0.5–3.0>  (e.g. /speed 1.5 or /speed 2x)' });
        } else {
          conversation.setSpeed(rate);
          push({ role: 'notice', text: `speech rate → ${rate}× (applies next reply)` });
        }
        break;
      }
      case 'lang':
      case 'language':
        if (arg) {
          const code = arg.trim().toLowerCase();
          conversation.setLanguage(code);
          push({ role: 'notice', text: `language → ${code} (applies next turn)` });
          // English-only local STT can't transcribe other languages — warn.
          const enOnly = config.stt === 'whispercpp' && /\.en\b/.test(config.providers.whispercpp.model);
          if (code !== 'auto' && code !== 'en' && enOnly) {
            push({
              role: 'notice',
              text: `whisper model "${config.providers.whispercpp.model}" is English-only — switch to a multilingual model (e.g. ggml-base.bin) to transcribe ${code}.`,
            });
          }
        } else {
          push({ role: 'error', text: 'usage: /lang <code>  (e.g. /lang hi, /lang es, /lang auto)' });
        }
        break;
      case 'stream': {
        const on = !config.streamSpeech;
        conversation.setStreamSpeech(on);
        push({
          role: 'notice',
          text: on
            ? 'streaming on — speaks as Claude writes (needs a streaming player; falls back to batch otherwise)'
            : 'streaming off — speaks the whole reply once it finishes',
        });
        break;
      }
      case 'quit':
      case 'exit':
        exit();
        break;
      default:
        push({ role: 'error', text: `unknown command: /${cmd} (try /help)` });
    }
  };

  useInput((input, key) => {
    // While the boot splash is up, any key skips straight to the live UI.
    if (booting) {
      finishBoot();
      return;
    }
    // ---- text entry modes (type a message / a command) ----
    if (mode === 'type' || mode === 'command') {
      if (key.return) {
        const text = draft.trim();
        setMode('normal');
        setDraft('');
        if (mode === 'type' && text) {
          history.current.push(text);
          historyIdx.current = history.current.length;
          push({ role: 'you', text });
          void conversation.sendText(text);
        } else if (mode === 'command') {
          runCommand(text);
        }
        return;
      }
      if (key.escape) {
        setMode('normal');
        setDraft('');
        return;
      }
      // ↑/↓ recall previous typed prompts (type mode only).
      if (mode === 'type' && (key.upArrow || key.downArrow)) {
        const h = history.current;
        if (h.length === 0) return;
        historyIdx.current = key.upArrow
          ? Math.max(0, historyIdx.current - 1)
          : Math.min(h.length, historyIdx.current + 1);
        setDraft(historyIdx.current < h.length ? h[historyIdx.current]! : '');
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((d) => {
          if (d.length === 0 && mode === 'command') setMode('normal');
          return d.slice(0, -1);
        });
        return;
      }
      if (input && !key.ctrl && !key.meta) setDraft((d) => d + input);
      return;
    }

    // ---- normal mode ----
    if (input === 'q') {
      exit();
      return;
    }
    if (input === 't') {
      setMode('type');
      setDraft('');
      historyIdx.current = history.current.length;
      return;
    }
    if (input === '/') {
      setMode('command');
      setDraft('');
      return;
    }
    if (input === ' ') {
      // Single state-aware key: start listening, send, or interrupt.
      void (config.pushToTalk ? conversation.onTalkKey() : conversation.handleSpace());
    }
  });

  const liveWords = countWords(liveText);
  const since = firstTokenAt.current ? (performance.now() - firstTokenAt.current) / 1000 : 0;
  const wps = since > 0.3 ? Math.round(liveWords / since) : 0;

  const suggestions =
    mode === 'command'
      ? COMMANDS.filter((c) => c.name.startsWith(draft.split(/\s+/)[0] ?? ''))
      : [];

  if (booting) {
    return <BootSequence config={config} onDone={finishBoot} />;
  }

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={messages}>
        {(m) => <Message key={m.id} msg={m} />}
      </Static>

      {liveText ? (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color={BRAND_ACCENT}>
            ✦ Claude
          </Text>
          <Text>{liveText}</Text>
        </Box>
      ) : null}

      {mode === 'command' ? (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={BRAND_ACCENT}>/</Text>
            <Text>{draft}</Text>
            <Text inverse> </Text>
          </Box>
          {suggestions.map((c) => (
            <Box key={c.name}>
              <Text color={BRAND_ACCENT}>{`  /${c.name}`.padEnd(14)}</Text>
              <Text dimColor>{c.desc}</Text>
            </Box>
          ))}
        </Box>
      ) : mode === 'type' ? (
        <Box marginTop={1}>
          <Text color={YOU_COLOR}>› </Text>
          <Text>{draft}</Text>
          <Text inverse> </Text>
        </Box>
      ) : null}

      {mode === 'normal' ? (
        <StatusBar
          phase={phase}
          config={config}
          spinner={spinner}
          elapsedMs={elapsedMs}
          words={liveWords}
          wps={wps}
          level={level}
          speaking={speaking}
        />
      ) : (
        <Box marginTop={1} justifyContent="space-between">
          <Text color="cyan">{mode === 'type' ? '⌨  Type your message' : '⌨  Command'}</Text>
          <Text dimColor>Enter {mode === 'type' ? 'send' : 'run'} · Esc cancel</Text>
        </Box>
      )}
    </Box>
  );
}

export interface InkSessionOptions {
  config: VoiceConfig;
  bus: VoiceBus;
  conversation: Conversation;
  subtitle: string;
  notices?: string[];
  onReady?: () => void;
}

/** Render the Ink UI and resolve when the user quits (or the session ends). */
export async function runInkSession(options: InkSessionOptions): Promise<void> {
  const instance = render(
    <App
      config={options.config}
      bus={options.bus}
      conversation={options.conversation}
      subtitle={options.subtitle}
      notices={options.notices}
      onReady={options.onReady}
    />,
    { exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
}
