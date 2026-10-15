// What a pane can show, described once per kind.
//
// A pane is a slot in the split tree; what fills it is its kind. Everything the
// core does with a pane that depends on that content — name it, save it, bring
// it back, draw it, give it the keyboard, end it — is asked of the kind's
// descriptor here instead of tested with `kind === ...` across the store,
// the snapshot, the transfer and Pane. A new kind is one descriptor, and any
// pane can be handed any content at any moment (tabs.setPaneContent).
//
// Browser panes are the first kind described here. Terminals and the file
// viewers still go through their own branches, and move over one at a time.
// The registry is internal: plugins don't register kinds of their own.

import type { Component } from "solid-js";
import type { PaneId, PaneType, SnapshotPane } from "../types";
import BrowserPane from "../components/BrowserPane";
import { browserTitle, disposeBrowser, focusBrowser } from "./browser-registry";

type Kind = PaneType["kind"];
type PaneOf<K extends Kind> = Extract<PaneType, { kind: K }>;
type SavedOf<K extends Kind> = Extract<SnapshotPane, { kind: K }>;

export interface PaneViewProps<K extends Kind = Kind> {
  paneId: PaneId;
  pane: PaneOf<K>;
  isActive: boolean;
  /** The content took the keyboard: its pane should become the active one. */
  onFocus: () => void;
  /** The content named itself (a page title); the pane and its tab follow. */
  onTitle: (title: string) => void;
  /** The content moved on by itself (a page navigated): keep the tree in step. */
  onContent: (pane: PaneOf<K>) => void;
}

export interface PaneKind<K extends Kind = Kind> {
  /** What the pane and its tab are called until the content names itself. */
  title(paneId: PaneId, pane: PaneOf<K>): string;
  /** The pane as a saved session, the closed stack and a move to another window keep it. */
  snapshot(paneId: PaneId, pane: PaneOf<K>): SavedOf<K>;
  /** Whether a saved pane read back from disk has the shape `hydrate` expects. */
  isSaved(saved: Record<string, unknown>): boolean;
  hydrate(saved: SavedOf<K>): PaneOf<K>;
  /** Draws the content inside the pane's frame. */
  mount: Component<PaneViewProps<K>>;
  /** Give the content the keyboard. False when there is nothing to focus. */
  focus(paneId: PaneId): boolean;
  /** The pane is gone for good: closed, or its content replaced. */
  destroy(paneId: PaneId): void;
  /** The pane is moving to another window, which rebuilds it from its snapshot. */
  release(paneId: PaneId): void;
}

// The page can't cross a window, only its address can: a released page is
// destroyed like a closed one, and the destination loads the address again.
const browser: PaneKind<"browser"> = {
  title: (paneId, pane) => browserTitle(paneId, pane.url),
  snapshot: (_paneId, pane) => ({ kind: "browser", url: pane.url }),
  isSaved: (saved) => typeof saved.url === "string",
  hydrate: (saved) => ({ kind: "browser", url: saved.url }),
  mount: BrowserPane,
  focus: focusBrowser,
  destroy: disposeBrowser,
  release: disposeBrowser,
};

// The kinds still handled by their own branches. Every other kind must have a
// descriptor here, or this map doesn't compile — which is what lets the
// snapshot and the transfer hand any kind past those branches to `paneKind`.
type LegacyKind = "terminal" | "markdown" | "text" | "image";

const kinds: { [K in Exclude<Kind, LegacyKind>]: PaneKind<K> } & {
  [K in LegacyKind]?: undefined;
} = { browser };

/** The descriptor for a kind, or undefined for one not described here yet. */
export function paneKind(kind: Kind): PaneKind | undefined {
  // Each descriptor only ever receives panes of its own kind; the cast widens
  // it to the shape callers that hold an arbitrary pane can call.
  // Own keys only: a kind read back from a corrupt snapshot ("constructor")
  // must not find something on Object's prototype.
  if (!Object.hasOwn(kinds, kind)) return undefined;
  return kinds[kind] as PaneKind | undefined;
}
