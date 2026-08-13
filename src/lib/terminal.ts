// Minimal terminal screen model for the remote shell view.
//
// The backend streams raw PTY output, which is not plain text: it carries ANSI
// colour/cursor escapes, carriage returns that rewrite the current line (every
// progress bar, `apt`, `docker pull`), and backspaces. Dumping that into a
// <pre> produced the garbled output that made remote commands look broken, so
// the bytes are interpreted here instead.
//
// This is deliberately a line-oriented model, not a full VT100: the cursor only
// ever moves within the last line. That covers shells, prompts, logs and
// progress bars — the things people actually run here — without pulling in a
// terminal emulator dependency.

export interface TermState {
  lines: string[];
  col: number; // cursor column within the last line
}

export const MAX_LINES = 3000;

export function emptyTerm(): TermState {
  return { lines: [''], col: 0 };
}

// ANSI CSI sequences (colour, cursor moves), OSC sequences (window title) and
// single-char escapes. Stripped rather than rendered — colour is not worth a
// full emulator here.
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESC = /\x1b[()#][0-9A-Za-z]|\x1b[=>NOM78]/g;

export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(OTHER_ESC, '');
}

// Apply a chunk of PTY output to the screen. Pure: returns a new state.
export function applyChunk(prev: TermState, chunk: string): TermState {
  const lines = prev.lines.slice();
  let col = prev.col;
  const clean = stripAnsi(chunk);

  const write = (ch: string) => {
    const i = lines.length - 1;
    const line = lines[i];
    // Overwrite at the cursor (what \r-based progress bars rely on), or append.
    lines[i] = col < line.length ? line.slice(0, col) + ch + line.slice(col + 1) : line + ch;
    col++;
  };

  for (const ch of clean) {
    switch (ch) {
      case '\n':
        lines.push('');
        col = 0;
        break;
      case '\r':
        col = 0; // next characters rewrite the current line
        break;
      case '\b':
        col = Math.max(0, col - 1);
        break;
      case '\x07': // bell
        break;
      case '\t':
        // Tabs land on 8-column stops, like a real terminal.
        do { write(' '); } while (col % 8 !== 0);
        break;
      default:
        // Drop remaining control characters; keep everything printable.
        if (ch >= ' ' && ch.charCodeAt(0) !== 127) write(ch);
    }
  }

  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  return { lines, col };
}

export function termText(state: TermState): string {
  return state.lines.join('\n');
}
