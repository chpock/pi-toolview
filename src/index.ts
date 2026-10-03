import type { ExtensionAPI, ExtensionContext, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, truncateToWidth, wrapTextWithAnsi, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";

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
  result?: { content: { type: string; text?: string }[]; isError?: boolean };
  updateArgs(args: unknown): void;
  updateResult(result: unknown, partial?: boolean): void;
  setExpanded(expanded: boolean): void;
  getRenderContext(): unknown;
  getRenderShell(): string;
}
type LiveTui = Component & { requestRender(): void };
type Palette = { fg(color: ThemeColor, text: string): string };
type Render = (this: ToolNode, width: number) => string[];
type Mouse = (this: ToolNode, event: TuiMouseEvent) => TuiMouseEventResult | undefined;

export interface ToolviewOptions {
  cards?: readonly string[];
  compact?: readonly string[];
  warn?: (reason: string) => void;
}
export interface ToolviewController {
  readonly active: boolean;
  readonly reason: string | undefined;
  restore(): void;
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

/** The only compatibility-sensitive adapter. It does not change tools or session entries. */
export function installToolview(tui: LiveTui, getTheme: () => Palette, options: ToolviewOptions = {}): ToolviewController {
  let active = false;
  let reason: string | undefined;
  const parents = new WeakMap<Component, Container>();
  const cards = new Set([...DEFAULT_CARDS, ...options.cards ?? []]);
  const overrides = new Set(options.compact ?? []);
  const originalAdd = Container.prototype.addChild;
  const patches = new Map<object, {
    render: PropertyDescriptor; mouse: PropertyDescriptor; patchedRender: Render; patchedMouse: Mouse;
  }>();

  const refresh = () => { tui.invalidate(); tui.requestRender(); };
  const controller: ToolviewController = {
    get active() { return active; },
    get reason() { return reason; },
    restore() {
      if (!active && !patches.size) return;
      active = false;
      if (Container.prototype.addChild === patchedAdd) Container.prototype.addChild = originalAdd;
      for (const [prototype, patch] of patches) {
        if (Object.getOwnPropertyDescriptor(prototype, "render")?.value === patch.patchedRender)
          Object.defineProperty(prototype, "render", patch.render);
        if (Object.getOwnPropertyDescriptor(prototype, "handleMouse")?.value === patch.patchedMouse)
          Object.defineProperty(prototype, "handleMouse", patch.mouse);
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

  function summaryRows(node: ToolNode, width: number): string[] {
    if (width < 1) return [];
    const theme = getTheme();
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
    return wrapTextWithAnsi(plain, width - 3).map((line, index) => {
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
    const siblings = parents.get(node)?.children ?? [];
    for (let index = siblings.indexOf(node) - 1; index >= 0; index--) {
      const previous = siblings[index];
      if (compact(previous, width)) return { compact: true, tool: true, height: summaryRows(previous, width).length };
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
    const prototype = Object.getPrototypeOf(node) as object;
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
        if (!eligible(this)) {
          const lines = originalRender.call(this, width);
          return nativeGap(this, width, lines) ? ["", ...lines] : lines;
        }
        if (width < 1) return [];
        if (this.getRenderShell() === "self") {
          const lines = originalRender.call(this, width);
          if (!lines.length) return lines;
        }
        return [...Array(gap(this, width)).fill(""), ...summaryRows(this, width)];
      }
      catch { fail("Toolview could not render this component; native rendering restored"); return originalRender.call(this, width); }
    };
    const patchedMouse: Mouse = function (event) {
      if (!compact(this, event.width)) {
        const offset = nativeGap(this, event.width, originalRender.call(this, event.width));
        if (event.y < offset) return undefined;
        return originalMouse.call(this, offset ? { ...event, y: event.y - offset, height: event.height - offset } : event);
      }
      const offset = gap(this, event.width);
      if (!this.result || this.isPartial || event.type !== "click" || event.button !== "left" ||
        event.y < offset || event.y >= offset + summaryRows(this, event.width).length) return undefined;
      this.setExpanded(true);
      tui.requestRender();
      return { handled: true };
    };
    patches.set(prototype, { render, mouse, patchedRender, patchedMouse });
    Object.defineProperty(prototype, "render", { ...render, value: patchedRender });
    Object.defineProperty(prototype, "handleMouse", { ...mouse, value: patchedMouse });
  }
  function visit(node: Component, parent?: Container) {
    if (!active) return;
    if (parent) parents.set(node, parent);
    if (candidate(node)) install(node);
    if (node instanceof Container) for (const child of node.children) visit(child, node);
  }
  function patchedAdd(this: Container, child: Component) {
    originalAdd.call(this, child);
    // A whole prebuilt subtree can be attached during history reconstruction.
    visit(child, this);
  }

  if (!(tui instanceof Container) || typeof tui.requestRender !== "function") {
    fail("The live Pi TUI does not share the host Container; native rendering retained");
    return controller;
  }
  try {
    active = true;
    visit(tui);
    if (active) { Container.prototype.addChild = patchedAdd; refresh(); }
  } catch {
    fail("Toolview could not install its UI hooks; native rendering restored");
  }
  return controller;
}

export default function toolview(pi: ExtensionAPI) {
  pi.registerFlag("toolview-card", { type: "string", description: "Additional comma-separated tool names that retain native cards" });
  pi.registerFlag("toolview-compact", { type: "string", description: "Comma-separated tool names that use compact summaries instead of native cards" });
  let controller: ToolviewController | undefined;
  let enabled = true;
  const names = (flag: string) => String(pi.getFlag(flag) ?? "").split(",").map((name) => name.trim()).filter(Boolean);
  function start(ctx: ExtensionContext) {
    if (ctx.mode !== "tui" || !enabled || controller?.active) return;
    // A public widget factory exposes the actual live tree, including bundled CLI classes.
    // Remove the empty widget immediately: it is not part of our layout.
    ctx.ui.setWidget("pi-toolview-capture", (tui) => {
      controller = installToolview(tui, () => ctx.ui.theme, {
        cards: names("toolview-card"), compact: names("toolview-compact"),
        warn: (message) => ctx.ui.notify(`Pi Toolview disabled: ${message}`, "warning"),
      });
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("pi-toolview-capture", undefined);
  }
  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", () => { controller?.restore(); controller = undefined; });
  pi.registerCommand("toolview", {
    description: "Control tool presentation: on, off, status",
    handler: async (args, ctx) => {
      const command = args.trim() || "status";
      if (command === "off") { enabled = false; controller?.restore(); }
      else if (command === "on") { enabled = true; start(ctx); }
      else if (command !== "status") { ctx.ui.notify("Usage: /toolview on|off|status", "warning"); return; }
      const status = controller?.active ? "on" : ctx.mode !== "tui" ? "unavailable outside terminal mode" : controller?.reason ?? "off";
      ctx.ui.notify(`Pi Toolview: ${status}`, "info");
    },
  });
}
