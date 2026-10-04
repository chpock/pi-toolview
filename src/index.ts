import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { renderBashCard } from "./bash-card.ts";
import { insidePanel } from "./card-frame.ts";
import type { CardTheme } from "./card-theme.ts";
import { RenderCache, type CacheEntry, type CacheStats } from "./render-cache.ts";

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
  updateArgs(args: unknown): void;
  updateResult(result: unknown, partial?: boolean): void;
  setExpanded(expanded: boolean): void;
  getRenderContext(): unknown;
  getRenderShell(): string;
}
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
}
export interface ToolviewController {
  readonly active: boolean;
  readonly reason: string | undefined;
  restore(): void;
  cacheStats(): CacheStats;
  clearCache(): void;
  setCacheLimitMiB(value: number): void;
}
const DEFAULT_CARDS = ["bash", "powershell", "write", "edit"];

/** Untrusted labels may not inject colors, terminal commands, bidi controls, or additional rows. */
export function sanitize(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/\s+/gu, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu, "");
}
const OBJECT_KEYS = ["path", "target", "url", "scope"];
const IMPORTANT_KEYS = ["paths", "path", "target", "url", "scope", "query", "queries", "op", "action", "symbol", "symbols", "command", "subject", "offset", "limit", "startLine", "endLine"];
const PAYLOAD_KEYS = new Set(["content", "edits", "code", "input", "messages", "prompt", "newString", "oldString", "appendContent", "rewrite", "oldText", "newText"]);
const SECRET_KEYS = new Set(["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"]);

function valueText(value: unknown): string {
  try {
    return sanitize(JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? sanitize(item) : item) ?? '"[unavailable]"');
  } catch { return '"[unavailable]"'; }
}
function location(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function objectText(value: string): string {
  const text = sanitize(value);
  return !text || /[\s"\\\[\],]/u.test(text) ? valueText(text) : text;
}
function argumentParts(args: Record<string, unknown>) {
  const used = new Set<string>();
  let pattern: string | undefined, object: string | undefined;
  if (typeof args.pattern === "string") {
    pattern = valueText(args.pattern); used.add("pattern");
    if (location(args.path)) { object = objectText(args.path); used.add("path"); }
  } else {
    const key = OBJECT_KEYS.find((key) => location(args[key]));
    if (key) { object = objectText(args[key] as string); used.add(key); }
  }
  const rank = (key: string) => { const index = IMPORTANT_KEYS.indexOf(key); return index < 0 ? IMPORTANT_KEYS.length : index; };
  const entries = Object.entries(args).filter(([key, value]) => !used.has(key) && !PAYLOAD_KEYS.has(key) && value !== undefined);
  entries.sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  const params = entries.map(([key, value]) => {
    const label = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : valueText(key);
    return `${label}=${valueText(SECRET_KEYS.has(key) ? "<redacted>" : value)}`;
  });
  return { pattern, object, params: params.length ? `[${params.join(", ")}]` : "" };
}

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

/** Pure, name-independent logical description; presentation never changes arguments. */
export function describeArgs(_name: string, args: Record<string, unknown>): string {
  const { pattern, object, params } = argumentParts(args);
  const primary = pattern ? `${pattern}${object ? ` in ${object}` : ""}` : object ?? "";
  return [primary, params].filter(Boolean).join(" ");
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
    typeof node.updateArgs === "function" && typeof node.updateResult === "function" &&
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
  type Layout = { rows: string[] };
  let states = new WeakMap<ToolNode, { signature: unknown[]; entry: CacheEntry<Layout> }>();
  const forget = (node: ToolNode) => { cache.drop(states.get(node)?.entry); states.delete(node); };
  const clearCache = () => { cache.clear(); states = new WeakMap(); };
  const cards = new Set([...DEFAULT_CARDS, ...options.cards ?? []]);
  const overrides = new Set(options.compact ?? []);
  const nativeOverrides = new Set(options.cards ?? []);
  const originalAdd = Container.prototype.addChild;
  const patches = new Map<object, {
    render: PropertyDescriptor; mouse: PropertyDescriptor; patchedRender: Render; patchedMouse: Mouse;
    updates: { name: string; original?: PropertyDescriptor; wrapper: (...args: unknown[]) => unknown }[];
  }>();

  const refresh = () => { tui.invalidate(); tui.requestRender(); };
  function memo<T extends Layout>(node: ToolNode, kind: string, width: number, theme: Palette, directory: string | undefined, build: () => T): T {
    const signature = [kind, width, theme, theme.fg, kind === "bash" ? undefined : node.args, node.result, node.expanded, node.isPartial,
      node.toolName, node.result?.isError, (node.result?.details as { exit_code?: unknown } | undefined)?.exit_code,
      node.args.command, node.args.description, node.args.workdir, directory];
    const state = states.get(node);
    if (state && signature.every((value, index) => value === state.signature[index])) {
      const value = cache.get(state.entry); if (value) return value as T;
    } else { cache.drop(state?.entry); cache.get(undefined); }
    const value = build();
    states.set(node, { signature, entry: cache.put(value, value.rows) });
    return value;
  }
  const bashLayout = (node: ToolNode, width: number) => {
    const theme = getTheme(), directory = bashDirectory(node) ?? undefined;
    return memo(node, "bash", width, theme, directory, () => renderBashCard(node, directory, width, theme));
  };
  const summaryLayout = (node: ToolNode, width: number) => {
    const theme = getTheme();
    return memo(node, "summary", width, theme, undefined, () => ({ rows: summaryRows(node, width, theme) })).rows;
  };
  const controller: ToolviewController = {
    get active() { return active; },
    get reason() { return reason; },
    cacheStats: () => cache.stats(),
    clearCache,
    setCacheLimitMiB: (value) => cache.setLimit(value * 1024 * 1024),
    restore() {
      if (!active && !patches.size) return;
      active = false;
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
      refresh();
    },
  };
  const fail = (message: string) => {
    if (reason) return;
    reason = message;
    controller.restore();
    options.warn?.(message);
  };
  const eligible = (node: Component): node is ToolNode => active && candidate(node) &&
    !node.hideComponent && !node.expanded && (overrides.has(node.toolName) || !cards.has(node.toolName)) &&
    !node.result?.content.some((content) => content.type === "image");
  const compact = (node: Component, width: number): node is ToolNode => {
    if (!eligible(node)) return false;
    if (node.getRenderShell() !== "self") return true;
    // Pi's self shell can render zero rows while hideComponent remains false.
    // Visibility belongs to the native renderer and can depend on viewport width.
    const nativeRender = patches.get(Object.getPrototypeOf(node))?.render.value as Render;
    return nativeRender.call(node, width).length > 0;
  };

  function bashCard(node: Component, width: number): boolean {
    if (!active || !candidate(node) || node.toolName !== "bash" || node.hideComponent ||
      overrides.has("bash") || nativeOverrides.has("bash") || typeof node.args.command !== "string" ||
      node.result?.content.some((part) => part.type === "image") || bashDirectory(node) === null) return false;
    return node.getRenderShell() !== "self" || nativeRows(node, width).length > 0;
  }


  function summaryRows(node: ToolNode, width: number, theme: Palette): string[] {
    if (width < 1) return [];
    const failed = !node.isPartial && node.result?.isError;
    const marker = node.isPartial || !node.result ? "…" : failed ? "✗" : "✓";
    const statusColor = failed ? "error" : marker === "✓" ? "success" : "muted";
    if (width < 5) return [theme.fg(statusColor, marker)];
    const prefix = theme.fg("dim", " → ");
    const parts: { color?: ThemeColor; text: string }[] = [{ color: "toolTitle", text: sanitize(node.toolName).trim() }];
    const { pattern, object, params } = argumentParts(node.args);
    if (pattern) {
      parts.push({ color: "muted", text: ` ${pattern}` });
      if (object) parts.push({ color: "dim", text: " in " }, { color: "muted", text: object });
    } else if (object) parts.push({ color: "muted", text: ` ${object}` });
    const parameterStart = parts.reduce((length, part) => length + part.text.length, 0) + 1;
    if (params) parts.push({ color: "dim", text: ` ${params}` });
    const error = failed ? node.result?.content.find((item) => item.type === "text")?.text?.split(/[\r\n]/u)[0] : undefined;
    if (error) parts.push({ color: "toolTitle", text: ` — ${truncateToWidth(sanitize(error).trim(), 180)}` });
    parts.push({ text: " " }, { color: statusColor, text: marker });
    // Layout plain text before styling. Pi 1.0.0's ANSI word wrapper mistakes
    // colored whitespace for content, adding padding or empty content rows.
    const plain = parts.map((part) => part.text).join("");
    let end = 0;
    const spans = parts.map((part) => { const start = end; end += part.text.length; return { ...part, start, end }; });
    let cursor = 0;
    return wrapSummary(plain, width - 3, parameterStart, params.length).map((line, index) => {
      const start = plain.indexOf(line, cursor);
      if (start < 0) throw new Error("Wrapped text is not a source substring");
      cursor = start + line.length;
      const styled = spans.map((span) => {
        const from = Math.max(start, span.start), to = Math.min(cursor, span.end);
        if (from >= to) return "";
        const text = plain.slice(from, to);
        return span.color ? theme.fg(span.color, text) : text;
      }).join("");
      return (index === 0 ? prefix : "   ") + styled;
    });
  }
  function nativeRows(node: Component, width: number): string[] {
    const render = candidate(node) ? patches.get(Object.getPrototypeOf(node))?.render.value as Render | undefined : undefined;
    return render ? render.call(node as ToolNode, width) : node.render(width);
  }
  function previousLayout(node: ToolNode, width: number) {
    const position = parents.get(node);
    const siblings = position?.parent.children ?? [];
    let current = position?.index ?? -1;
    if (siblings[current] !== node) { current = siblings.indexOf(node); if (position) position.index = current; }
    for (let index = current - 1; index >= 0; index--) {
      const previous = siblings[index];
      if (width > 0 && bashCard(previous, width)) return { compact: false, tool: true, height: 3 };
      if (compact(previous, width)) return { compact: true, tool: true, height: summaryLayout(previous, width).length };
      const lines = nativeRows(previous, width);
      if (lines.length) return { compact: false, tool: candidate(previous), height: lines.length - (lines[0] === "" ? 1 : 0) };
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
          const rows = bashLayout(this, width).rows;
          if (!rows.length) return rows;
          return previousLayout(this, width) ? ["", ...rows] : rows;
        }
        if (!eligible(this)) {
          const lines = originalRender.call(this, width);
          return nativeGap(this, width, lines) ? ["", ...lines] : lines;
        }
        if (width < 1) return [];
        if (this.getRenderShell() === "self") {
          const lines = originalRender.call(this, width);
          if (!lines.length) return lines;
        }
        return [...Array(gap(this, width)).fill(""), ...summaryLayout(this, width)];
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
      if (!compact(this, event.width)) {
        const offset = nativeGap(this, event.width, originalRender.call(this, event.width));
        if (event.y < offset) return undefined;
        return originalMouse.call(this, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
      }
      const offset = gap(this, event.width);
      if (!this.result || this.isPartial || event.type !== "click" || event.button !== "left" ||
        event.y < offset || event.y >= offset + summaryLayout(this, event.width).length) return undefined;
      this.setExpanded(true);
      tui.requestRender();
      return { handled: true };
    };
    const updates = ["updateArgs", "updateResult", "setExpanded", "invalidate"].map((name) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      const method = (prototype as Record<string, unknown>)[name];
      if (typeof method !== "function" || (original && (!original.writable || !original.configurable)) || (!original && !Object.isExtensible(prototype)))
        throw new Error("Tool cache invalidation methods cannot be wrapped");
      const wrapper = function (this: ToolNode, ...args: unknown[]) {
        // Bash keys include every displayed argument; unrelated/same argument updates reuse its body.
        if (!(name === "updateArgs" && this.toolName === "bash" && !overrides.has("bash")) &&
          !(name === "setExpanded" && args[0] === this.expanded)) forget(this);
        return method.apply(this, args);
      };
      return { name, original, wrapper };
    });
    patches.set(prototype, { render, mouse, patchedRender, patchedMouse, updates });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    Object.defineProperty(prototype, "handleMouse", { ...mouse, value: patchedMouse });
    for (const update of updates) Object.defineProperty(prototype, update.name,
      { configurable: true, writable: true, ...update.original, value: update.wrapper });
  }
  function visit(node: Component, parent?: Container, index = -1) {
    if (!active) return;
    if (candidate(node)) {
      if (parent) parents.set(node, { parent, index });
      install(node);
    }
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
  pi.registerFlag("toolview-cache-mb", { type: "string", description: "Retained render-cache budget in MiB (0–64; default 8)" });
  let cacheMiB: number | undefined;
  function cacheLimit(text: string): number {
    const value = Number(text);
    if (!text.trim() || !Number.isFinite(value) || value < 0 || value > 64) throw new RangeError("Cache limit must be 0–64 MiB");
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
    // A public widget factory exposes the actual live tree, including bundled CLI classes.
    // Remove the empty widget immediately: it is not part of our layout.
    ctx.ui.setWidget("pi-toolview-capture", (tui) => {
      controller = installToolview(tui, () => ctx.ui.theme, {
        cards: names("toolview-card"), compact: names("toolview-compact"), cacheMiB,
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
        } else if (words.length !== 1) {
          ctx.ui.notify("Usage: /toolview cache [clear|limit <MiB>]", "warning"); return;
        }
        ctx.ui.notify(`Pi Toolview cache: ${JSON.stringify({ ...controller.cacheStats(),
          processHeapUsedBytes: process.memoryUsage().heapUsed, processMemoryScope: "whole Pi process, not Toolview" })}`, "info");
        return;
      }
      if (command === "off") { enabled = false; controller?.restore(); }
      else if (command === "on") { enabled = true; start(ctx); }
      else if (command !== "status") { ctx.ui.notify("Usage: /toolview on|off|status|cache [clear|limit <MiB>]", "warning"); return; }
      const status = controller?.active ? "on" : ctx.mode !== "tui" ? "unavailable outside terminal mode" : controller?.reason ?? "off";
      ctx.ui.notify(`Pi Toolview: ${status}`, "info");
    },
  });
}
