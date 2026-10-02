// Screenshots of Kalam itself — "capture the current state" as an image.
//
// html-to-image clones the DOM into an SVG foreignObject and rasterises it, so
// it captures exactly what Kalam drew (including the React Flow canvas) with
// no screen-share prompt. Two limits are handled here rather than left to fail
// silently: browsers cap canvas size (a long page at 2x can exceed it and come
// back blank), and cross-origin web-font CSS can make the font-embedding step
// throw — in which case the capture is retried without embedding fonts.

import { stamp } from './health';

/** Largest canvas side / area browsers reliably allocate. */
const MAX_SIDE = 16000;
const MAX_AREA = 240_000_000;

export function safePixelRatio(w: number, h: number, wanted = 2): number {
  if (w <= 0 || h <= 0) return 1;
  const bySide = MAX_SIDE / Math.max(w, h);
  const byArea = Math.sqrt(MAX_AREA / (w * h));
  return Math.max(0.25, Math.min(wanted, bySide, byArea));
}

function pageBackground(): string {
  const bg = getComputedStyle(document.body).backgroundColor;
  return bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' ? bg : (document.documentElement.dataset.theme === 'dark' ? '#0a0d12' : '#ffffff');
}

/** Skip anything marked as UI chrome that should not appear in a capture. */
const keep = (node: HTMLElement) => !(node instanceof HTMLElement && node.dataset?.captureIgnore !== undefined);

export async function captureElement(
  el: HTMLElement,
  opts: { fullHeight?: boolean; background?: string } = {},
): Promise<string> {
  const width = opts.fullHeight ? el.scrollWidth : el.clientWidth;
  const height = opts.fullHeight ? el.scrollHeight : el.clientHeight;
  const base = {
    backgroundColor: opts.background || pageBackground(),
    pixelRatio: safePixelRatio(width, height),
    width,
    height,
    cacheBust: true,
    filter: keep,
    // Unroll a scrolling container so everything below the fold is included.
    style: opts.fullHeight ? { height: `${height}px`, maxHeight: 'none', overflow: 'visible' } : undefined,
  };
  // Loaded on first use: nobody should download the capture library just to
  // open the dashboard.
  const { toPng } = await import('html-to-image');
  try {
    return await toPng(el, base);
  } catch {
    return await toPng(el, { ...base, skipFonts: true });
  }
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const captureName = (what: string, ext = 'png') =>
  `kalam-${what.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'capture'}-${stamp()}.${ext}`;
