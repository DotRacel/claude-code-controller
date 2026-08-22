/**
 * parts.tsx — presentational pieces shared by both platforms.
 *
 * A tool row differs between a phone and a desktop in exactly one way: what opens it. The phone
 * hand-rolls touchstart/long-press/scroll-slop because iOS does not reliably cancel a touch that
 * became a scroll; a desktop wants a click and a hover. Everything inside the button — the name,
 * the headline argument, the ± counts, the one-line result, the images underneath — is identical,
 * and duplicating it would mean two places to fix the next time a tool needs a different summary.
 *
 * So the *body* lives here and each platform supplies its own button around it. The activity line
 * and the connection banner are here for the simpler reason that they are word-for-word the same on
 * a phone and on a desktop — they report what the agent is doing and whether we can reach it, and
 * neither answer changes with the pointer.
 */
import { useEffect, useRef, useState } from 'react';
import type { ToolCall } from '../model.ts';
import type { ImageAttachment } from '../../../src/image-blob.ts';
import type { ItemActions } from './contract.ts';
import { toolDisplayName, toolArg, splitPath, argIsPath, resultLine, byteLabel, imageKindLabel } from '../tools.ts';
import { Picture, WifiOff, Alert } from '../icons.tsx';
import type { Connection } from '../ws.ts';

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

/**
 * One line under the transcript for as long as the agent holds the turn. The glyph is ALWAYS the
 * CLI's star spinner (StarSpinner below — the Anthropic one, kept by explicit request; do not
 * swap it for a plainer dot). What the agent is *actually* doing is the TEXT's job: the open tool
 * with its runtime, 思考中 with a token count, or a bare 运行中 between steps.
 */
export function ActivityLine({ running, thinking, tokens, compacting }: {
  running?: { name: string; arg: string; since: number };
  thinking?: boolean;
  tokens?: number;
  compacting?: boolean;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running?.since]);

  // First, because it is the one state that explains a multi-minute stall: while the worker
  // compacts, no tool is open and the model is not reasoning, so every other branch here would
  // either say nothing useful or describe something that already finished.
  if (compacting) return <div className="activity"><StarSpinner />正在压缩上下文…</div>;
  if (running) {
    const s = Math.max(0, Math.round((Date.now() - running.since) / 1000));
    const dur = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    const arg = running.arg ? ` · ${running.arg.split('\n')[0].slice(0, 40)}` : '';
    return (
      <div className="activity">
        <StarSpinner />
        {`${toolDisplayName(running.name)}${arg} · ${dur}`}
      </div>
    );
  }
  if (thinking) {
    return (
      <div className="activity">
        <StarSpinner />
        {tokens ? `思考中 · ${tokens} tokens` : '思考中'}
      </div>
    );
  }
  // Working, but neither reasoning nor inside a tool — streaming prose, or between steps.
  return <div className="activity"><StarSpinner />运行中</div>;
}

/** The CLI's own activity glyph: it grows to a full star and shrinks back, one frame at a time. */
const FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];
const SPINNER_MS = 120;

function StarSpinner() {
  const [i, setI] = useState(0);
  const dir = useRef(1);

  useEffect(() => {
    // 0c: reduce-motion freezes every animation, and this one is driven by JS, so the media query
    // in the stylesheet cannot reach it.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => {
      setI((prev) => {
        if (prev === FRAMES.length - 1) dir.current = -1;
        if (prev === 0) dir.current = 1;
        return prev + dir.current;
      });
    }, SPINNER_MS);
    return () => clearInterval(t);
  }, []);

  return <span className="spin" aria-hidden="true">{FRAMES[i]}</span>;
}

export function Banner({ connection, sessionOffline, machine, onRetry }: {
  connection: Connection; sessionOffline: boolean; machine?: string; onRetry: () => void;
}) {
  if (connection === 'connecting') {
    return (
      <div className="banner warning">
        <span className="spinner" />
        <div className="banner-text">
          <div className="t1">重新连接中…</div>
          <div className="t2">会话仍在 {machine || '你的机器'} 上继续运行</div>
        </div>
      </div>
    );
  }
  if (connection === 'offline') {
    return (
      <div className="banner danger">
        <WifiOff size={15} stroke="#e07a5f" />
        <div className="banner-text">
          <div className="t1">已离线</div>
          <div className="t2">恢复连接后会自动继续</div>
        </div>
        <button className="link" style={{ color: 'var(--text)' }} onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (sessionOffline) {
    return (
      <div className="banner neutral">
        <Alert size={15} stroke="#8a8781" />
        <div className="banner-text">
          <div className="t1">{machine || '这台机器'} 上的 claude 没有连着</div>
          <div className="t2">转录仍在，回到终端继续会话即可恢复</div>
        </div>
      </div>
    );
  }
  return null;
}
