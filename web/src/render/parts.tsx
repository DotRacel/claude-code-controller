/**
 * parts.tsx — the pieces of a tool card that carry no interaction, shared by both platforms.
 *
 * A tool row differs between a phone and a desktop in exactly one way: what opens it. The phone
 * hand-rolls touchstart/long-press/scroll-slop because iOS does not reliably cancel a touch that
 * became a scroll; a desktop wants a click and a hover. Everything inside the button — the name,
 * the headline argument, the ± counts, the one-line result, the images underneath — is identical,
 * and duplicating it would mean two places to fix the next time a tool needs a different summary.
 *
 * So the *body* lives here and each platform supplies its own button around it.
 */
import { useState } from 'react';
import type { ToolCall } from '../model.ts';
import type { ImageAttachment } from '../../../src/image-blob.ts';
import type { ItemActions } from './contract.ts';
import { toolDisplayName, toolArg, splitPath, argIsPath, resultLine, byteLabel, imageKindLabel } from '../tools.ts';
import { Picture } from '../icons.tsx';

/** `src/routes/checkout/` dim + `handler.ts` bright — the filename is what you scan for. */
export function PathArg({ p }: { p: string }) {
  const { dir, base } = splitPath(p);
  return <>{dir && <span className="dim">{dir}</span>}{base}</>;
}

/** One element to a screen reader: "Bash, npm test, failed, double-tap to see the output". */
export function toolRowLabel(call: ToolCall, openable: boolean, openHint: string): string {
  const label = toolDisplayName(call.name);
  const arg = toolArg(call.name, call.input);
  const res = resultLine(call);
  return `${label}${arg ? `, ${arg}` : ''}, ${res?.text ?? ''}${openable ? openHint : ''}`;
}

/** Everything inside a tool row's button. */
export function ToolRowBody({ call }: { call: ToolCall }) {
  const label = toolDisplayName(call.name);
  const arg = toolArg(call.name, call.input);
  const res = resultLine(call);
  return (
    <>
      <div className="tool-head">
        {label} {arg && <span className="arg">{argIsPath(call.name) ? <PathArg p={arg} /> : arg}</span>}
        {/* an Edit's counts ride along with the path instead of taking a line of their own. The
            separating space is outside .delta so a long path can still push the pair onto the next
            line rather than overflowing (.delta itself never breaks). */}
        {res?.delta && <>{' '}<span className="delta"><span className="add">+{res.delta.add}</span> <span className="del">−{res.delta.del}</span></span></>}
      </div>
      {res && !res.delta && (
        <div className={`tool-result-line${res.isError ? ' err' : ''}`}>{res.text}</div>
      )}
    </>
  );
}

/**
 * Images a tool returned. They are NOT loaded with the transcript: the server replaced the base64
 * with a reference (src/image-blob.ts), so this renders a placeholder and fetches the bytes only
 * when tapped. An attachment that already carries its data (an unstripped payload, a fixture)
 * shows immediately — there is nothing left to save by hiding it.
 */
export function ImageStrip({ images, h }: { images: ImageAttachment[]; h: ItemActions }) {
  return (
    <div className="tool-images">
      {images.map((att, i) => <ImageAttachmentView key={att.ref ?? i} att={att} url={h.imageUrl(att)} />)}
    </div>
  );
}

function ImageAttachmentView({ att, url }: { att: ImageAttachment; url: string | undefined }) {
  // Data already in hand renders straight away; a reference waits for a tap.
  const [show, setShow] = useState(!!att.dataUrl);
  const [failed, setFailed] = useState(false);
  const kind = imageKindLabel(att.mediaType);
  const size = byteLabel(att.bytes);
  const caption = [kind, size].filter(Boolean).join(' · ');

  if (!url) return <div className="img-att gone">图片已不可用</div>;
  if (failed) return <div className="img-att gone">图片加载失败 · {caption}</div>;
  if (!show) {
    return (
      <button className="img-att" onClick={() => setShow(true)} aria-label={`加载图片，${caption}`}>
        {/* An SVG, not an emoji: the self-hosted fonts carry no emoji glyphs, so 🖼 renders as
            tofu wherever the system font does not supply one. */}
        <span className="img-icon" aria-hidden="true"><Picture size={14} /></span>
        <span className="img-meta">{caption}</span>
        <span className="img-cta">点击加载</span>
      </button>
    );
  }
  // A new tab is the image viewer: pinch-zoom, save, and full resolution come for free.
  return (
    <a className="img-att-shown" href={url} target="_blank" rel="noreferrer">
      <img src={url} alt={`工具返回的图片 · ${caption}`} onError={() => setFailed(true)} />
    </a>
  );
}
