/**
 * contract.ts — the rule that every `Item` kind must have a renderer, expressed as a type.
 *
 * The reducer's `Item` union (web/src/model.ts) is a closed set, but nothing used to hold the view
 * layer to it: `ItemView` was a `switch` whose return type is inferred, so a missing `case` fell
 * through to `undefined` — which is a legal ReactNode. A new kind therefore compiled, passed every
 * test, and rendered nothing. That is not hypothetical: `divider` shipped that way, reducer and CSS
 * and all, and a disconnected session simply showed no break where one belonged.
 *
 * `ItemRenderers` is a mapped type over `Item['kind']`, so a missing key is a compile error at the
 * place that claims to render items. There is one implementation today (render/phone.tsx). When a
 * desktop layout arrives it is a second object of the same type — and adding a kind then fails to
 * compile in BOTH files at once, which is the whole point: no platform can quietly fall behind.
 *
 * What deliberately is NOT here: how anything looks. A phone opens a tool's output in a bottom
 * sheet after a long-press; a desktop would use a side panel and a hover affordance. Those are
 * real differences and they belong in the per-platform file. Only the SET of items, and the
 * actions the shell offers, are shared.
 */
import type { ComponentType } from 'react';
import type { Item, ToolCall } from '../model.ts';
import type { ImageAttachment } from '../../../src/image-blob.ts';

/**
 * What a renderer can ask the shell to do. Actions and resolvers only — never "open this sheet",
 * because a sheet is a phone answer to "show me the output" and the desktop's answer differs.
 */
export interface ItemActions {
  /** Show a tool call's raw output, however this platform shows things. */
  onOpenOutput: (call: ToolCall) => void;
  onAnswerQuestion: (item: Extract<Item, { kind: 'question' }>, answers: Record<string, string>, freeform?: string) => void;
  /**
   * Where to load a tool's image from — injected because only the view knows the session id, and
   * because it keeps the components free of the base64-vs-reference distinction. Returns
   * undefined when an attachment cannot be resolved at all.
   */
  imageUrl: (att: ImageAttachment) => string | undefined;
}

/** Props every item renderer receives, narrowed to its own kind. */
export interface ItemProps<K extends Item['kind']> {
  it: Extract<Item, { kind: K }>;
  /** Only the newest item animates in; earlier ones must not re-animate on re-render (0c). */
  isLast: boolean;
  h: ItemActions;
}

/**
 * One renderer per kind. Mapped over `Item['kind']`, so this is the type that fails to compile
 * when the reducer learns to produce something the view cannot draw.
 */
export type ItemRenderers = { [K in Item['kind']]: ComponentType<ItemProps<K>> };

/** The animation class, shared by every renderer so the rule lives in one place. */
export const enterClass = (isLast: boolean): string | undefined => (isLast ? 'enter' : undefined);
