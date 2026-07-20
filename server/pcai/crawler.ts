// Lightweight crawler for public HPE PCAI documentation.
// Plain fetch + HTML->text (no headless browser). Static docs sites
// (docs.ai-solutions.ext.hpe.com, hpe-mlde.determined.ai) yield good text.
// JS-heavy SPA pages may return sparse text — that's fine, the curated seed
// knowledge covers the essentials.

import { CRAWL_ALLOWED_HOSTS } from './sources.js';

const UA =
  'Mozilla/5.0 (compatible; KalamPCAI/1.0; +https://developer.hpe.com/platform/hpe-private-cloud-ai/)';

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&rsquo;/g, "'");
}

export function htmlToText(html: string): { title: string; text: string; links: string[] } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  // Collect same-doc links before we strip tags.
  const links: string[] = [];
  const linkRe = /href\s*=\s*["']([^"'#]+)["']/gi;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(html)) !== null) links.push(lm[1]);

  let body = html;
  // Prefer <main>/<article> content when present.
  const mainMatch =
    body.match(/<main[\s\S]*?<\/main>/i) || body.match(/<article[\s\S]*?<\/article>/i);
  if (mainMatch) body = mainMatch[0];

  const text = decodeEntities(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(\s*\n\s*){2,}/g, '\n\n')
    .trim();

  return { title, text, links };
}

async function fetchOne(url: string, timeoutMs = 15000): Promise<FetchedPage | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const html = await resp.text();
    const { title, text } = htmlToText(html);
    // Ignore pages that returned almost no real text (SPA shells).
    if (text.replace(/\s/g, '').length < 200) return null;
    return { url, title: title || url, text };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sameHostAllowed(url: string): boolean {
  try {
    const h = new URL(url).host;
    return CRAWL_ALLOWED_HOSTS.includes(h);
  } catch {
    return false;
  }
}

function absolutize(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString().split('#')[0];
  } catch {
    return null;
  }
}

// Crawl the given seed URLs, optionally following same-site links up to
// `maxPages` total. Returns fetched pages. `onProgress` reports each page.
export async function crawl(
  seeds: string[],
  maxPages = 40,
  onProgress?: (msg: string) => void
): Promise<FetchedPage[]> {
  const queue = [...seeds];
  const seen = new Set<string>();
  const pages: FetchedPage[] = [];

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    const norm = url.split('#')[0];
    if (seen.has(norm)) continue;
    seen.add(norm);

    onProgress?.(`Fetching ${norm}`);
    // Re-fetch to also get links for same-site expansion.
    let html = '';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(norm, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok && (resp.headers.get('content-type') || '').includes('text/html')) {
        html = await resp.text();
      }
    } catch {
      /* skip */
    }

    if (html) {
      const { title, text, links } = htmlToText(html);
      if (text.replace(/\s/g, '').length >= 200) {
        pages.push({ url: norm, title: title || norm, text });
        onProgress?.(`  + captured "${title || norm}" (${text.length} chars)`);
      }
      // Expand within allowed hosts only.
      if (sameHostAllowed(norm)) {
        for (const href of links.slice(0, 60)) {
          const abs = absolutize(norm, href);
          if (abs && sameHostAllowed(abs) && !seen.has(abs) && queue.length + pages.length < maxPages * 2) {
            queue.push(abs);
          }
        }
      }
    } else {
      onProgress?.(`  ! no HTML/empty for ${norm}`);
    }
  }

  return pages;
}
