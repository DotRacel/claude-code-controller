/**
 * md.ts — the small markdown subset Claude actually emits, rendered to React nodes.
 *
 * No dependency and no `innerHTML`: everything becomes createElement calls, so a model that
 * writes `<img onerror=…>` produces text, not markup. The design doc draws assistant output as
 * plain prose, but real transcripts are full of fenced code, lists and bold — unrendered they
 * read worse than rendered.
 *
 * Supported: fenced code, ATX headings (#..###), thematic breaks, blockquotes, ordered and
 * unordered lists (one nesting level), paragraphs; inline code, bold, italic, links.
 * Anything else falls through as literal text, which is the correct failure mode here.
 */
import { createElement as h, type ReactNode } from 'react';
import { useCopy } from './clipboard.ts';

/** Code blocks get a copy button: selecting monospace text by touch is miserable. */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const { label, failed, copy } = useCopy(code);
  return h('div', { className: 'md-pre', 'data-lang': lang || undefined },
    h('button', { className: `md-copy${failed ? ' fail' : ''}`, type: 'button', onClick: copy }, label),
    h('pre', null, h('code', null, code)),
  );
}

// ── inline ──
// Alternation order matters: code first (so ** inside a span is literal), then ** before *.
const INLINE = /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+)\*|_([^_\n]+)_|\[([^\]\n]*)\]\(([^)\s]+)\)/g;

function inline(src: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(src); m; m = INLINE.exec(src)) {
    if (m.index > last) out.push(src.slice(last, m.index));
    const key = `${keyBase}i${n++}`;
    if (m[2] !== undefined) out.push(h('code', { key }, m[2]));
    else if (m[3] !== undefined) out.push(h('strong', { key }, m[3]));
    else if (m[4] !== undefined) out.push(h('strong', { key }, m[4]));
    else if (m[5] !== undefined) out.push(h('em', { key }, m[5]));
    else if (m[6] !== undefined) out.push(h('em', { key }, m[6]));
    else if (m[8] !== undefined) {
      const href = m[8];
      // Only protocols that cannot execute script.
      const safe = /^(https?:|mailto:)/i.test(href);
      out.push(safe
        ? h('a', { key, href, target: '_blank', rel: 'noreferrer noopener' }, m[7] || href)
        : `${m[7] || ''}(${href})`);
    }
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

// ── blocks ──
const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/;
const HR = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;

interface ListItem { text: string; nested: string[] }

export function renderMarkdown(src: string): ReactNode {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;

  const flushParagraph = (buf: string[]) => {
    if (!buf.length) return;
    const text = buf.join('\n').trim();
    if (text) out.push(h('p', { key: `p${k++}` }, ...inline(text, `p${k}`)));
    buf.length = 0;
  };

  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph(para);
      const marker = fence[1][0];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${marker === '`' ? '```' : '~~~'}+\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push(h(CodeBlock, { key: `c${k++}`, code: body.join('\n'), lang: fence[2] }));
      continue;
    }
    const head = HEADING.exec(line);
    if (head) {
      flushParagraph(para);
      out.push(h(`h${head[1].length}` as 'h1', { key: `h${k++}` }, ...inline(head[2].trim(), `h${k}`)));
      i++;
      continue;
    }
    if (HR.test(line)) {
      flushParagraph(para);
      out.push(h('hr', { key: `r${k++}` }));
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      flushParagraph(para);
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      out.push(h('blockquote', { key: `q${k++}` }, ...inline(body.join('\n').trim(), `q${k}`)));
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph(para);
      const tag = ordered ? 'ol' : 'ul';
      const items: ListItem[] = [];
      const baseIndent = (bullet ?? ordered)![1].length;
      while (i < lines.length) {
        const b = BULLET.exec(lines[i]);
        const o = ORDERED.exec(lines[i]);
        const m = ordered ? (o ?? b) : (b ?? o);
        if (!m) break;
        const indent = m[1].length;
        if (indent > baseIndent && items.length) items[items.length - 1].nested.push(m[3]);
        else if (indent < baseIndent) break;
        else items.push({ text: m[3], nested: [] });
        i++;
      }
      out.push(h(tag, { key: `l${k++}` }, ...items.map((it, n) => h('li', { key: n },
        ...inline(it.text, `l${k}n${n}`),
        ...(it.nested.length ? [h('ul', { key: 'n' }, ...it.nested.map((t, j) => h('li', { key: j }, ...inline(t, `l${k}n${n}s${j}`))))] : []),
      ))));
      continue;
    }
    if (!line.trim()) { flushParagraph(para); i++; continue; }
    para.push(line);
    i++;
  }
  flushParagraph(para);
  return out.length ? out : src;
}
