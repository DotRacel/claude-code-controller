/**
 * Transcript helpers for the phone UI.
 *
 * Live `user` events are worker echoes of every keyboard turn — web-sent and
 * terminal-typed alike. Web submits are inserted optimistically, so their
 * echo must be dropped; terminal-typed turns must be shown.
 */

/** Strip synthetic user-message content official clients hide. null = render nothing. */
export function cleanUserText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (/^\s*<(local-command-caveat|command-name|command-message|command-args|command-contents|local-command-stdout|command-stdout|bash-stdout|bash-stderr|bash-input)\b/.test(raw)) return null;
  const s = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return s || null;
}

export function userTextsFrom(payload: any): string[] {
  if (!payload || payload.isMeta || payload.isCompactSummary) return [];
  const content = payload.message?.content;
  const out: string[] = [];
  if (typeof content === 'string') {
    const t = cleanUserText(content);
    if (t) out.push(t);
  } else if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'text') {
        const t = cleanUserText(b.text);
        if (t) out.push(t);
      }
    }
  }
  return out;
}

/**
 * Decide which user texts to append.
 * Live echoes that match a pending web-sent string are consumed (already on screen).
 * Everything else — history, and live terminal turns — is returned to render.
 */
export function takeVisibleUserTexts(payload: any, pendingWeb: string[], isHistory: boolean): { texts: string[]; pendingWeb: string[] } {
  const next = pendingWeb.slice();
  const texts: string[] = [];
  for (const t of userTextsFrom(payload)) {
    if (!isHistory) {
      const i = next.indexOf(t);
      if (i >= 0) { next.splice(i, 1); continue; }
    }
    texts.push(t);
  }
  return { texts, pendingWeb: next };
}
