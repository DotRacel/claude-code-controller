/**
 * image-blob.ts — keeping base64 image data out of the transcript stream.
 *
 * A `Read` of a screenshot comes back as a `tool_result` whose content is
 * `[{type:'image', source:{type:'base64', media_type, data}}]`, and one such image is ~300–600 KB
 * of base64. They are stored verbatim (the payload is the wire record, and an export with
 * `--full` still has to reproduce the real image), but neither the history backfill nor the live
 * relay may push them at a phone: a single reopened session measured 14.7 MB of base64 across
 * 39 images, all of it to render a thumbnail.
 *
 * So the server rewrites the blob into a reference on the way out, and the web fetches the bytes
 * from `/api/blob` only when the reader taps the image. The reference is
 * `<payload uuid>:<n>` — n counting image blocks within that one payload — because every payload
 * carries a unique `uuid` (verified across a real 6298-event history: 6298 uuids, no duplicates).
 * That needs no new table and no migration: stripping happens on read, so history already in the
 * database gets it for free.
 *
 * A payload carries the image TWICE: once as an API-shaped content block, and once in
 * `tool_use_result` — Claude's own record of the call, which no client here reads (verified: no
 * reference to it anywhere in src/ or web/src). Stripping only the block would still ship a full
 * copy of every screenshot, so both go.
 *
 * Shared by the server (store.historyFor, the live relay, the blob route) and the web (model.ts
 * reads the reference, Transcript.tsx renders it).
 */

/** What replaces `source` once the bytes are gone. `type` is deliberately not 'base64'. */
export interface BlobRefSource {
  type: 'blob_ref';
  media_type?: string;
  /** Decoded size, so the card can say "310 KB" without holding the data. */
  bytes: number;
  /** `<uuid>:<n>`, resolvable through resolveImageBlob() against the stored payload. */
  ref: string;
}

/** Decoded byte length of a base64 string, padding accounted for. */
export function base64Bytes(data: string): number {
  const len = data.length;
  if (!len) return 0;
  const pad = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

/** Ids we are willing to put in a URL and a query parameter. Covers a UUID; excludes ':'. */
const REF_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isImageBlock = (b: any): boolean => b?.type === 'image' && b.source && typeof b.source === 'object';

/** Content blocks of a payload's message, or null when there is nothing to walk. */
function contentOf(payload: any): any[] | null {
  const c = payload?.message?.content;
  return Array.isArray(c) ? c : null;
}

/**
 * Walk every image block of a payload in a stable order, so the server and the web agree on what
 * `:<n>` refers to. Order is content-block order, then inner order inside each `tool_result`.
 */
function eachImage(payload: any, fn: (block: any, index: number, holder: any[], at: number) => void): void {
  const content = contentOf(payload);
  if (!content) return;
  let n = 0;
  for (const block of content) {
    if (isImageBlock(block)) {
      fn(block, n++, content, content.indexOf(block));
      continue;
    }
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) continue;
    for (let i = 0; i < block.content.length; i++) {
      const inner = block.content[i];
      if (isImageBlock(inner)) fn(inner, n++, block.content, i);
    }
  }
}

/** Does this payload carry base64 image data? Cheap pre-check so the common case copies nothing. */
export function hasImageBlobs(payload: unknown): boolean {
  let found = false;
  eachImage(payload, (b) => {
    if (b.source?.type === 'base64' && typeof b.source.data === 'string') found = true;
  });
  return found;
}

/**
 * Replace every base64 image blob with a reference. Returns the payload unchanged (same object)
 * when there is nothing to strip, and otherwise copies only the path down to each image block —
 * a transcript event is relayed to every subscriber, so a blind deep clone would be worse than
 * the problem.
 */
export function stripImageBlobs(payload: any): any {
  return stripResultImageCopy(stripContentImageBlobs(payload));
}

/** Placeholder left where bytes were removed — says what happened and where to get them. */
export const WITHHELD = '<withheld: GET /v1/blob>';

/**
 * The duplicate image inside `tool_use_result.file.base64`. It is not referenced by anything the
 * web renders (the card loads the block's `ref` instead), so the bytes are simply dropped rather
 * than given a reference of their own.
 */
function stripResultImageCopy(payload: any): any {
  const file = payload?.tool_use_result?.file;
  if (!file || typeof file !== 'object' || typeof file.base64 !== 'string' || !file.base64) return payload;
  return {
    ...payload,
    tool_use_result: { ...payload.tool_use_result, file: { ...file, base64: WITHHELD } },
  };
}

function stripContentImageBlobs(payload: any): any {
  if (!hasImageBlobs(payload)) return payload;
  // No uuid means no resolvable reference, and a reference that cannot be fetched is worse than
  // the bytes it saved — the image would simply never render. Relay it verbatim instead.
  const uuid = typeof payload?.uuid === 'string' ? payload.uuid : '';
  if (!REF_ID.test(uuid)) return payload;
  const content = contentOf(payload)!;

  const rewriteBlock = (block: any, index: number): any => {
    const src = block.source;
    if (src?.type !== 'base64' || typeof src.data !== 'string') return block;
    const source: BlobRefSource = {
      type: 'blob_ref',
      ...(typeof src.media_type === 'string' ? { media_type: src.media_type } : {}),
      bytes: base64Bytes(src.data),
      ref: `${uuid}:${index}`,
    };
    return { ...block, source };
  };

  // Numbering must match eachImage(), so count in the same order rather than per container.
  let n = 0;
  const nextContent = content.map((block: any) => {
    if (isImageBlock(block)) return rewriteBlock(block, n++);
    if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return block;
    if (!block.content.some(isImageBlock)) return block;
    return { ...block, content: block.content.map((inner: any) => (isImageBlock(inner) ? rewriteBlock(inner, n++) : inner)) };
  });

  return { ...payload, message: { ...payload.message, content: nextContent } };
}

export interface ResolvedBlob { data: string; mediaType: string }

/** Pull the bytes back out of a stored payload for the blob route. `index` is the `:<n>` half. */
export function resolveImageBlob(payload: unknown, index: number): ResolvedBlob | null {
  let hit: ResolvedBlob | null = null;
  eachImage(payload, (block, i) => {
    if (i !== index || hit) return;
    const src = block.source;
    if (src?.type !== 'base64' || typeof src.data !== 'string') return;
    hit = { data: src.data, mediaType: typeof src.media_type === 'string' ? src.media_type : 'application/octet-stream' };
  });
  return hit;
}

/**
 * `<uuid>:<n>` → its parts. Rejects anything else: the id half reaches a query and the URL, so
 * it is held to URL-safe characters rather than trusted. The same test gates ref *generation*,
 * so the two halves can never disagree about what is representable.
 */
export function parseBlobRef(ref: unknown): { uuid: string; index: number } | null {
  if (typeof ref !== 'string') return null;
  const at = ref.lastIndexOf(':');
  if (at <= 0) return null;
  const uuid = ref.slice(0, at);
  const n = ref.slice(at + 1);
  if (!REF_ID.test(uuid) || !/^\d{1,4}$/.test(n)) return null;
  return { uuid, index: Number(n) };
}

/** Image attachments of a `tool_result`, as the web needs them (bytes already gone). */
export interface ImageAttachment { ref?: string; mediaType?: string; bytes?: number; dataUrl?: string }

/**
 * Read the image blocks of one `tool_result` block. Handles both shapes on purpose: a stripped
 * reference (the normal path) and raw base64 (a server that did not strip, or a fixture), so the
 * web renders an image either way.
 */
export function imageAttachmentsOf(toolResult: any): ImageAttachment[] {
  const inner = Array.isArray(toolResult?.content) ? toolResult.content : null;
  if (!inner) return [];
  const out: ImageAttachment[] = [];
  for (const b of inner) {
    if (!isImageBlock(b)) continue;
    const src = b.source;
    if (src.type === 'blob_ref' && typeof src.ref === 'string') {
      out.push({ ref: src.ref, mediaType: src.media_type, bytes: typeof src.bytes === 'number' ? src.bytes : undefined });
    } else if (src.type === 'base64' && typeof src.data === 'string') {
      out.push({ mediaType: src.media_type, bytes: base64Bytes(src.data), dataUrl: `data:${src.media_type ?? 'image/png'};base64,${src.data}` });
    }
  }
  return out;
}

/** Text content of a `tool_result`, ignoring non-text blocks (which render as attachments). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  const parts: string[] = [];
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b?.type === 'image') continue; // rendered as an attachment
    else if (b != null) parts.push(JSON.stringify(b));
  }
  return parts.join('\n');
}
