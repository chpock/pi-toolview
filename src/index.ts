import { createEditToolDefinition, highlightCode, getLanguageFromPath, type ExtensionAPI, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { isAbsolute, resolve } from "node:path";
import { renderBashCard } from "./bash-card.ts";
import { editPath, measureEditCard, renderEditCard } from "./edit-card.ts";
import { renderUserCard } from "./user-card.ts";
import { cardGeometry, insidePanel } from "./card-frame.ts";
import type { CardTheme } from "./card-theme.ts";
import { RenderCache, type CacheEntry, type CacheStats } from "./render-cache.ts";
import { argumentParts, summaryName } from "./summary-args.ts";
export { describeArgs, sanitize } from "./summary-args.ts";

/** The private contract verified against Pi 1.0.0; never import a second internal class. */
interface ToolNode extends Component {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  expanded: boolean;
  hideComponent: boolean;
  isPartial: boolean;
  executionStarted: boolean;
  argsComplete: boolean;
  result?: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown };
  markExecutionStarted(): void;
  updateArgs(args: unknown): void;
  updateResult(result: unknown, partial?: boolean): void;
  setExpanded(expanded: boolean): void;
  getRenderContext(): unknown;
  getRenderShell(): string;
  callRendererComponent?: Component;
  getCallRenderer?(): unknown;
  getResultRenderer?(): unknown;
}
interface UserNode extends Container {
  text: string;
  outputPad: number;
  markdownTheme: object;
  markdownTransformers: unknown[];
  rebuild(): void;
  setOutputPad(padding: number): void;
}
type UserRender = (this: UserNode, width: number) => string[];
const userCandidate = (node: Component): node is UserNode =>
  node instanceof Container && node.constructor.name === "UserMessageComponent";
const compatibleUser = (node: UserNode) => typeof node.text === "string" &&
  Number.isSafeInteger(node.outputPad) && node.outputPad >= 0 &&
  typeof node.markdownTheme === "object" && node.markdownTheme !== null && Array.isArray(node.markdownTransformers) &&
  typeof node.rebuild === "function" && typeof node.setOutputPad === "function" &&
  node.children.length === 1 && node.children[0] instanceof Markdown;

type LiveTui = Component & {
  requestRender(): void;
  hasActiveSelection?(): boolean;
};
type Palette = CardTheme;
type Render = (this: ToolNode, width: number) => string[];
type Mouse = (this: ToolNode, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

export interface ToolviewOptions {
  cards?: readonly string[];
  compact?: readonly string[];
  warn?: (reason: string) => void;
  cacheMiB?: number;
  cardCacheMiB?: number;
}
export interface ToolviewCacheStats extends CacheStats { ordinary: CacheStats; cards: CacheStats }
export interface ToolviewController {
  readonly active: boolean;
  readonly reason: string | undefined;
  restore(): void;
  cacheStats(): ToolviewCacheStats;
  clearCache(): void;
  setCacheLimitMiB(value: number): void;
  setCardCacheLimitMiB(value: number): void;
}
const DEFAULT_CARDS = ["bash", "powershell", "write", "edit"];
// The public factory exposes the stable stock renderer functions; no execution or file I/O.
const { renderCall: stockEditCall, renderResult: stockEditResult } = createEditToolDefinition(".");
// Controls all trailing status markers, including the pending ellipsis, not the leading spinner.
const SHOW_COMPLETION_MARKERS = false;
const SPINNER_FRAMES = Array.from("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏");
const SPINNER_INTERVAL_MS = 100;


const summaryGraphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// Match Pi 1.0.0's plain-text token boundaries; punctuation is otherwise part of a word.
const summaryCjkBreak = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\p{Script_Extensions=Bopomofo}]/u;

/** Commas in parameters are soft breaks, not inserted spaces or modified JSON. */
function wrapSummary(text: string, width: number, parameterStart: number, parameterLength: number): string[] {
  const parameters = text.slice(parameterStart, parameterStart + parameterLength);
  if (!parameters.includes(",")) return wrapTextWithAnsi(text, width);
  const tokens: string[] = [];
  let word = "", wordIsSpace = false;
  const flushWord = () => { if (word) tokens.push(word); word = ""; };
  for (const { segment, index } of summaryGraphemes.segment(text)) {
    if (summaryCjkBreak.test(segment)) {
      flushWord(); tokens.push(segment); continue;
    }
    const space = segment === " ";
    if (word && wordIsSpace !== space) flushWord();
    word += segment;
    wordIsSpace = space;
    // A comma with a combining mark is not a standalone grapheme boundary.
    if (segment === "," && index >= parameterStart && index < parameterStart + parameterLength) flushWord();
  }
  flushWord();
  const rows: string[] = [];
  let line = "", lineWidth = 0;
  const flush = () => { if (line.trimEnd()) rows.push(line.trimEnd()); line = ""; lineWidth = 0; };
  for (const token of tokens) {
    const tokenWidth = visibleWidth(token);
    const whitespace = token.trim() === "";
    if (tokenWidth > width && !whitespace) {
      flush();
      const broken = wrapTextWithAnsi(token, width);
      for (let i = 0; i < broken.length - 1; i++) rows.push(broken[i]!);
      line = broken.at(-1)!;
      lineWidth = visibleWidth(line);
    } else if (lineWidth + tokenWidth > width) {
      flush();
      if (!whitespace) { line = token; lineWidth = tokenWidth; }
    } else {
      // Dropping leading wrap whitespace keeps rows source-substring compatible.
      if (!line && whitespace) continue;
      line += token;
      lineWidth += tokenWidth;
    }
  }
  flush();
  return rows;
}


function candidate(node: Component): node is ToolNode {
  const tool = node as Partial<ToolNode>;
  return typeof tool.toolCallId === "string" && typeof tool.toolName === "string";
}
function compatible(node: ToolNode): boolean {
  return node instanceof Container && typeof node.expanded === "boolean" &&
    typeof node.hideComponent === "boolean" && typeof node.isPartial === "boolean" &&
    typeof node.executionStarted === "boolean" && typeof node.argsComplete === "boolean" &&
    !!node.args && typeof node.args === "object" && !Array.isArray(node.args) &&
    typeof node.markExecutionStarted === "function" && typeof node.updateArgs === "function" && typeof node.updateResult === "function" &&
    typeof node.setExpanded === "function" && typeof node.getRenderContext === "function" &&
    typeof node.getRenderShell === "function" &&
    typeof node.render === "function" && typeof node.handleMouse === "function";
}

function bashDirectory(node: ToolNode): string | null | undefined {
  if (typeof node.args.workdir !== "string" || !node.args.workdir.length) return undefined;
  const context = node.getRenderContext() as { cwd?: unknown } | null | undefined;
  if (typeof context?.cwd !== "string" || !isAbsolute(context.cwd)) return null;
  const directory = resolve(context.cwd, node.args.workdir);
  return directory === resolve(context.cwd) ? undefined : directory;
}

/** The only compatibility-sensitive adapter. It does not change tools or session entries. */
export function installToolview(tui: LiveTui, getTheme: () => Palette, options: ToolviewOptions = {}): ToolviewController {
  let active = false;
  let reason: string | undefined;
  const parents = new WeakMap<Component, { parent: Container; index: number }>();
  const cache = new RenderCache((options.cacheMiB ?? 8) * 1024 * 1024);
  const cardCache = new RenderCache((options.cardCacheMiB ?? 128) * 1024 * 1024, 2048, 128 * 1024 * 1024);
  type Layout = { rows: string[]; framed?: boolean; native?: boolean };
  type SummaryLayout = Layout & { prefixLength: number };
  const animated = new Set<WeakRef<ToolNode>>();
  let animationRefs = new WeakMap<ToolNode, WeakRef<ToolNode>>();
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerFrame = 0;
  function stopSpinner() {
    if (spinnerTimer !== undefined) clearInterval(spinnerTimer);
    spinnerTimer = undefined;
    spinnerFrame = 0;
  }
  function removeAnimation(node: ToolNode) {
    const reference = animationRefs.get(node);
    if (reference) { animated.delete(reference); animationRefs.delete(node); }
    if (!animated.size) stopSpinner();
  }
  // Public tree edges also recognize the stable TUI proxy without probing its receiver.
  function attached(node: Component): boolean {
    let current = node;
    while (current !== tui) {
      if (current instanceof Container && tui instanceof Container && current.children === tui.children) return true;
      const position = parents.get(current);
      if (!position) return false;
      const children = position.parent.children;
      if (children[position.index] !== current) position.index = children.indexOf(current);
      if (position.index < 0) return false;
      current = position.parent;
    }
    return true;
  }
  const executing = (node: ToolNode) => node.executionStarted && (node.isPartial || !node.result) && eligible(node);
  function tickSpinner() {
    // Only the small weak set of painted running calls, never a full transcript traversal.
    for (const reference of animated) {
      const node = reference.deref();
      if (!node) animated.delete(reference);
      else if (!executing(node) || !attached(node)) removeAnimation(node);
    }
    if (!animated.size) { stopSpinner(); return; }
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    tui.requestRender(); // No global/native invalidation and no custom layout rebuild.
  }
  function animate(node: ToolNode) {
    if (!executing(node) || !attached(node)) { removeAnimation(node); return; }
    if (!animationRefs.has(node)) {
      const reference = new WeakRef(node); animationRefs.set(node, reference); animated.add(reference);
    }
    if (spinnerTimer === undefined) {
      spinnerTimer = setInterval(tickSpinner, SPINNER_INTERVAL_MS);
      spinnerTimer.unref?.();
    }
  }
  let states = new WeakMap<ToolNode, { signature: unknown[]; entry: CacheEntry<Layout>; pool: RenderCache }>();
  const forget = (node: ToolNode) => { const state = states.get(node); state?.pool.drop(state.entry); states.delete(node); };
  let userStates = new WeakMap<UserNode, { signature: unknown[]; entry: CacheEntry<Layout> }>();
  const forgetUser = (node: UserNode) => { cache.drop(userStates.get(node)?.entry); userStates.delete(node); };
  const clearCache = () => { cache.clear(); cardCache.clear(); states = new WeakMap(); userStates = new WeakMap(); };
  const cards = new Set([...DEFAULT_CARDS, ...options.cards ?? []]);
  const overrides = new Set(options.compact ?? []);
  const nativeOverrides = new Set(options.cards ?? []);
  const originalAdd = Container.prototype.addChild;
  const patches = new Map<object, {
    render: PropertyDescriptor; mouse: PropertyDescriptor; patchedRender: Render; patchedMouse: Mouse;
    updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
  }>();

  const userPatches = new Map<object, {
    render: PropertyDescriptor; patchedRender: UserRender;
    updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
  }>();
  const refresh = () => { tui.invalidate(); tui.requestRender(); };
  function layoutSignature(node: ToolNode, kind: string, width: number, theme: Palette, directory: string | undefined): unknown[] {
    return [kind, width, theme, theme.fg, kind === "bash" ? undefined : node.args, node.result, node.expanded, node.isPartial,
      node.toolName, node.result?.isError, (node.result?.details as { exit_code?: unknown } | undefined)?.exit_code,
      node.args.command, node.args.description, node.args.workdir, directory,
      kind === "edit" ? theme.colors : undefined, kind === "edit" ? theme.style : undefined, kind === "edit" ? theme.bg : undefined];
  }
  function memo<T extends Layout>(node: ToolNode, kind: string, width: number, theme: Palette, directory: string | undefined, build: () => T): T {
    const signature = layoutSignature(node, kind, width, theme, directory);
    const state = states.get(node);
    const matches = state && signature.every((value, index) => value === state.signature[index]);
    if (matches) {
      const value = state.pool.get(state.entry); if (value) return value as T;
    } else { state?.pool.drop(state.entry); }
    const value = build();
    // Select by the materialized presentation, not tool name: inline/native edit fallback is ordinary.
    const pool = kind === "bash" || (kind === "edit" && value.framed && !value.native) ? cardCache : cache;
    if (!matches) pool.get(undefined); // Attribute exactly one miss to the target pool.
    states.set(node, { signature, pool, entry: pool.put(value, value.rows) });
    return value;
  }
  const bashLayout = (node: ToolNode, width: number) => {
    const theme = getTheme(), directory = bashDirectory(node) ?? undefined;
    return memo(node, "bash", width, theme, directory, () => renderBashCard(node, directory, width, theme));
  };
  const editLayout = (node: ToolNode, width: number) => {
    const theme = getTheme();
    const context = node.getRenderContext() as { cwd?: unknown } | undefined;
    const cwd = typeof context?.cwd === "string" ? context.cwd : undefined;
    return memo(node, "edit", width, theme, cwd, () => renderEditCard(node, cwd, width, theme,
      theme.colors && theme.style ? (code, path) => highlightCode(code, getLanguageFromPath(path)) : undefined) ??
      { rows: nativeRows(node, width), framed: false, native: true });
  };
  function editMeasure(node: ToolNode, width: number) {
    const theme = getTheme();
    const context = node.getRenderContext() as { cwd?: unknown } | undefined;
    const cwd = typeof context?.cwd === "string" ? context.cwd : undefined;
    const state = states.get(node), signature = layoutSignature(node, "edit", width, theme, cwd);
    // Read only the existing exact layout. Never admit another cache entry or retain measurement data.
    if (state && signature.every((value, index) => value === state.signature[index])) {
      const layout = state.pool.get(state.entry) as ReturnType<typeof renderEditCard>;
      if (layout) return layout.native ? undefined : { framed: layout.framed, height: layout.rows.length };
    }
    return measureEditCard(node, cwd, width);
  }
  const summaryLayout = (node: ToolNode, width: number) => {
    const theme = getTheme();
    return memo(node, "summary", width, theme, undefined, () => summaryRows(node, width, theme));
  };
  const controller: ToolviewController = {
    get active() { return active; },
    get reason() { return reason; },
    cacheStats: () => {
      const ordinary = cache.stats(), cards = cardCache.stats();
      return { ordinary, cards,
        retainedBytes: ordinary.retainedBytes + cards.retainedBytes, limitBytes: ordinary.limitBytes + cards.limitBytes,
        entries: ordinary.entries + cards.entries, hits: ordinary.hits + cards.hits, misses: ordinary.misses + cards.misses,
        builds: ordinary.builds + cards.builds, evictions: ordinary.evictions + cards.evictions, skips: ordinary.skips + cards.skips };
    },
    clearCache,
    setCacheLimitMiB: (value) => cache.setLimit(value * 1024 * 1024),
    setCardCacheLimitMiB: (value) => cardCache.setLimit(value * 1024 * 1024),
    restore() {
      if (!active && !patches.size && !userPatches.size) return;
      active = false;
      stopSpinner(); animated.clear(); animationRefs = new WeakMap();
      clearCache();
      if (Container.prototype.addChild === patchedAdd) Container.prototype.addChild = originalAdd;
      for (const [prototype, patch] of patches) {
        if (Object.getOwnPropertyDescriptor(prototype, "render")?.value === patch.patchedRender)
          Object.defineProperty(prototype, "render", patch.render);
        if (Object.getOwnPropertyDescriptor(prototype, "handleMouse")?.value === patch.patchedMouse)
          Object.defineProperty(prototype, "handleMouse", patch.mouse);
        for (const update of patch.updates) {
          if (Object.getOwnPropertyDescriptor(prototype, update.name)?.value !== update.wrapper) continue;
          if (update.original) Object.defineProperty(prototype, update.name, update.original);
          else Reflect.deleteProperty(prototype, update.name);
        }
      }
      patches.clear();
      for (const [prototype, patch] of userPatches) {
        if (Object.getOwnPropertyDescriptor(prototype, "render")?.value === patch.patchedRender)
          Object.defineProperty(prototype, "render", patch.render);
        for (const update of patch.updates) {
          if (Object.getOwnPropertyDescriptor(prototype, update.name)?.value !== update.wrapper) continue;
          if (update.original) Object.defineProperty(prototype, update.name, update.original);
          else Reflect.deleteProperty(prototype, update.name);
        }
      }
      userPatches.clear();
      refresh();
    },
  };
  const fail = (message: string) => {
    if (reason) return;
    reason = message;
    controller.restore();
    options.warn?.(message);
  };
  const editSucceeded = (node: ToolNode) => node.toolName === "edit" && !!node.result && !node.isPartial && !node.result.isError;
  const eligible = (node: Component): node is ToolNode => active && candidate(node) &&
    !node.hideComponent && !node.expanded && (overrides.has(node.toolName) || !cards.has(node.toolName) ||
      (node.toolName === "edit" && !nativeOverrides.has("edit") && !editSucceeded(node))) &&
    !node.result?.content.some((content) => content.type === "image");
  const compact = (node: Component, width: number): node is ToolNode => {
    if (!eligible(node)) return false;
    return nativeVisible(node, width);
  };
  function nativeVisible(node: ToolNode, width: number): boolean {
    if (node.getRenderShell() !== "self") return true;
    // Stock edit always supplies a heading in an ordinary Box. Its native factory can reuse
    // a previous custom Box, so both renderer identities AND the current component must qualify.
    // Check every visit; no retained visibility proof or native-state mutation.
    if (typeof stockEditCall === "function" && typeof stockEditResult === "function" &&
      node.constructor.name === "ToolExecutionComponent" && node.toolName === "edit" &&
      typeof node.getCallRenderer === "function" && node.getCallRenderer() === stockEditCall &&
      typeof node.getResultRenderer === "function" && node.getResultRenderer() === stockEditResult &&
      node.callRendererComponent instanceof Box && Object.getPrototypeOf(node.callRendererComponent) === Box.prototype &&
      node.callRendererComponent.render === Box.prototype.render &&
      node.callRendererComponent.clear === Box.prototype.clear && node.callRendererComponent.addChild === Box.prototype.addChild) return true;
    // Unknown self shells can be empty/width-dependent even when hideComponent is false.
    return nativeRows(node, width).length > 0;
  }

  function bashCard(node: Component, width: number): boolean {
    if (!active || !candidate(node) || node.toolName !== "bash" || node.hideComponent ||
      overrides.has("bash") || nativeOverrides.has("bash") || typeof node.args.command !== "string" ||
      node.result?.content.some((part) => part.type === "image") || bashDirectory(node) === null) return false;
    return nativeVisible(node, width);
  }

  function editCard(node: Component, width: number): boolean {
    if (!active || !candidate(node) || !editSucceeded(node) || node.hideComponent || node.expanded ||
      overrides.has("edit") || nativeOverrides.has("edit") || !editPath(node.args) ||
      node.result?.content.some((part) => part.type === "image")) return false;
    return nativeVisible(node, width);
  }

  function summaryRows(node: ToolNode, width: number, theme: Palette): SummaryLayout {
    if (width < 1) return { rows: [], prefixLength: 0 };
    const available = width - 1; // Reserve the right margin before laying out any text.
    const failed = !node.isPartial && node.result?.isError;
    const pending = node.isPartial || !node.result;
    const marker = SHOW_COMPLETION_MARKERS ? pending ? "…" : failed ? "✗" : "✓" : "";
    const statusColor = failed ? "error" : pending ? "muted" : "success";
    const glyph = node.toolName === "read" ? "→" : "⚙";
    if (available < 5) {
      const prefix = theme.fg(marker ? statusColor : failed ? "error" : "dim", marker || glyph);
      return { rows: [prefix], prefixLength: prefix.length };
    }
    const prefix = theme.fg(failed ? "error" : "dim", ` ${glyph} `);
    const parts: { color?: ThemeColor; text: string }[] = [{ color: "toolTitle", text: summaryName(node.toolName) }];
    const { pattern, object, params } = argumentParts(node.toolName, node.args);
    if (pattern) {
      parts.push({ color: "muted", text: ` ${pattern}` });
      if (object) parts.push({ color: "dim", text: " in " }, { color: "muted", text: object });
    } else if (object) parts.push({ color: "muted", text: ` ${object}` });
    const parameterStart = parts.reduce((length, part) => length + part.text.length, 0) + 1;
    if (params) parts.push({ color: "dim", text: ` ${params}` });
    if (marker) parts.push({ text: " " }, { color: statusColor, text: marker });
    // Layout plain text before styling. Pi 1.0.0's ANSI word wrapper mistakes
    // colored whitespace for content, adding padding or empty content rows.
    const plain = parts.map((part) => part.text).join("");
    let end = 0;
    const spans = parts.map((part) => { const start = end; end += part.text.length; return { ...part, start, end }; });
    let cursor = 0;
    const rows = wrapSummary(plain, available - 3, parameterStart, params.length).map((line, index) => {
      const start = plain.indexOf(line, cursor);
      if (start < 0) throw new Error("Wrapped text is not a source substring");
      cursor = start + line.length;
      const styled = spans.map((span) => {
        const from = Math.max(start, span.start), to = Math.min(cursor, span.end);
        if (from >= to) return "";
        const text = plain.slice(from, to);
        return failed ? theme.fg("error", text) : span.color ? theme.fg(span.color, text) : text;
      }).join("");
      return (index === 0 ? prefix : "   ") + styled;
    });
    return { rows, prefixLength: prefix.length };
  }
  function paintSummary(node: ToolNode, width: number): string[] {
    const layout = summaryLayout(node, width);
    animate(node);
    if (!executing(node) || !layout.rows.length) return layout.rows;
    const frame = SPINNER_FRAMES[spinnerFrame]!;
    const prefix = getTheme().fg("dim", width < 6 ? frame : ` ${frame} `);
    return [prefix + layout.rows[0]!.slice(layout.prefixLength), ...layout.rows.slice(1)];
  }
  function nativeRows(node: Component, width: number): string[] {
    const render = candidate(node) ? patches.get(Object.getPrototypeOf(node))?.render.value as Render | undefined : undefined;
    return render ? render.call(node as ToolNode, width) : node.render(width);
  }
  function previousLayout(node: Component, width: number): { compact: boolean; tool: boolean; height: number; separator?: boolean } | undefined {
    const position = parents.get(node);
    const siblings = position?.parent.children ?? [];
    let current = position?.index ?? -1;
    if (siblings[current] !== node) { current = siblings.indexOf(node); if (position) position.index = current; }
    for (let index = current - 1; index >= 0; index--) {
      const previous = siblings[index];
      if (width > 0 && bashCard(previous, width)) return { compact: false, tool: true, height: 3 };
      if (width > 0 && candidate(previous) && editCard(previous, width)) {
        const measure = editMeasure(previous, width);
        if (measure?.height) return { compact: !measure.framed, tool: true, height: measure.height };
      }
      if (compact(previous, width)) return { compact: true, tool: true, height: summaryLayout(previous, width).rows.length };
      // User cards contribute cached content metadata, not recursive predecessor rendering.
      const userRender = userCandidate(previous) ? userPatches.get(Object.getPrototypeOf(previous))?.render.value as UserRender | undefined : undefined;
      const lines = userRender ? userLayout(previous as UserNode, width, userRender).rows : nativeRows(previous, width);
      if (lines.length) return { compact: false, tool: candidate(previous), height: lines.length - (lines[0] === "" ? 1 : 0), separator: lines.at(-1) === "" };
    }
    return undefined;
  }
  function gap(node: ToolNode, width: number): number {
    const previous = previousLayout(node, width);
    return previous ? previous.compact && previous.height === 1 ? 0 : 1 : 0;
  }
  function nativeGap(node: ToolNode, width: number, lines: string[]): number {
    if (!active || !lines.length || lines[0] === "") return 0;
    const previous = previousLayout(node, width);
    return previous?.tool && previous.height > 1 ? 1 : 0;
  }
  function install(node: ToolNode) {
    if (!compatible(node)) { fail("Tool component contract is incompatible; native rendering retained"); return; }
    patchPrototype(Object.getPrototypeOf(node) as object);
  }
  // Persistent wrappers must be created in a scope with no tool-instance parameter.
  function patchPrototype(prototype: object) {
    if (patches.has(prototype)) return;
    const render = Object.getOwnPropertyDescriptor(prototype, "render");
    const mouse = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
    if (!render?.writable || !mouse?.writable || typeof render.value !== "function" || typeof mouse.value !== "function") {
      fail("Tool rendering methods cannot be safely replaced; native rendering retained"); return;
    }
    const originalRender = render.value as Render;
    const originalMouse = mouse.value as Mouse;
    const patchedRender: Render = function (width) {
      try {
        if (bashCard(this, width)) {
          removeAnimation(this);
          const rows = bashLayout(this, width).rows;
          if (!rows.length) return rows;
          return previousLayout(this, width) ? ["", ...rows] : rows;
        }
        if (editCard(this, width)) {
          removeAnimation(this);
          const layout = editLayout(this, width);
          const offset = layout.native ? nativeGap(this, width, layout.rows) : layout.framed ? (previousLayout(this, width) ? 1 : 0) : gap(this, width);
          return offset ? [""].concat(layout.rows) : layout.rows;
        }
        if (!eligible(this)) {
          removeAnimation(this);
          const lines = originalRender.call(this, width);
          return nativeGap(this, width, lines) ? ["", ...lines] : lines;
        }
        if (width < 1) { removeAnimation(this); return []; }
        if (!nativeVisible(this, width)) { removeAnimation(this); return []; }
        const offset = gap(this, width), rows = paintSummary(this, width);
        return offset ? ["", ...rows] : rows;
      }
      catch { fail("Toolview could not render this component; native rendering restored"); return originalRender.call(this, width); }
    };
    const patchedMouse: Mouse = function (event) {
      if (event.width > 0 && bashCard(this, event.width)) {
        if (event.type !== "click" || event.button !== "left" || tui.hasActiveSelection?.()) return undefined;
        const layout = bashLayout(this, event.width);
        const offset = previousLayout(this, event.width) ? 1 : 0;
        const hit = layout.expandable && insidePanel(layout.geometry, layout.rows.length, event.x, event.y - offset);
        if (!hit) return undefined;
        this.setExpanded(!this.expanded);
        tui.requestRender();
        return { handled: true };
      }
      if (event.width > 0 && editCard(this, event.width)) {
        const rejected = !this.result || this.isPartial || tui.hasActiveSelection?.() || event.type !== "click" || event.button !== "left";
        if (rejected) {
          // Unsupported metadata must still delegate; supported cards need no body to reject an event.
          if (editMeasure(this, event.width)) return undefined;
        } else {
          const layout = editLayout(this, event.width);
          if (!layout.native) {
            const offset = layout.framed ? (previousLayout(this, event.width) ? 1 : 0) : gap(this, event.width);
            const hit = layout.framed ? insidePanel(cardGeometry(event.width), layout.rows.length, event.x, event.y - offset) :
              this.result?.isError && event.y >= offset && event.y < offset + layout.rows.length;
            if (!hit) return undefined;
            this.setExpanded(true); tui.requestRender(); return { handled: true };
          }
        }
      }
      if (!compact(this, event.width)) {
        const offset = nativeGap(this, event.width, originalRender.call(this, event.width));
        if (event.y < offset) return undefined;
        return originalMouse.call(this, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
      }
      const offset = gap(this, event.width);
      if (!this.result || this.isPartial || event.type !== "click" || event.button !== "left" ||
        event.y < offset || event.y >= offset + summaryLayout(this, event.width).rows.length) return undefined;
      this.setExpanded(true);
      tui.requestRender();
      return { handled: true };
    };
    const updates = ["updateArgs", "updateResult", "setExpanded", "invalidate", "markExecutionStarted"].map((name) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== "function" || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error("Tool cache invalidation methods cannot be wrapped");
      const wrapper = function (this: ToolNode, ...args: unknown[]) {
        // Bash keys include every displayed argument; unrelated/same argument updates reuse its body.
        if (name !== "markExecutionStarted" && !(name === "updateArgs" && this.toolName === "bash" && !overrides.has("bash")) &&
          !(name === "setExpanded" && args[0] === this.expanded)) forget(this);
        const result = method.apply(this, args);
        if (!executing(this) || !attached(this)) removeAnimation(this);
        return result;
      };
      return { name, original, wrapper };
    });
    patches.set(prototype, { render, mouse, patchedRender, patchedMouse, updates });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    Object.defineProperty(prototype, "handleMouse", { ...mouse, value: patchedMouse });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }
  function userLayout(node: UserNode, width: number, originalRender: UserRender): Layout {
    const theme = getTheme();
    const signature = [width, theme, theme.fg, theme.bg, node.text, node.outputPad, node.children[0], node.markdownTheme, node.markdownTransformers];
    const state = userStates.get(node);
    if (state && signature.every((value, index) => value === state.signature[index])) {
      const value = cache.get(state.entry); if (value) return value;
    } else { cache.drop(state?.entry); cache.get(undefined); }
    const value = renderUserCard(width, node.outputPad, theme, (size) => originalRender.call(node, size));
    userStates.set(node, { signature, entry: cache.put(value, value.rows) });
    return value;
  }
  function installUser(node: UserNode) {
    if (!compatibleUser(node)) { fail("User-message component contract is incompatible; native rendering retained"); return; }
    patchUserPrototype(Object.getPrototypeOf(node) as object);
  }
  // Like tool hooks, these persistent closures are built without an installer-node parameter.
  function patchUserPrototype(prototype: object) {
    if (userPatches.has(prototype)) return;
    const render = Object.getOwnPropertyDescriptor(prototype, "render");
    if (!render?.writable || !render.configurable || typeof render.value !== "function") {
      fail("User-message rendering cannot be safely replaced; native rendering retained"); return;
    }
    const originalRender = render.value as UserRender;
    const patchedRender: UserRender = function (width) {
      if (!active) return originalRender.call(this, width);
      if (width < 1) return [];
      try {
        if (!compatibleUser(this)) throw new Error("User-message component contract changed");
        const rows = userLayout(this, width, originalRender).rows;
        const previous = rows.length ? previousLayout(this, width) : undefined;
        return previous && !previous.separator ? ["", ...rows] : rows;
      } catch {
        fail("Toolview could not render this user message; native rendering restored");
        return originalRender.call(this, width);
      }
    };
    const updates = ["rebuild", "setOutputPad", "invalidate"].map((name) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== "function" || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error("User-message invalidation methods cannot be wrapped");
      const wrapper = function (this: UserNode, ...args: unknown[]) { forgetUser(this); return method.apply(this, args); };
      return { name, original, wrapper };
    });
    userPatches.set(prototype, { render, patchedRender, updates });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }
  function visit(node: Component, parent?: Container, index = -1) {
    if (!active) return;
    if (parent) parents.set(node, { parent, index });
    if (candidate(node)) install(node);
    else if (userCandidate(node)) installUser(node);
    if (node instanceof Container) node.children.forEach((child, index) => visit(child, node, index));
  }
  function patchedAdd(this: Container, child: Component) {
    originalAdd.call(this, child);
    // A whole prebuilt subtree can be attached during history reconstruction.
    visit(child, this, this.children.length - 1);
  }

  if (!(tui instanceof Container) || typeof tui.requestRender !== "function") {
    fail("The live Pi TUI does not share the host Container; native rendering retained");
    return controller;
  }
  try {
    active = true;
    visit(tui);
    if (active) {
      Container.prototype.addChild = patchedAdd;
      refresh();
    }
  } catch {
    fail("Toolview could not install its UI hooks; native rendering restored");
  }
  return controller;
}

export default function toolview(pi: ExtensionAPI) {
  pi.registerFlag("toolview-card", { type: "string", description: "Additional comma-separated tool names that retain native cards" });
  pi.registerFlag("toolview-compact", { type: "string", description: "Comma-separated tool names that use compact summaries instead of native cards" });
  pi.registerFlag("toolview-cache-mb", { type: "string", description: "Ordinary render-cache budget in MiB (0–64; default 8)" });
  pi.registerFlag("toolview-card-cache-mb", { type: "string", description: "Bash/edit-diff render-cache budget in MiB (0–128; default 128)" });
  let cacheMiB: number | undefined, cardCacheMiB: number | undefined;
  function cacheLimit(text: string, maximum = 64): number {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || value < 0 || value > maximum) throw new RangeError(`Cache limit must be 0–${maximum} MiB`);
    return value;
  }
  let controller: ToolviewController | undefined;
  let enabled = true;
  const names = (flag: string) => String(pi.getFlag(flag) ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  function start(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !enabled || controller?.active) return;
    if (cacheMiB === undefined) {
      try { cacheMiB = cacheLimit(String(pi.getFlag("toolview-cache-mb") ?? "8")); }
      catch { ctx.ui.notify("Pi Toolview: invalid --toolview-cache-mb; using 8 MiB", "warning"); cacheMiB = 8; }
    }
    if (cardCacheMiB === undefined) {
      try { cardCacheMiB = cacheLimit(String(pi.getFlag("toolview-card-cache-mb") ?? "128"), 128); }
      catch { ctx.ui.notify("Pi Toolview: invalid --toolview-card-cache-mb; using 128 MiB", "warning"); cardCacheMiB = 128; }
    }
    // A public widget factory exposes the actual live tree, including bundled CLI classes.
    // Remove the empty widget immediately: it is not part of our layout.
    ctx.ui.setWidget("pi-toolview-capture", (tui) => {
      controller = installToolview(tui, () => ctx.ui.theme, {
        cards: names("toolview-card"), compact: names("toolview-compact"), cacheMiB, cardCacheMiB,
        warn: (message) => ctx.ui.notify(`Pi Toolview disabled: ${message}`, "warning"),
      });
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-toolview-capture", undefined);
  }
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", () => { controller?.restore(); controller = undefined; });
  pi.registerCommand("toolview", {
    description: "Control tool presentation and bounded render cache: on, off, status, cache",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      const words = command.split(/\s+/u);
      if (words[0] === "cache") {
        if (!controller || ctx.mode !== "tui") { ctx.ui.notify("Pi Toolview cache: unavailable outside an initialized terminal runtime", "info"); return; }
        if (words.length === 2 && words[1] === "clear") controller.clearCache();
        else if (words.length === 3 && words[1] === "limit") {
          try { const value = cacheLimit(words[2]); controller.setCacheLimitMiB(value); cacheMiB = value; }
          catch { ctx.ui.notify("Pi Toolview: cache limit must be 0–64 MiB", "warning"); return; }
        } else if (words.length === 4 && words[1] === "cards" && words[2] === "limit") {
          try { const value = cacheLimit(words[3], 128); controller.setCardCacheLimitMiB(value); cardCacheMiB = value; }
          catch { ctx.ui.notify("Pi Toolview: card cache limit must be 0–128 MiB", "warning"); return; }
        } else if (words.length !== 1) {
          ctx.ui.notify("Usage: /toolview cache [clear|limit <MiB>|cards limit <MiB>]", "warning"); return;
        }
        ctx.ui.notify(`Pi Toolview cache: ${JSON.stringify({ ...controller.cacheStats(),
          processHeapUsedBytes: process.memoryUsage().heapUsed, processMemoryScope: "whole Pi process, not Toolview" })}`, "info");
        return;
      }
      if (command === "off") { enabled = false; controller?.restore(); }
      else if (command === "on") { enabled = true; start(ctx); }
      else if (command !== "status") { ctx.ui.notify("Usage: /toolview on|off|status|cache [clear|limit <MiB>|cards limit <MiB>]", "warning"); return; }
      const status = controller?.active ? "on" : ctx.mode !== "tui" ? "unavailable outside terminal mode" : controller?.reason ?? "off";
      ctx.ui.notify(`Pi Toolview: ${status}`, "info");
    },
  });
}
