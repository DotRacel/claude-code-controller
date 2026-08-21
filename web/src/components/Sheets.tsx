/**
 * Sheets.tsx — the phone's answer to every modal surface: a bottom sheet (1d / 1e / 1h).
 *
 * The contents live in render/surface-parts.tsx, shared with the desktop's modals; all this file
 * decides is that on a phone they arrive from the bottom edge with a drag handle. Sheet.tsx owns
 * the dismissal rule, and for a permission that dismissal is a DENY — never an allow, and never a
 * silent close, or the worker waits on an answer that is not coming.
 */
import { Sheet } from './Sheet.tsx';
import type { PermissionRequest, ToolCall } from '../model.ts';
import type { PermissionAnswer } from '../ws.ts';
import { PermissionBody, OutputBody, MenuBody, HelpBody, ConfirmBody } from '../render/surface-parts.tsx';

export function PermissionSheet({ req, cwd, onAnswer, onDismiss }: {
  req: PermissionRequest;
  cwd?: string;
  onAnswer: (a: PermissionAnswer) => void;
  onDismiss: () => void;
}) {
  return (
    <Sheet onDismiss={onDismiss}>
      <PermissionBody req={req} cwd={cwd} onAnswer={onAnswer} />
    </Sheet>
  );
}

export function OutputSheet({ call, onDismiss }: { call: ToolCall; onDismiss: () => void }) {
  return (
    <Sheet onDismiss={onDismiss} height="78%">
      <OutputBody call={call} />
    </Sheet>
  );
}

export function MenuSheet({ meta, mode, onMode, onEnd, onDismiss }: {
  meta: string;
  mode?: string;
  onMode: (m: string) => void;
  onEnd: () => void;
  onDismiss: () => void;
}) {
  return (
    <Sheet onDismiss={onDismiss}>
      <MenuBody meta={meta} mode={mode} onMode={onMode} onEnd={onEnd} onDismiss={onDismiss} />
    </Sheet>
  );
}

export function HelpSheet({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Sheet onDismiss={onDismiss} height="82%">
      <HelpBody />
    </Sheet>
  );
}

export function ConfirmSheet({ title, body, confirmLabel, onConfirm, onDismiss }: {
  title: string;
  body?: string;
  confirmLabel: string;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  return (
    <Sheet onDismiss={onDismiss}>
      <ConfirmBody title={title} body={body} confirmLabel={confirmLabel} onConfirm={onConfirm} onDismiss={onDismiss} />
    </Sheet>
  );
}
