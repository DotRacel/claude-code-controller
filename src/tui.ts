/**
 * tui.ts — the terminal prompts control-claude uses to pick a backend and log in.
 *
 * Hand-rolled against raw stdin and ANSI, for the same reason the websocket framing in
 * web-channel.ts is hand-rolled: this project carries one runtime dependency (pg), and an
 * arrow-key menu is a few dozen lines. No dependency earns its place here.
 *
 * Everything degrades when stdin is not a TTY (a pipe, CI, `< /dev/null`): raw mode is
 * unavailable there, so select() prints a numbered list and reads a line instead of painting a
 * cursor. A prompt that hangs invisibly in a script is worse than an ugly one.
 */
import readline from 'node:readline';

const ESC = '\x1b';
const CSI = `${ESC}[`;
const hideCursor = `${CSI}?25l`;
const showCursor = `${CSI}?25h`;
const clearBelow = `${CSI}0J`;
const up = (n: number) => (n > 0 ? `${CSI}${n}A` : '');

export const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;
export const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
export const accent = (s: string) => `${ESC}[38;5;209m${s}${ESC}[0m`; // the coral the web app uses
export const red = (s: string) => `${ESC}[31m${s}${ESC}[0m`;

/** Thrown when the user hits Ctrl-C / Esc. The CLI treats it as "leave, change nothing". */
export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

export interface Choice<T> {
  value: T;
  label: string;
  /** Shown dimmed after the label — a URL, a username, a hint. */
  hint?: string;
}

const isTTY = (): boolean => !!process.stdin.isTTY && !!process.stdout.isTTY;
const write = (s: string) => process.stdout.write(s);
/** Keep every painted line inside the terminal so a wrap never desyncs the redraw count. */
const fit = (s: string): string => {
  const w = (process.stdout.columns || 80) - 1;
  // Measured on the visible text: escape codes cost columns nothing.
  const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
  return plain.length <= w ? s : plain.slice(0, w - 1) + '…';
};

/**
 * Read single keypresses until `onKey` says it is done. Restores the terminal on every exit
 * path — a raw-mode terminal left behind stops echoing the user's shell, which looks like a
 * hung machine.
 */
function readKeys(onKey: (key: string) => boolean | void): Promise<void> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const restore = () => {
      stdin.off('data', onData);
      stdin.setRawMode?.(!!wasRaw);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      // A single read can carry several keys (fast typing, a paste, an arrow's 3 bytes).
      for (const key of splitKeys(chunk)) {
        if (key === '\x03') { restore(); reject(new Cancelled()); return; }
        let done: boolean | void;
        try { done = onKey(key); } catch (e) { restore(); reject(e); return; }
        if (done) { restore(); resolve(); return; }
      }
    };
    stdin.on('data', onData);
  });
}

/** Split a raw chunk into keys, keeping escape sequences (arrows) whole. */
function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === ESC && chunk[i + 1] === '[') {
      const end = /[A-Za-z~]/.exec(chunk.slice(i + 2));
      if (end) { keys.push(chunk.slice(i, i + 2 + end.index + 1)); i += 2 + end.index; continue; }
    }
    keys.push(chunk[i]);
  }
  return keys;
}

/**
 * The non-TTY line reader: one shared readline, and a queue of the lines it has emitted.
 *
 * Both halves are necessary. A per-question interface would swallow every line that arrived in
 * the same chunk, and rl.question() alone is not enough either — when stdin is a pipe, readline
 * emits ALL the buffered lines and then closes, so anything not being awaited at that instant is
 * lost. Queueing 'line' events keeps a scripted `printf 'a\nb\nc\n' | …` working, which is how
 * the e2e harness drives this.
 */
let sharedRl: readline.Interface | undefined;
const queued: string[] = [];
let waiting: { resolve: (line: string) => void; reject: (e: Error) => void } | undefined;
let inputEnded = false;

/** Release the shared reader so stdin goes back to claude and the process can exit. */
export function closePrompts(): void {
  sharedRl?.close();
  sharedRl = undefined;
  queued.length = 0;
  waiting = undefined;
  inputEnded = false;
}

function ensureReader(): void {
  if (sharedRl) return;
  // No `output`: prompts are written by hand, so readline never echoes or redraws them.
  sharedRl = readline.createInterface({ input: process.stdin });
  sharedRl.on('line', (line) => {
    if (waiting) { const w = waiting; waiting = undefined; w.resolve(line); }
    else queued.push(line);
  });
  const end = () => {
    inputEnded = true;
    if (waiting) { const w = waiting; waiting = undefined; w.reject(new Cancelled()); }
  };
  sharedRl.on('close', end);
  sharedRl.on('SIGINT', () => { closePrompts(); end(); });
}

/** One line, for the non-TTY path. Rejects with Cancelled when the input runs out. */
function readLine(prompt: string): Promise<string> {
  ensureReader();
  write(prompt);
  const buffered = queued.shift();
  if (buffered !== undefined) return Promise.resolve(buffered);
  if (inputEnded) return Promise.reject(new Cancelled());
  return new Promise((resolve, reject) => { waiting = { resolve, reject }; });
}

/**
 * An arrow-key menu. Returns the chosen value.
 * `initial` is the index the cursor starts on — point it at the current setting so pressing
 * Enter is the same as "keep what I have".
 */
export async function select<T>(title: string, choices: Choice<T>[], initial = 0): Promise<T> {
  if (!choices.length) throw new Error('select() needs at least one choice');
  if (!isTTY()) {
    write(`${title}\n`);
    choices.forEach((c, i) => write(`  ${i + 1}) ${c.label}${c.hint ? `  ${c.hint}` : ''}\n`));
    for (;;) {
      const answer = (await readLine(`选择 [1-${choices.length}] (默认 ${initial + 1}): `)).trim();
      if (!answer) return choices[initial].value;
      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value;
      write(red('  请输入列表中的编号\n'));
    }
  }

  let cursor = Math.min(Math.max(initial, 0), choices.length - 1);
  const lines = choices.length + 1; // the title, then one line per choice
  const paint = () => {
    write(fit(`${accent('?')} ${bold(title)}  ${dim('↑↓ 选择 · 回车确认')}`) + '\n');
    choices.forEach((c, i) => {
      const on = i === cursor;
      const row = `${on ? accent('❯') : ' '} ${on ? c.label : dim(c.label)}${c.hint ? `  ${dim(c.hint)}` : ''}`;
      write(fit(row) + '\n');
    });
  };

  write(hideCursor);
  paint();
  try {
    await readKeys((key) => {
      if (key === '\r' || key === '\n') return true;
      if (key === `${CSI}A` || key === 'k') cursor = (cursor - 1 + choices.length) % choices.length;
      else if (key === `${CSI}B` || key === 'j') cursor = (cursor + 1) % choices.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) cursor = Number(key) - 1;
      else return;
      write(up(lines) + clearBelow);
      paint();
    });
  } finally {
    write(showCursor);
  }
  // Collapse the menu to a single line recording what was picked, so a multi-step flow reads
  // as a transcript instead of a wall of spent menus.
  write(up(lines) + clearBelow);
  write(fit(`${accent('✓')} ${title}  ${bold(choices[cursor].label)}`) + '\n');
  return choices[cursor].value;
}

export interface InputOpts {
  /** Echo `*` instead of the characters. */
  hidden?: boolean;
  /** Returned when the user just presses Enter. */
  defaultValue?: string;
  /** Return a message to reject the value and re-ask. */
  validate?: (value: string) => string | undefined;
}

/** A single-line text prompt. `hidden` masks the echo for passwords and tokens. */
export async function input(label: string, opts: InputOpts = {}): Promise<string> {
  const { hidden = false, defaultValue, validate } = opts;
  const suffix = defaultValue ? dim(` (${defaultValue})`) : '';

  for (;;) {
    let value: string;
    if (!isTTY()) {
      // No raw mode: readline echoes the password. Say so rather than pretend it is masked.
      value = (await readLine(`${label}${defaultValue ? ` (${defaultValue})` : ''}: `)).trim();
    } else {
      let buf = '';
      write(fit(`${accent('?')} ${bold(label)}${suffix}: `));
      await readKeys((key) => {
        if (key === '\r' || key === '\n') return true;
        if (key === '\x7f' || key === '\b') {
          if (!buf.length) return;
          buf = buf.slice(0, -1);
          write('\b \b');
          return;
        }
        // Ignore control and escape sequences — an arrow key must not land in a password.
        if (key.length > 1 || key < ' ') return;
        buf += key;
        write(hidden ? '*' : key);
      });
      write('\n');
      value = buf.trim();
    }

    if (!value && defaultValue !== undefined) value = defaultValue;
    const problem = validate?.(value);
    if (!problem) return value;
    write(red(`  ${problem}\n`));
  }
}

/** A yes/no prompt, defaulting to yes. */
export async function confirm(label: string, defaultYes = true): Promise<boolean> {
  return (await select(label, [
    { value: true, label: '是' },
    { value: false, label: '否' },
  ], defaultYes ? 0 : 1));
}

export const note = (s: string) => write(`  ${dim(s)}\n`);
export const fail = (s: string) => write(`  ${red(s)}\n`);
export const heading = (s: string) => write(`\n${bold(s)}\n`);
