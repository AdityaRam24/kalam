import { describe, it, expect } from 'vitest';
import { applyChunk, emptyTerm, stripAnsi, termText, MAX_LINES } from '../terminal';

const render = (...chunks: string[]) => termText(chunks.reduce(applyChunk, emptyTerm()));

describe('stripAnsi', () => {
  it('removes colour and cursor escapes', () => {
    expect(stripAnsi('\x1b[32mok\x1b[0m')).toBe('ok');
    expect(stripAnsi('\x1b[2J\x1b[Hcleared')).toBe('cleared');
  });

  it('removes window-title (OSC) sequences', () => {
    expect(stripAnsi('\x1b]0;user@host\x07$ ')).toBe('$ ');
  });
});

describe('applyChunk', () => {
  it('keeps plain multi-line output intact', () => {
    expect(render('one\ntwo\n')).toBe('one\ntwo\n');
  });

  it('lets a carriage return rewrite the current line, like a progress bar', () => {
    // What `docker pull` and friends emit; naive concatenation showed both.
    expect(render('Downloading 10%\rDownloading 99%')).toBe('Downloading 99%');
  });

  it('does not truncate when the rewrite is shorter than what it replaces', () => {
    expect(render('abcdef\rxy')).toBe('xycdef');
  });

  it('applies backspace the way a shell does when erasing a typo', () => {
    expect(render('kubectl gett\b\b p')).toBe('kubectl ge p');
  });

  it('handles output split across chunks mid-line', () => {
    expect(render('total ', '5 files\n')).toBe('total 5 files\n');
  });

  it('expands tabs to 8-column stops so columns line up', () => {
    expect(render('a\tb')).toBe('a       b');
  });

  it('drops stray control characters instead of printing them', () => {
    expect(render('ok\x00\x07!')).toBe('ok!');
  });

  it('caps scrollback so a chatty command cannot grow without bound', () => {
    const state = applyChunk(emptyTerm(), 'x\n'.repeat(MAX_LINES + 500));
    expect(state.lines.length).toBeLessThanOrEqual(MAX_LINES);
  });
});
