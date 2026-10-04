import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import xterm from "@xterm/headless";
import { Container, Text, visibleWidth, parseColor, TuiAltScreen, TuiMainScreen, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolview, { installToolview, describeArgs, sanitize, type ToolviewOptions } from "../src/index.ts";
import { cardGeometry, frameRows, insidePanel } from "../src/card-frame.ts";
import type { CardTheme } from "../src/card-theme.ts";
import { RenderCache } from "../src/render-cache.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
class Root extends Container {
  requests = 0;
  selection = false;
  listeners = new Set<(data: string) => unknown>();
  constructor() { super(); this.addInputListener((data) => this.handleViewportInput(data)); }
  handleViewportInput(_data: string): unknown { return undefined; }
  requestRender() { this.requests++; }
  hasActiveSelection() { return this.selection; }
  addInputListener(listener: (data: string) => unknown) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  input(data: string) {
    const results: unknown[] = [];
    for (const listener of this.listeners) {
      const result = listener(data); results.push(result);
      if ((result as { consume?: boolean } | undefined)?.consume) break;
    }
    return results;
  }
}
class Tool extends Container {
  toolCallId = "test-id";
  toolName: string;
  args: Record<string, unknown>;
  expanded = false;
  hideComponent = false;
  isPartial = false;
  executionStarted = true;
  argsComplete = true;
  result: { content: { type: string; text?: string }[]; isError?: boolean; details?: unknown; structuredContent?: unknown } | undefined =
    { content: [{ type: "text", text: "FULL_OUTPUT" }] };
  constructor(name = "read", args: Record<string, unknown> = { path: "a.txt" }) {
    super(); this.toolName = name; this.args = args;
  }
  updateResult(result: Tool["result"], partial = false) { this.result = result; this.isPartial = partial; }
  updateArgs(args: Record<string, unknown>) { this.args = args; }
  setExpanded(value: boolean) { this.expanded = value; }
  getRenderContext() { return { cwd: "/project" }; }
  getRenderShell() { return "default"; }
  render(_width: number): string[] { return this.hideComponent ? [] : ["", `NATIVE ${this.toolName}`, "FULL_OUTPUT"]; }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "click" && event.button === "left" && event.y > 0) {
      this.setExpanded(!this.expanded); return { handled: true as const, target: {
        component: this, originX: event.screenX - event.x, originY: event.screenY - event.y,
        width: event.width, height: event.height,
      } };
    }
    return undefined;
  }
}
const color = { fg: (_name: string, text: string) => text };
function setup(children: (Container | Text | Tool)[] = [], options: ToolviewOptions = {}) {
  const root = new Root();
  for (const child of children) root.addChild(child);
  const original = Tool.prototype.render;
  const addChild = Container.prototype.addChild;
  const controller = installToolview(root, () => color, options);
  return { root, controller, original, addChild };
}
function mouse(y: number, width = 80): TuiMouseEvent {
  return { type: "click", button: "left", x: 4, y, screenX: 4, screenY: y,
    width, height: 20, shift: false, alt: false, ctrl: false };
}

test("adjacent summaries skip empty siblings but separate visible text and cards", () => {
  const first = new Tool(), second = new Tool("grep", { pattern: "needle", path: "src" });
  const bash = new Tool("bash"), third = new Tool("read", { path: "b.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), first, new Text("", 0, 0), second, bash, third]);
  try {
    assert.equal(controller.active, true);
    const rows = root.render(80).map(plain);
    const index = rows.findIndex((line) => line.includes("read a.txt"));
    assert.match(rows[index + 1], /grep.*needle.*src/);
    assert.equal(rows[index - 1], "");
    assert.equal(third.render(80)[0], "");
    assert.deepEqual(bash.render(80), ["", "NATIVE bash", "FULL_OUTPUT"]);
  } finally { controller.restore(); }
});

test("summaries at transcript start need no leading gap; new attached subtrees are visited", () => {
  const { root, controller } = setup();
  try {
    const branch = new Container(), first = new Tool(), second = new Tool("custom", { query: "item" });
    branch.addChild(first); branch.addChild(second); root.addChild(branch);
    assert.equal(first.render(80).length, 1);
    assert.equal(second.render(80).length, 1);
    assert.match(root.render(80)[1], /custom.*item/);
  } finally { controller.restore(); }
});

test("rich, image, hidden and expanded tools delegate exactly", () => {
  const tools = ["bash", "powershell", "write", "edit"].map((name) => new Tool(name));
  const image = new Tool(); image.result = { content: [{ type: "image" }] };
  const expanded = new Tool(); expanded.expanded = true;
  const hidden = new Tool(); hidden.hideComponent = true;
  const { controller, original } = setup([...tools, image, expanded, hidden]);
  try {
    for (const tool of [...tools, image, expanded, hidden]) assert.deepEqual(tool.render(80), original.call(tool, 80));
  } finally { controller.restore(); }
});

test("pending, partial, success and errors are distinguishable without full output", () => {
  const tool = new Tool();
  const { controller } = setup([tool]);
  try {
    tool.result = undefined; tool.isPartial = true;
    assert.match(plain(tool.render(80).at(-1)!), /…$/);
    tool.result = { content: [{ type: "text", text: "PARTIAL_OUTPUT" }] };
    assert.match(plain(tool.render(80).at(-1)!), /…$/);
    tool.isPartial = false;
    assert.match(plain(tool.render(80).at(-1)!), /✓$/);
    assert.doesNotMatch(tool.render(80).join(""), /PARTIAL_OUTPUT/);
    tool.result = { isError: true, content: [{ type: "text", text: "ENOENT: missing file\nstack details" }] };
    assert.match(plain(tool.render(80).at(-1)!), /ENOENT: missing file.*✗$/);
    assert.doesNotMatch(tool.render(80).join(""), /stack details/);
  } finally { controller.restore(); }
});

test("status survives wrapping and Unicode at every usable width", () => {
  const tool = new Tool("read", { path: "文件/🦀/é".repeat(20) });
  const { controller } = setup([tool]);
  try {
    for (let width = 1; width < 81; width++) {
      const rows = tool.render(width);
      const line = rows.at(-1)!;
      for (const row of rows) assert.ok(visibleWidth(row) <= width, `${width}: ${visibleWidth(row)}`);
      assert.match(plain(line), /✓$/);
    }
    assert.deepEqual(tool.render(0), []);
  } finally { controller.restore(); }
});

test("terminal controls, multiline text and bidi formatting cannot escape the summary", () => {
  assert.equal(sanitize("a\n\r\tb\x1b[31mRED\x1b[0m\x07\u202e"), "a bRED");
  const tool = new Tool("custom\nname", { query: "hello\x1b]0;bad\x07\nworld\x9b2J" });
  const { controller } = setup([tool]);
  try {
    assert.equal(tool.render(80).length, 1);
    assert.doesNotMatch(tool.render(80)[0], /[\x00-\x1f\x7f-\x9f\u202e]/);
  } finally { controller.restore(); }
});

test("generic descriptions retain useful fields and omit known bulky payloads", () => {
  assert.match(describeArgs("read", { path: "file", offset: 5, limit: 10 }), /file.*5.*10/);
  assert.match(describeArgs("grep", { pattern: "abc", path: "src" }), /abc.*src/);
  assert.match(describeArgs("aft_zoom", { path: "a.ts", symbols: ["first", "second"] }), /a.ts.*first.*second/);
  assert.match(describeArgs("strange", { mode: "fast", kind: "thing" }), /mode.*fast/);
  assert.ok(describeArgs("strange", { content: "PAYLOAD".repeat(1000) }).length < 300);
  assert.equal(describeArgs("read", {}), "");
});

test("policy overrides are exact names and compact wins", () => {
  const tools = [new Tool("read"), new Tool("custom"), new Tool("bash"), new Tool("custom_extra")];
  const { controller } = setup(tools, { cards: ["custom", "bash"], compact: ["bash"] });
  try {
    assert.equal(tools[0].render(80).length, 1);
    assert.match(tools[1].render(80)[1], /NATIVE/);
    assert.match(tools[2].render(80).at(-1)!, /bash.*✓/);
    assert.match(tools[3].render(80).at(-1)!, /custom_extra.*✓/);
  } finally { controller.restore(); }
});

test("mouse dispatch uses rendered summary heights and ignores gaps, pending calls and wheel", () => {
  const first = new Tool(), second = new Tool("read", { path: "b.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), first, second]);
  try {
    root.render(80);
    assert.equal(root.handleMouse(mouse(1)), undefined); // separating row
    assert.equal(first.expanded, false);
    assert.ok(root.handleMouse(mouse(3))?.handled);
    assert.equal(first.expanded, false); assert.equal(second.expanded, true);
    assert.match(second.render(80)[1], /NATIVE/);
    second.handleMouse(mouse(1)); assert.equal(second.expanded, false);
    first.isPartial = true;
    assert.equal(first.handleMouse(mouse(1)), undefined);
    assert.equal(first.handleMouse({ ...mouse(1), type: "wheel", wheelDelta: -1 }), undefined);
  } finally { controller.restore(); }
});

test("theme is read during rendering instead of captured at installation", () => {
  const root = new Root(), tool = new Tool(); root.addChild(tool);
  let prefix = "A";
  const controller = installToolview(root, () => ({ fg: (_color, text) => `${prefix}${text}` }));
  try {
    const before = tool.render(80).join(""); prefix = "B";
    const after = tool.render(80).join("");
    assert.notEqual(before, after); assert.match(after, /B/);
  } finally { controller.restore(); }
});

test("restoration is idempotent; re-enabling covers existing and future tools", () => {
  const tool = new Tool();
  const { root, controller, original, addChild } = setup([tool]);
  controller.restore(); controller.restore();
  assert.equal(controller.active, false);
  assert.equal(Tool.prototype.render, original);
  assert.equal(Container.prototype.addChild, addChild);
  const second = installToolview(root, () => color);
  try {
    const future = new Tool(); root.addChild(future);
    assert.match(future.render(80).at(-1)!, /✓/);
  } finally { second.restore(); }
});

test("restoration does not overwrite methods subsequently replaced by another extension", () => {
  const { controller, original, addChild } = setup([new Tool()]);
  const patched = Tool.prototype.render;
  const replacement = function () { return ["OTHER"]; };
  Tool.prototype.render = replacement;
  try {
    controller.restore();
    assert.equal(Tool.prototype.render, replacement);
    assert.equal(Container.prototype.addChild, addChild);
  } finally {
    assert.notEqual(patched, original);
    Tool.prototype.render = original;
  }
});

test("incompatible existing or future tool contract restores all owned hooks and warns", () => {
  const warnings: string[] = [];
  const bad = new Tool(); Object.defineProperty(bad, "expanded", { value: "not-a-boolean" });
  const { controller, original, addChild } = setup([bad], { warn: (reason) => warnings.push(reason) });
  assert.equal(controller.active, false);
  assert.equal(Tool.prototype.render, original);
  assert.equal(Container.prototype.addChild, addChild);
  assert.equal(warnings.length, 1);
  const live = setup([new Tool()], { warn: (reason) => warnings.push(reason) });
  live.root.addChild(bad);
  assert.equal(live.controller.active, false);
  assert.equal(Tool.prototype.render, original);
  assert.equal(Container.prototype.addChild, addChild);
  assert.equal(warnings.length, 2);
});

test("foreign TUI instance is left untouched with a compatibility warning", () => {
  const warnings: string[] = [];
  const controller = installToolview({} as Root, () => color, { warn: (reason) => warnings.push(reason) });
  assert.equal(controller.active, false);
  assert.equal(warnings.length, 1);
});

test("frozen tool prototypes fail safely without partially installing hooks", () => {
  class Frozen extends Tool { render(width: number) { return super.render(width); } handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); } }
  Object.freeze(Frozen.prototype);
  const warnings: string[] = [];
  const before = Container.prototype.addChild;
  const root = new Root(); root.addChild(new Tool()); root.addChild(new Frozen());
  const original = Tool.prototype.render;
  const controller = installToolview(root, () => color, { warn: (reason) => warnings.push(reason) });
  assert.equal(controller.active, false);
  assert.equal(Container.prototype.addChild, before);
  assert.equal(Tool.prototype.render, original);
  assert.equal(warnings.length, 1);
});

function extensionHarness(mode: "tui" | "print" | "json" | "rpc" = "tui", flagValues: Record<string, string> = {}) {
  const root = new Root(); root.addChild(new Tool());
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const flags = new Map<string, unknown>();
  const widgets: string[] = [], notices: string[] = [];
  const api = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => events.set(name, handler),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag: (name: string, options: unknown) => flags.set(name, options),
    getFlag: (name: string) => flagValues[name],
  } as unknown as ExtensionAPI;
  const ctx = { mode, ui: {
    theme: color,
    notify: (text: string) => notices.push(text),
    setWidget: (name: string, factory?: (tui: Root) => unknown) => { widgets.push(name); factory?.(root); },
  } } as unknown as ExtensionContext;
  toolview(api);
  return { root, ctx, events, commands, flags, widgets, notices };
}

test("extension lifecycle removes the temporary widget, restores on shutdown, and does not stack", async () => {
  const h = extensionHarness();
  const before = Container.prototype.addChild;
  try {
    h.events.get("session_start")!({}, h.ctx);
    const installed = Container.prototype.addChild;
    assert.notEqual(installed, before);
    h.events.get("session_start")!({}, h.ctx);
    assert.equal(Container.prototype.addChild, installed);
    assert.equal(h.widgets.length, 2); // capture then remove; no permanent layout widget
    assert.deepEqual([...h.flags.keys()], ["toolview-card", "toolview-compact", "toolview-cache-mb"]);
    await h.commands.get("toolview")!.handler("off", h.ctx);
    assert.equal(Container.prototype.addChild, before);
    await h.commands.get("toolview")!.handler("on", h.ctx);
    assert.notEqual(Container.prototype.addChild, before);
    assert.match(h.root.render(80).at(-1)!, /read.*✓/);
    await h.commands.get("toolview")!.handler("invalid", h.ctx);
    assert.match(h.notices.at(-1)!, /Usage:/);
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
  assert.equal(Container.prototype.addChild, before);
});

test("off persists across session replacements but a reload creates a fresh enabled runtime", async () => {
  const h = extensionHarness(); const before = Container.prototype.addChild;
  h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("toolview")!.handler("off", h.ctx);
  h.events.get("session_shutdown")!({}, h.ctx);
  h.events.get("session_start")!({}, h.ctx);
  assert.equal(Container.prototype.addChild, before);
  const fresh = extensionHarness();
  try {
    fresh.events.get("session_start")!({}, fresh.ctx);
    assert.notEqual(Container.prototype.addChild, before);
  } finally { fresh.events.get("session_shutdown")!({}, fresh.ctx); }
});

test("print, JSON and RPC modes install no UI hooks or widgets", async () => {
  const before = Container.prototype.addChild;
  for (const mode of ["print", "json", "rpc"] as const) {
    const h = extensionHarness(mode);
    h.events.get("session_start")!({}, h.ctx);
    await h.commands.get("toolview")!.handler("on", h.ctx);
    assert.equal(h.widgets.length, 0);
    assert.equal(Container.prototype.addChild, before);
    assert.match(h.notices.at(-1)!, /unavailable outside terminal mode/);
    h.events.get("session_shutdown")!({}, h.ctx);
  }
});

test("empty self-rendered tools remain hidden even when hideComponent is false and compact is forced", () => {
  class SelfTool extends Tool {
    getRenderShell() { return "self"; }
    render(width: number) { return this.expanded || width < 30 ? ["NATIVE SELF"] : []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new SelfTool("self_hidden"), next = new Tool();
  const { root, controller } = setup([new Text("User", 0, 0), hidden, next], { compact: ["self_hidden"] });
  try {
    assert.equal(hidden.hideComponent, false); // native visibility is not represented by this field
    assert.deepEqual(hidden.render(80), []);
    assert.equal(root.render(80).some((line) => line.includes("self_hidden")), false);
    assert.equal(next.render(80)[0], ""); // separation still follows the preceding visible user text
    assert.match(hidden.render(24).at(-1)!, /self_hidden.*✓/); // visibility can depend on width
    hidden.expanded = true;
    assert.deepEqual(hidden.render(80), ["NATIVE SELF"]);
  } finally { controller.restore(); }
});

test("read summaries use distinct semantic roles and bracket only non-path parameters", () => {
  const root = new Root(), tool = new Tool("read", { path: "a.txt", offset: 5, limit: 10 });
  root.addChild(tool);
  const parts: { color: string; text: string }[] = [];
  const controller = installToolview(root, () => ({ fg: (color, text) => { parts.push({ color, text }); return text; } }));
  try {
    assert.equal(tool.render(120).at(-1), " → read a.txt [offset=5, limit=10] ✓");
    assert.deepEqual(parts, [
      { color: "dim", text: " → " },
      { color: "toolTitle", text: "read" },
      { color: "muted", text: " a.txt" },
      { color: "dim", text: " [offset=5, limit=10]" },
      { color: "success", text: "✓" },
    ]);
  } finally { controller.restore(); }
});

test("read without parameters has no empty brackets; patterns are primary descriptions", () => {
  const read = new Tool(), grep = new Tool("grep", { pattern: "needle", path: "src" });
  const { controller } = setup([read, grep]);
  try {
    assert.equal(read.render(120).at(-1), " → read a.txt ✓");
    assert.equal(grep.render(120).at(-1), ' → grep "needle" in src ✓');
  } finally { controller.restore(); }
});

test("colored summary wrapping preserves a state marker and terminal-width bounds", () => {
  const root = new Root(), tool = new Tool("read", { path: "文件/🦀/é".repeat(20), offset: 5, limit: 100 });
  root.addChild(tool);
  const controller = installToolview(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    const color = colors[role] ?? 31;
    return `\x1b[${color}m${text}\x1b[39m`;
  } }));
  try {
    for (let width = 1; width <= 80; width++) {
      const rows = tool.render(width);
      const line = rows.at(-1)!;
      for (const row of rows) assert.ok(visibleWidth(row) <= width);
      assert.match(plain(line), /✓$/);
    }
  } finally { controller.restore(); }
});

test("standardized summaries cover active tool argument shapes without tool-name heuristics", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["read", { limit: 10, path: "src/app.ts", offset: 5 }, 'src/app.ts [offset=5, limit=10]'],
    ["grep", { include: "*.ts", path: "src", pattern: "needle" }, '"needle" in src [include="*.ts"]'],
    ["custom", { pattern: "", path: "", target: "other", query: "why" }, '"" [path="", target="other", query="why"]'],
    ["aft_search", { includeTests: false, query: "where is auth", path: "/repo" }, '/repo [query="where is auth", includeTests=false]'],
    ["aft_outline", { target: ["src", "tests"], files: true }, '[target=["src","tests"], files=true]'],
    ["aft_inspect", { sections: "diagnostics", scope: ["src", "tests"] }, '[scope=["src","tests"], sections="diagnostics"]'],
    ["aft_zoom", { path: "a.ts", symbols: ["render", "update"], callgraph: true }, 'a.ts [symbols=["render","update"], callgraph=true]'],
    ["aft_callgraph", { depth: 2, symbol: "render", path: "a.ts", op: "callers" }, 'a.ts [op="callers", symbol="render", depth=2]'],
    ["ast_grep_search", { paths: ["src"], lang: "typescript", pattern: "$X($$$)" }, '"$X($$$)" [paths=["src"], lang="typescript"]'],
    ["ast_grep_replace", { rewrite: "BULKY", pattern: "foo()", lang: "typescript" }, '"foo()" [lang="typescript"]'],
    ["TaskCreate", { description: "Investigate", subject: "Rendering" }, '[subject="Rendering", description="Investigate"]'],
    ["TaskUpdate", { status: "completed", taskId: "1" }, '[status="completed", taskId="1"]'],
    ["Agent", { prompt: "BULKY", subagent_type: "reviewer", description: "Review" }, '[description="Review", subagent_type="reviewer"]'],
    ["ctx_memory", { content: "BULKY", category: "CONSTRAINTS", action: "write" }, '[action="write", category="CONSTRAINTS"]'],
    ["web_search", { numResults: 5, queries: ["one", "two"] }, '[queries=["one","two"], numResults=5]'],
    ["fetch_content", { url: "https://example.com", prompt: "BULKY", mode: "answer" }, 'https://example.com [mode="answer"]'],
    ["aft_safety", { name: "snap", op: "checkpoint", files: ["src/a.ts"] }, '[op="checkpoint", files=["src/a.ts"], name="snap"]'],
    ["custom", { pattern: null, path: { id: 1 }, target: "valid", zero: 0, flag: false, empty: "", nullable: null }, 'valid [path={"id":1}, empty="", flag=false, nullable=null, pattern=null, zero=0]'],
    ["custom", { url: "https://example.com", target: "target", path: "first" }, 'first [target="target", url="https://example.com"]'],
    ["custom", { path: "my file.ts", "odd key": [false, 0, null] }, '"my file.ts" ["odd key"=[false,0,null]]'],
    ["TaskList", {}, ''],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(describeArgs(name, args), expected, name);
    assert.equal(describeArgs("entirely_unknown", args), expected, "same rules for any tool name");
  }
});

test("payload suppression and exact top-level masking preserve remaining structure and source data", () => {
  const args = { content: "PAYLOAD", edits: [], code: "PAYLOAD", input: "PAYLOAD", messages: [],
    prompt: "PAYLOAD", newString: "PAYLOAD", oldString: "PAYLOAD", appendContent: "PAYLOAD",
    rewrite: "PAYLOAD", oldText: "PAYLOAD", newText: "PAYLOAD", api_key: "SECRET", password: "SECRET",
    Authorization: "SECRET", apiKey: "SECRET", token: "SECRET", maxTokens: 0,
    nested: { content: "visible", text: "a\nb" }, query: "a\nb", omitted: undefined };
  const before = structuredClone(args);
  const output = describeArgs("custom", args);
  assert.doesNotMatch(output, /PAYLOAD|SECRET|omitted/);
  assert.match(output, /api_key="<redacted>"/);
  assert.match(output, /Authorization="<redacted>"/);
  assert.match(output, /maxTokens=0/);
  assert.match(output, /nested=\{"content":"visible","text":"a b"\}/);
  assert.match(output, /^\[query="a b"/);
  assert.deepEqual(args, before);
});

test("multiline summaries retain all parameters, align to tool name and recompute separator height", () => {
  const short = new Tool(), long = new Tool("custom", { z: "last", query: "x".repeat(220), enabled: false, limit: 0 });
  const hidden = new Tool(); hidden.hideComponent = true;
  const next = new Tool("read", { path: "b.txt" }), last = new Tool("read", { path: "c.txt" });
  const { root, controller } = setup([new Text("User", 0, 0), short, long, hidden, new Text("", 0, 0), next, last]);
  try {
    assert.equal(short.render(40)[0], "");
    const rows = long.render(40).map(plain);
    assert.ok(rows.length > 2);
    assert.ok(rows[0].startsWith(" → custom"));
    assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row[3] !== " "));
    for (const row of rows) assert.ok(visibleWidth(row) <= 40);
    const joined = rows.map((row) => row.slice(3)).join("");
    assert.match(joined, /x{220}/); // no previous 180-column argument cap
    for (const key of ['query=', 'limit=0', 'enabled=false', 'z="last"']) assert.ok(joined.includes(key), key);
    assert.match(joined, /\] ✓$/);
    assert.equal(next.render(40)[0], "");
    assert.equal(last.render(40).length, 1); // next's leading separator is not content
    assert.notEqual(root.render(40).at(-1), "");
    assert.equal(long.render(1000).length, 1);
    assert.equal(next.render(1000).length, 1);
    assert.equal(next.render(40)[0], "");
  } finally { controller.restore(); }
});

test("clicks on continuation rows expand only that call; adaptive separator rows are not clickable", () => {
  const first = new Tool(), long = new Tool("custom", { query: "x".repeat(80) }), next = new Tool();
  const { root, controller } = setup([first, long, next]);
  try {
    root.render(24);
    const height = long.render(24).length;
    assert.ok(height > 1);
    assert.equal(root.handleMouse(mouse(1 + height, 24)), undefined); // next's leading gap
    assert.equal(long.expanded, false); assert.equal(next.expanded, false);
    assert.ok(root.handleMouse(mouse(2, 24))?.handled); // long's second content row
    assert.equal(first.expanded, false); assert.equal(long.expanded, true); assert.equal(next.expanded, false);
  } finally { controller.restore(); }
});

test("native self cards get only a missing separator after multiline calls and adjusted mouse coordinates", () => {
  class NativeSelf extends Tool {
    received: number | undefined;
    getRenderShell() { return "self"; }
    render(_width: number) { return ["SELF CARD"]; }
    handleMouse(event: TuiMouseEvent) {
      this.received = event.y;
      return { handled: true as const, target: { component: this, originX: event.screenX - event.x,
        originY: event.screenY - event.y, width: event.width, height: event.height } };
    }
  }
  const long = new Tool("custom", { query: "x".repeat(80) }), card = new NativeSelf("native_self");
  const bash = new Tool("bash");
  const { controller } = setup([long, card, bash], { cards: ["native_self"] });
  try {
    assert.deepEqual(card.render(24), ["", "SELF CARD"]);
    assert.equal(card.handleMouse(mouse(0, 24)), undefined);
    assert.ok(card.handleMouse(mouse(1, 24))?.handled);
    assert.equal(card.received, 0);
    assert.deepEqual(bash.render(24), ["", "NATIVE bash", "FULL_OUTPUT"]);
    assert.deepEqual(card.render(200), ["SELF CARD"]);
  } finally { controller.restore(); }
});

test("quoting preserves edge spaces, escapes punctuation and handles non-JSON values visibly", () => {
  assert.equal(describeArgs("custom", { path: " file " }), '" file "');
  assert.equal(describeArgs("custom", { path: 'a"b\\c', query: 'a"b\\c' }), '"a\\"b\\\\c" [query="a\\"b\\\\c"]');
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.equal(describeArgs("custom", { query: cyclic }), '[query="[unavailable]"]');
  assert.equal(describeArgs("custom", { target: [], pattern: 0 }), '[target=[], pattern=0]');
  assert.equal(describeArgs("custom", { scope: "src", paths: ["tests"], url: null }), 'src [paths=["tests"], url=null]');
});

test("primary locations require a nonempty string and otherwise lead named parameters", () => {
  for (const key of ["path", "target", "url", "scope"]) {
    assert.equal(describeArgs("custom", { [key]: "src", query: "q" }), 'src [query="q"]');
    assert.equal(describeArgs("custom", { [key]: " src " }), '" src "');
    assert.equal(describeArgs("custom", { [key]: " " }), '" "'); // no implicit trimming
    for (const value of ["", [], ["src"], { root: "src" }, null, 0, false]) {
      const args = { query: "q", [key]: value, paths: ["first"] };
      const before = structuredClone(args);
      const expected = `[paths=["first"], ${key}=${JSON.stringify(value)}, query="q"]`;
      assert.equal(describeArgs("custom", args), expected);
      assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
      assert.deepEqual(args, before);
    }
  }
  assert.equal(describeArgs("custom", { pattern: "x", path: "", target: "other", query: "q" }), '"x" [path="", target="other", query="q"]');
  assert.equal(describeArgs("custom", { pattern: "", path: "a" }), '"" in a');
  assert.equal(describeArgs("custom", { path: [], target: "", url: "https://example.com", scope: "src", query: "q" }), 'https://example.com [path=[], target="", scope="src", query="q"]');
  const all = { query: "q", scope: null, url: "", target: [], path: "", paths: [], alpha: true };
  assert.equal(describeArgs("custom", all), '[paths=[], path="", target=[], url="", scope=null, query="q", alpha=true]');
  assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(all).reverse())), '[paths=[], path="", target=[], url="", scope=null, query="q", alpha=true]');
});

test("paths remains a named parameter and precedes every other parameter", () => {
  const cases: [Record<string, unknown>, string][] = [
    [{ paths: ["src"] }, '[paths=["src"]]'],
    [{ query: "q", paths: [] }, '[paths=[], query="q"]'],
    [{ query: "q", paths: "src", path: "a", op: "search", z: 0 }, 'a [paths="src", query="q", op="search", z=0]'],
    [{ paths: null, pattern: "x", path: ["a"], limit: 0 }, '"x" [paths=null, path=["a"], limit=0]'],
    [{ scope: [], paths: ["src"], query: "q" }, '[paths=["src"], scope=[], query="q"]'],
    [{ query: "q", paths: { root: "src" } }, '[paths={"root":"src"}, query="q"]'],
    [{ Paths: ["src"], query: "q" }, '[query="q", Paths=["src"]]'],
  ];
  for (const [args, expected] of cases) {
    const before = structuredClone(args);
    assert.equal(describeArgs("custom", args), expected);
    assert.equal(describeArgs("custom", Object.fromEntries(Object.entries(args).reverse())), expected);
    assert.deepEqual(args, before);
  }
});

test("important fields precede locale-independent alphabetical keys regardless of input order", () => {
  const first = { zebra: 1, startLine: 2, query: "q", endLine: 3, alpha: 4, Alpha: 5, symbol: "s", paths: ["src"] };
  const second = Object.fromEntries(Object.entries(first).reverse());
  const expected = '[paths=["src"], query="q", symbol="s", startLine=2, endLine=3, Alpha=5, alpha=4, zebra=1]';
  assert.equal(describeArgs("custom", first), expected);
  assert.equal(describeArgs("custom", second), expected);
  for (const key of ["password", "passwd", "api_key", "apiKey", "authorization", "Authorization", "access_token", "refresh_token", "secret", "token"]) {
    assert.equal(describeArgs("custom", { [key]: "SECRET" }), `[${key}="<redacted>"]`);
  }
  assert.equal(describeArgs("custom", { TOKEN: "ordinary", tokenLimit: 0 }), '[TOKEN="ordinary", tokenLimit=0]');
});

test("colored word-boundary wraps never add padding or blank clickable content rows", () => {
  const root = new Root(), tool = new Tool("read", { path: "abcdefghijklm", limit: 1 });
  root.addChild(tool);
  const controller = installToolview(root, () => ({ fg: (role, text) => {
    const colors: Record<string, number> = { dim: 90, muted: 37, toolTitle: 97, success: 32 };
    return `\x1b[${colors[role] ?? 31}m${text}\x1b[39m`;
  } }));
  try {
    assert.deepEqual(tool.render(21).map(plain), [' → read abcdefghijklm', '   [limit=1] ✓']);
    tool.args = { path: "abcdefghijklm", query: "x".repeat(40) };
    const rows = tool.render(21).map(plain);
    assert.ok(rows.length > 2);
    assert.ok(rows.slice(1).every((row) => row.startsWith("   ") && row[3] !== " " && row.trim()));
    assert.ok(rows.every((row) => visibleWidth(row) <= 21));
    assert.match(rows.map((row) => row.slice(3)).join(""), /x{40}/);
  } finally { controller.restore(); }
});

test("zero-width compact rendering cannot retain an adaptive separator", () => {
  const first = new Tool(), second = new Tool("read", { path: "b.txt" });
  const { controller } = setup([first, second]);
  try {
    assert.deepEqual(first.render(0), []);
    assert.deepEqual(second.render(0), []);
  } finally { controller.restore(); }
});

// Bash cards are a separate presentation, not a specialization of describeArgs.
function bashBody(tool: Tool, width = 80): string[] {
  const rows = tool.render(width).map(plain);
  if (rows[0] === "") rows.shift(); // transcript separator, not card padding
  const origin = width >= 6 ? 3 : [0, 0, 1, 2, 2, 2][width];
  const right = width >= 6 ? 2 : [0, 0, 0, 0, 1, 2][width];
  return rows.slice(1, -1).map((row) => row.slice(origin, right ? -right : undefined).trimEnd());
}
function bashTool(command = "echo hello") {
  const tool = new Tool("bash", { command });
  tool.result = { content: [] };
  return tool;
}

test("bash cards retain whole commands with no continuation alignment", () => {
  const tool = bashTool("python3 - <<'PY'\n  print('hello')\nPY");
  const source = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["$ python3 - <<'PY'", "  print('hello')", "PY"]);
    tool.args.command = "abcdefghijabcdefghij";
    assert.deepEqual(bashBody(tool, 12), ["$ abcde", "fghijab", "cdefghi", "j"]);
    tool.args.command = "a  b\n\n c";
    assert.deepEqual(bashBody(tool), ["$ a  b", "", " c"]);
    tool.args.command = source.command;
    assert.deepEqual(tool.args, source);
    assert.deepEqual(tool.render(0), []);
  } finally { controller.restore(); }
});

test("bash comments are optional, normalized and separated once from the command", () => {
  const tool = bashTool("pwd");
  tool.args.description = "Check\n\tdirectory"; tool.args.workdir = "sub/../elsewhere";
  const source = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["# Check directory", "# Running in /project/elsewhere", "", "$ pwd"]);
    assert.deepEqual(tool.args, source);
    for (const workdir of [".", "/project", "sub/..", ""]) {
      tool.args.workdir = workdir;
      assert.deepEqual(bashBody(tool), ["# Check directory", "", "$ pwd"]);
    }
    delete tool.args.description; delete tool.args.workdir;
    assert.deepEqual(bashBody(tool), ["$ pwd"]);
    tool.args.description = " \n ";
    assert.deepEqual(bashBody(tool), ["$ pwd"]);
  } finally { controller.restore(); }
});

test("bash output trims only blank edges and preserves literal service-looking text", () => {
  const tool = bashTool();
  const { controller } = setup([tool]);
  try {
    for (const text of ["", "\n \t\n", "\x1b[31m\n\x1b[0m"]) {
      tool.result = { content: [{ type: "text", text }] };
      assert.deepEqual(bashBody(tool), ["$ echo hello"]);
    }
    tool.result = { content: [{ type: "text", text: "\n  \nalpha\n\n  beta  \n \n" }] };
    const before = structuredClone(tool.result);
    assert.deepEqual(bashBody(tool), ["$ echo hello", "", "alpha", "", "  beta"]);
    assert.deepEqual(tool.result, before);
    tool.result = { content: [{ type: "text", text: "(no output)\nBackground task started: xyz\n[exit code: 7]" }], details: { exit_code: 0, task_id: "xyz" } };
    assert.deepEqual(bashBody(tool), ["$ echo hello", "", "(no output)", "Background task started: xyz", "[exit code: 7]"]);
  } finally { controller.restore(); }
});

test("bash preview is the first ten visual rows and expands only available text", () => {
  const tool = bashTool("true");
  const { controller } = setup([tool]);
  try {
    tool.result = { content: [{ type: "text", text: "X".repeat(190) }] };
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19))]);
    tool.result = { content: [{ type: "text", text: "X".repeat(191) }], details: { truncated: true, output_path: "/DO_NOT_READ" } };
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19)), "… (Click to expand)"]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(10).fill("X".repeat(19)), "X"]);
    assert.equal(tool.result.content[0].text, "X".repeat(191));
  } finally { controller.restore(); }
});

test("bash removes only an exact separated final exit-footer duplicate without rewriting results", () => {
  const tool = bashTool("false"), footer = "[exit code: 7]";
  const { controller } = setup([tool]);
  try {
    const cases: [string, unknown, boolean, boolean, string[]][] = [
      [`BODY\n\n${footer}`, 7, false, false, ["BODY"]],
      [`BODY\n \t\n${footer}\n \n`, 7, false, false, ["BODY"]],
      [`\n${footer}`, 7, false, false, []],
      [`BODY\n\n[exit code: -2; error: execution failed]`, -2, true, false, ["BODY"]],
      [`BODY\n${footer}`, 7, false, false, ["BODY", footer]],
      [`BODY\n\n[exit code: 8]`, 7, false, false, ["BODY", "", "[exit code: 8]"]],
      [`BODY\n\n${footer} `, 7, false, false, ["BODY", "", `${footer} `]],
      [`BODY\n\n ${footer}`, 7, false, false, ["BODY", "", ` ${footer}`]],
      [`BODY\n\n${footer}\nTAIL`, 7, false, false, ["BODY", "", footer, "TAIL"]],
      [`BODY\n\n${footer}`, 7, true, false, ["BODY", "", footer]],
      [`BODY\n\n${footer}`, "7", false, false, ["BODY", "", footer]],
      [`BODY\n\n${footer}`, undefined, false, false, ["BODY", "", footer]],
      [`BODY\n\n[exit code: 0]`, 0, false, false, ["BODY", "", "[exit code: 0]"]],
      ["BODY\n\n[error: execution failed]", 0, true, false, ["BODY", "", "[error: execution failed]"]],
      [`BODY\n\n${footer}`, 7, false, true, ["BODY", "", footer]],
      [`BODY\n\n${footer}\n\n${footer}`, 7, false, false, ["BODY", "", footer]],
    ];
    for (const [text, exit_code, isError, partial, displayed] of cases) {
      const result = { content: [{ type: "text", text }], details: { exit_code }, isError };
      tool.updateResult(result, partial);
      const before = structuredClone(result);
      const finalFooter = partial ? "" : typeof exit_code === "number" && exit_code !== 0
        ? `[exit code: ${exit_code}${isError ? "; error: execution failed" : ""}]`
        : isError ? "[error: execution failed]" : "";
      for (const expanded of [false, true]) {
        tool.setExpanded(expanded);
        // This helper discards right padding; row count still detects preserved nonmatching literals.
        assert.deepEqual(bashBody(tool, 100), ["$ false", ...(displayed.length ? ["", ...displayed.map((row) => row.trimEnd())] : []), ...(finalFooter ? ["", finalFooter] : [])], text);
        assert.deepEqual(tool.result, before);
      }
    }
    const result = { content: [{ type: "text", text: "BODY\r\n" }, { type: "text", text: `\u001b[31m${footer}\u001b[0m\r\n` }], details: { exit_code: 7 } };
    const before = structuredClone(result);
    tool.updateResult(result); tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ["$ false", "", "BODY", "", footer]);
    assert.deepEqual(tool.result, before);
  } finally { controller.restore(); }
});

test("bash removes trailing preview blanks before hint without backfilling or changing expansion", () => {
  const tool = bashTool("true");
  const { controller } = setup([tool]);
  try {
    const reported = ["✖ real CLI: cache work (25298.723022ms)", "ℹ tests 1", "ℹ suites 0", "ℹ pass 0", "ℹ fail 1", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0", "ℹ duration_ms 25403.258316"];
    const original = [...reported, "", "FAILURE_DETAILS", "", "[exit code: 1]"].join("\n");
    tool.updateResult({ content: [{ type: "text", text: original }], details: { exit_code: 1 } });
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...reported, "… (Click to expand)", "", "[exit code: 1]"]);
    tool.setExpanded(true);
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...reported, "", "FAILURE_DETAILS", "", "[exit code: 1]"]);
    assert.equal(tool.result?.content[0].text, original);
    for (const blank of ["", " \t", "\n\n"]) {
      const rows = Array.from({ length: 9 }, (_, i) => `ROW_${i}`);
      const text = [...rows, blank, "HIDDEN_TAIL"].join("\n");
      tool.updateResult({ content: [{ type: "text", text }] }); tool.setExpanded(false);
      assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...rows, "… (Click to expand)"]);
      tool.setExpanded(true);
      assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...rows, ...blank.split("\n").map(() => ""), "HIDDEN_TAIL"]);
      assert.equal(tool.result?.content[0].text, text);
    }
    tool.updateResult({ content: [{ type: "text", text: "A\n\nB\n" + Array(8).fill("C").join("\n") }] }); tool.setExpanded(false);
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", "A", "", "B", ...Array(7).fill("C"), "… (Click to expand)"]);
    // A nonempty logical row can wrap into whitespace-only rows at the preview boundary.
    tool.updateResult({ content: [{ type: "text", text: "A".repeat(19 * 9) + " ".repeat(19 * 2) + "TAIL" }] });
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", ...Array(9).fill("A".repeat(19)), "… (Click to expand)"]);
    tool.updateResult({ content: [{ type: "text", text: " ".repeat(19 * 11) + "TAIL" }] });
    assert.deepEqual(bashBody(tool, 24), ["$ true", "", "… (Click to expand)"]);
    // Removing a matching suffix changes overflow/expandability before the cutoff.
    tool.updateResult({ content: [{ type: "text", text: Array(9).fill("ROW").join("\n") + "\n\n[exit code: 7]" }], details: { exit_code: 7 } });
    assert.deepEqual(bashBody(tool, 100), ["$ true", "", ...Array(9).fill("ROW"), "", "[exit code: 7]"]);
    assert.equal(tool.handleMouse(mouse(2, 100)), undefined);
    assert.equal(tool.expanded, false);
  } finally { controller.restore(); }
});

test("bash completion uses persisted numeric metadata and error flags, never output parsing", () => {
  const tool = bashTool("false");
  const cases: [unknown, boolean, string | undefined][] = [
    [7, false, "[exit code: 7]"], [7, true, "[exit code: 7; error: execution failed]"],
    [0, true, "[error: execution failed]"], [undefined, true, "[error: execution failed]"],
    [0, false, undefined], [undefined, false, undefined], [null, false, undefined],
    ["7", false, undefined], [NaN, false, undefined], [1.5, false, undefined], [-9, false, "[exit code: -9]"],
  ];
  const { controller } = setup([tool]);
  try {
    for (const [exit_code, isError, footer] of cases) {
      tool.result = { content: [], details: { exit_code }, isError, structuredContent: { exit_code: 123 } };
      assert.deepEqual(bashBody(tool), ["$ false", ...(footer ? ["", footer] : [])]);
    }
    tool.result = { content: [{ type: "text", text: "Command exited with code 9" }] };
    assert.deepEqual(bashBody(tool), ["$ false", "", "Command exited with code 9"]);
    tool.isPartial = true;
    tool.result = { content: [], details: { exit_code: 9 }, isError: true };
    assert.deepEqual(bashBody(tool), ["$ false"]);
  } finally { controller.restore(); }
});

test("bash streaming replaces snapshots and keeps custom presentation after Ctrl+O", () => {
  const tool = bashTool("run");
  const { controller } = setup([tool]);
  try {
    tool.updateResult(undefined, true);
    assert.deepEqual(bashBody(tool), ["$ run"]);
    tool.updateResult({ content: [{ type: "text", text: "PARTIAL" }] }, true);
    assert.deepEqual(bashBody(tool), ["$ run", "", "PARTIAL"]);
    tool.setExpanded(true);
    tool.updateResult({ content: [{ type: "text", text: "FINAL" }] });
    assert.deepEqual(bashBody(tool), ["$ run", "", "FINAL"]);
    assert.doesNotMatch(tool.render(80).join(""), /PARTIAL|NATIVE/);
    controller.restore();
    assert.match(tool.render(80).join(""), /NATIVE bash/);
  } finally { controller.restore(); }
});

test("bash whole-panel clicks toggle during streaming without capturing wheel or secondary events", () => {
  const tool = bashTool("run"); tool.args.description = "Description"; tool.args.workdir = "sub";
  tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 11 }, (_, i) => `LINE_${i}`).join("\n") }], details: { exit_code: 4 } }, true);
  const { root, controller } = setup([new Text("User", 0, 0), tool]);
  try {
    root.render(80);
    let rows = tool.render(80).map(plain);
    const output = rows.findIndex((row) => row.includes("LINE_0"));
    assert.equal(tool.handleMouse(mouse(0)), undefined);
    for (let y = 1; y < output; y++) {
      assert.ok(tool.handleMouse(mouse(y))?.handled);
      assert.equal(tool.expanded, true);
      tool.setExpanded(false);
    }
    assert.ok(tool.handleMouse(mouse(output))?.handled);
    assert.equal(tool.expanded, true);
    assert.ok(tool.handleMouse(mouse(output))?.handled);
    assert.equal(tool.expanded, false);
    rows = tool.render(80).map(plain);
    const hint = rows.findIndex((row) => row.includes("Click to expand"));
    assert.ok(tool.handleMouse(mouse(hint))?.handled);
    assert.equal(tool.expanded, true);
    assert.equal(tool.handleMouse({ ...mouse(output), type: "wheel", wheelDelta: -1 }), undefined);
    assert.equal(tool.handleMouse({ ...mouse(output), button: "right" }), undefined);
    tool.updateResult(tool.result);
    rows = tool.render(80).map(plain);
    const footer = rows.findIndex((row) => row.includes("exit code:"));
    assert.ok(tool.handleMouse(mouse(footer))?.handled);
    assert.equal(tool.expanded, false);
    assert.ok(tool.handleMouse(mouse(tool.render(80).length - 1))?.handled);
    assert.equal(tool.expanded, true);
  } finally { controller.restore(); }
});

test("bash foregrounds and neutral panel follow live theme while Unicode geometry stays safe", () => {
  const root = new Root(), tool = bashTool("printf '\t界é👩‍💻'\n\tsecond"); root.addChild(tool);
  tool.args.description = "Describe"; tool.args.workdir = "sub";
  tool.result = { content: [{ type: "text", text: "\x1b]0;BAD\x07\x1b[31mOUTPUT\x1b[0m\r\n  é\u202e" }] };
  const fg: [string, string][] = [], bg: string[] = [];
  let theme = "A";
  const controller = installToolview(root, () => ({
    fg: (role, text) => { fg.push([role, text]); return text; },
    bg: (role: string, text: string) => { bg.push(`${theme}:${role}`); return text; },
  }));
  try {
    for (let width = 1; width <= 40; width++) {
      for (const row of tool.render(width)) {
        assert.ok(visibleWidth(row) <= width, `${width}: ${JSON.stringify(row)}`);
        assert.doesNotMatch(row.replace(/^\x1b\[49m/u, ""), /[\x00-\x1f\x7f-\x9f\u202e]/u,
          "only the frame's trusted leading background reset is permitted");
      }
    }
    fg.length = 0; bg.length = 0; tool.render(80);
    assert.ok(fg.some(([role, text]) => role === "dim" && text === "$ "));
    assert.ok(fg.some(([role, text]) => role === "toolTitle" && text.includes("printf")));
    assert.ok(fg.some(([role, text]) => role === "muted" && text.includes("Describe")));
    assert.ok(fg.some(([role, text]) => role === "toolOutput" && text === "OUTPUT"));
    assert.deepEqual([...new Set(bg)], ["A:toolPendingBg"]);
    theme = "B"; tool.isPartial = true; bg.length = 0; tool.render(80);
    assert.deepEqual([...new Set(bg)], ["B:toolPendingBg"]);
    tool.isPartial = false; tool.result.details = { exit_code: 3 }; bg.length = 0; tool.render(80);
    assert.deepEqual([...new Set(bg)], ["B:toolPendingBg"]);
    assert.ok(fg.some(([role, text]) => role === "error" && text.includes("exit code: 3")));
  } finally { controller.restore(); }
});

test("bash policy preserves explicit native/compact overrides and image safeguards", () => {
  for (const [options, expected] of [[{ cards: ["bash"] }, /NATIVE bash/], [{ cards: ["bash"], compact: ["bash"] }, /→ bash/]] as const) {
    const tool = bashTool();
    const { controller } = setup([tool], options);
    try { assert.match(tool.render(80).join(""), expected); } finally { controller.restore(); }
  }
  const image = bashTool(); image.result = { content: [{ type: "image" }] };
  const { controller, original } = setup([image]);
  try { assert.deepEqual(image.render(80), original.call(image, 80)); } finally { controller.restore(); }
});

test("bash exterior margins are not expansion targets and hidden self cards stay hidden", () => {
  const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("LINE").join("\n") }] };
  const { controller } = setup([tool]);
  try {
    const y = tool.render(80).map(plain).findIndex((row) => row.includes("LINE"));
    for (const x of [0, 79]) assert.equal(tool.handleMouse({ ...mouse(y), x }), undefined);
    assert.equal(tool.expanded, false);
    assert.ok(tool.handleMouse({ ...mouse(y), x: 2 })?.handled);
    for (let width = 1; width <= 24; width++) for (const row of tool.render(width)) assert.ok(visibleWidth(row) <= width);
    tool.expanded = false;
    for (let width = 1; width <= 24; width++) for (const row of tool.render(width)) assert.ok(visibleWidth(row) <= width);
  } finally { controller.restore(); }
  class HiddenBash extends Tool {
    getRenderShell() { return "self"; }
    render(_width: number): string[] { return []; }
    handleMouse(event: TuiMouseEvent) { return super.handleMouse(event); }
  }
  const hidden = new HiddenBash("bash", { command: "echo HIDDEN" });
  const frame = setup([hidden]);
  try { assert.deepEqual(hidden.render(80), []); assert.equal(hidden.handleMouse(mouse(0)), undefined); }
  finally { frame.controller.restore(); }
});

test("bash keeps Unicode joining sequences intact instead of deleting their joining marks", () => {
  const tool = bashTool("echo 👩‍💻");
  tool.result = { content: [{ type: "text", text: "👩‍💻 é" }] };
  const { controller } = setup([tool]);
  try {
    assert.deepEqual(bashBody(tool), ["$ echo 👩‍💻", "", "👩‍💻 é"]);
    assert.ok(bashBody(tool, 9).some((row) => row === "👩‍💻"));
  } finally { controller.restore(); }
});

test("bash removes every Unicode bidi control, including Arabic letter marks, without changing inputs", () => {
  const tool = bashTool("printf '\u061c123'");
  tool.args.description = "Check\u061c directory"; tool.args.workdir = "sub\u061c";
  tool.result = { content: [{ type: "text", text: "\u061c" }] };
  const before = structuredClone({ args: tool.args, result: tool.result });
  const { controller } = setup([tool]);
  try {
    const rows = tool.render(80);
    assert.ok(rows.every((row) => !/\p{Bidi_Control}/u.test(row)));
    assert.deepEqual(bashBody(tool), ["# Check directory", "# Running in /project/sub", "", "$ printf '123'"]);
    assert.deepEqual({ args: tool.args, result: tool.result }, before);
    tool.args.description = "\u061c"; delete tool.args.workdir;
    assert.deepEqual(bashBody(tool), ["$ printf '123'"]);
  } finally { controller.restore(); }
});


test("OpenCode-style bash shell has external margins and a shared content origin", () => {
  const tool = bashTool("echo ok"); tool.result = { content: [{ type: "text", text: "ok" }] };
  const { controller } = setup([tool]);
  try {
    const row = (content: string) => " ┃ " + content.padEnd(75) + "  ";
    assert.deepEqual(tool.render(80).map(plain), [row(""), row("$ echo ok"), row(""), row("ok"), row("")]);
    for (let width = 0; width <= 80; width++) {
      const rows = tool.render(width);
      if (!width) assert.deepEqual(rows, []);
      else for (const line of rows) assert.equal(visibleWidth(line), width);
    }
  } finally { controller.restore(); }
});

test("the whole expandable panel is clickable but margins, selection and drags are not", () => {
  const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const { root, controller } = setup([new Text("Before", 0, 0), tool]);
  try {
    for (const x of [0, 79]) assert.equal(tool.handleMouse({ ...mouse(1), x }), undefined);
    for (const point of [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 78, y: tool.render(80).length - 1 }]) {
      assert.ok(tool.handleMouse({ ...mouse(point.y), x: point.x })?.handled);
      assert.equal(tool.expanded, true);
      tool.setExpanded(false);
    }
    root.selection = true;
    assert.equal(tool.handleMouse(mouse(2)), undefined);
    root.selection = false;
    for (const type of ["press", "release", "drag", "wheel"] as const) assert.equal(tool.handleMouse({ ...mouse(2), type }), undefined);
    assert.equal(tool.expanded, false);
    assert.equal(tool.handleMouse({ ...mouse(2), button: "right" }), undefined);
    assert.equal(tool.handleMouse(mouse(0)), undefined, "transcript separator");
  } finally { controller.restore(); }
});


test("shared frame accepts unrelated bodies and paint without host/tool state", () => {
  const g = cardGeometry(12);
  assert.deepEqual([g.marginLeft, g.marginRight, g.borderWidth, g.paddingLeft, g.paddingRight, g.contentX, g.contentWidth], [1, 1, 1, 1, 1, 3, 7]);
  const painted: string[] = [];
  const rows = frameRows(g, ["hello", "user"], { panel: (text) => { painted.push(text); return text; }, border: (text) => text });
  assert.deepEqual(rows.map(plain), [" ┃          ", " ┃ hello    ", " ┃ user     ", " ┃          "]);
  assert.deepEqual(painted, ["         ", " hello   ", " user    ", "         "], "panel painter never receives the stripe");
  assert.throws(() => frameRows(g, ["overflow"], { panel: (text) => text, border: (text) => text }), RangeError);
  assert.deepEqual(frameRows(cardGeometry(0), [], { panel: (text) => text, border: (text) => text }), []);
  assert.ok(insidePanel(g, 4, 1, 0)); assert.ok(insidePanel(g, 4, 10, 3));
  for (const point of [[0, 0], [11, 0], [1, -1], [1, 4]]) assert.equal(insidePanel(g, 4, point[0], point[1]), false);
  const origins = [0, 0, 1, 2, 2, 2, 3, 3];
  for (let width = 1; width < 8; width++) {
    const narrow = cardGeometry(width);
    assert.equal(narrow.contentX, origins[width]); assert.equal(narrow.contentWidth, Math.max(1, width - 5));
    assert.ok(frameRows(narrow, ["x"], { panel: (text) => text, border: (text) => text }).every((row) => visibleWidth(row) === width));
  }
});

test("failed stripe and footer share error foreground, never a background-token color", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  const foregrounds: [string, string][] = [], backgrounds: string[] = [];
  const theme: CardTheme = {
    colors: { toolErrorBg: parseColor("#500000") },
    fg: (role, text) => { foregrounds.push([role, text]); return text; },
    bg: (role, text) => { backgrounds.push(role); return text; },
    style: () => { throw new Error("Stripe must use the same semantic foreground as the footer"); },
  };
  const controller = installToolview(root, () => theme);
  try {
    for (const result of [
      { content: [], details: { exit_code: 7 }, isError: false },
      { content: [], details: { exit_code: 0 }, isError: true },
      { content: [], isError: true },
    ]) {
      foregrounds.length = 0; backgrounds.length = 0; tool.result = result; tool.isPartial = false;
      tool.render(80);
      assert.ok(foregrounds.some(([role, text]) => role === "error" && text === "┃"));
      assert.ok(foregrounds.some(([role, text]) => role === "error" && text.startsWith("[")));
      assert.deepEqual([...new Set(backgrounds)], ["toolPendingBg"]);
    }
    for (const partial of [false, true]) {
      foregrounds.length = 0;
      tool.result = { content: [], details: { exit_code: partial ? 7 : 0 }, isError: partial }; tool.isPartial = partial;
      tool.render(80);
      assert.ok(foregrounds.some(([role, text]) => role === "borderMuted" && text === "┃"));
      assert.ok(!foregrounds.some(([role]) => role === "error"));
    }
  } finally { controller.restore(); }
});

test("card motion and focus keep neutral paint without replacing native input or requesting render", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const native = root.handleViewportInput, descriptor = Object.getOwnPropertyDescriptor(root, "handleViewportInput");
  const listeners = [...root.listeners], symbols = Object.getOwnPropertySymbols(root);
  const styles: Parameters<NonNullable<CardTheme["style"]>>[1][] = [];
  const backgrounds: string[] = [];
  const theme: CardTheme = { colors: { toolPendingBg: parseColor("#202020"), text: parseColor("#eeeeee") },
    fg: (_role, text) => text, bg: (role, text) => { backgrounds.push(role); return text; },
    style: (text, options) => { styles.push(options); return text; } };
  let paletteReads = 0;
  const controller = installToolview(root, () => { paletteReads++; return theme; });
  try {
    assert.equal(controller.active, true);
    assert.equal(root.handleViewportInput, native);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
    assert.deepEqual([...root.listeners], listeners); assert.deepEqual(Object.getOwnPropertySymbols(root), symbols);
    const expected = tool.render(80), requests = root.requests;
    for (const data of ["\x1b[<35;6;3M", "\x1b[<35;1;1M", "\x1b[O", "\x1b[I"]) assert.deepEqual(root.input(data), [undefined]);
    for (const type of ["move", "press", "release", "drag", "wheel"] as const) {
      const before = paletteReads;
      assert.equal(tool.handleMouse({ ...mouse(2), type, button: type === "move" ? "none" : "left" }), undefined);
      assert.equal(paletteReads, before, "ignored mouse events do not render the card body");
      assert.deepEqual(tool.render(80), expected);
    }
    assert.equal(root.requests, requests, "pointer events do not request Toolview redraws");
    assert.equal(tool.expanded, false); assert.deepEqual(styles, []);
    assert.deepEqual([...new Set(backgrounds)], ["toolPendingBg"]);
    controller.restore();
    assert.equal(root.handleViewportInput, native); assert.deepEqual([...root.listeners], listeners);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
  } finally { controller.restore(); }
});

test("absent, immutable and throwing private input methods are not a Toolview dependency", () => {
  for (const shape of ["missing", "immutable", "throwing"]) {
    const root = new Root(), tool = bashTool(); root.addChild(tool);
    const warnings: string[] = []; let reads = 0;
    if (shape === "missing") Object.defineProperty(root, "handleViewportInput", { value: undefined, configurable: true });
    else if (shape === "immutable") Object.defineProperty(root, "handleViewportInput", { value: Root.prototype.handleViewportInput, configurable: false, writable: false });
    else Object.defineProperty(root, "handleViewportInput", { get() { reads++; throw new Error("Private input must not be read"); }, configurable: false });
    const descriptor = Object.getOwnPropertyDescriptor(root, "handleViewportInput");
    const controller = installToolview(root, () => color, { warn: (text) => warnings.push(text) });
    try {
      assert.equal(controller.active, true); assert.deepEqual(warnings, []);
      assert.ok(tool.render(80).some((row) => plain(row).startsWith(" ┃ $ ")));
      assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
      assert.equal(reads, 0);
    } finally { controller.restore(); }
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor); assert.equal(reads, 0);
  }
});

test("actual fullscreen keeps native input identity and consumption throughout Toolview lifecycle", () => {
  const noop = () => {};
  const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false,
    start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop,
    showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop };
  const root = new TuiAltScreen(terminal, false); root.requestRender = noop;
  const input = root as unknown as { handleTerminalInput(data: string): void; handleViewportInput(data: string): unknown };
  const native = input.handleViewportInput, descriptor = Object.getOwnPropertyDescriptor(root, "handleViewportInput");
  const tool = bashTool(); root.addChild(tool);
  let lateObservations = 0;
  const unsubscribe = root.addInputListener(() => { lateObservations++; return undefined; });
  const controller = installToolview(root, () => color);
  try {
    assert.equal(controller.active, true); assert.equal(input.handleViewportInput, native);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
    for (const data of ["\x1b[<35;1;1M", "\x1b[O", "\x1b[<64;1;1M"]) input.handleTerminalInput(data);
    assert.equal(lateObservations, 0, "native SDK still consumes mouse and focus before appended listeners");
    controller.restore(); assert.equal(input.handleViewportInput, native);
    assert.deepEqual(Object.getOwnPropertyDescriptor(root, "handleViewportInput"), descriptor);
  } finally { controller.restore(); unsubscribe(); }
});

test("stable TUI reference needs no receiver probe, writes or private input access", () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  const symbols = Object.getOwnPropertySymbols(root), native = root.handleViewportInput;
  const reference = new Proxy({}, {
    get: (_target, property) => {
      assert.notEqual(property, "handleViewportInput", "no private input lookup");
      const value = Reflect.get(root, property, root);
      return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, root, args) : value;
    },
    set: () => { throw new Error("No renderer writes allowed"); },
    defineProperty: () => { throw new Error("No proxy target writes allowed"); },
    getPrototypeOf: () => Reflect.getPrototypeOf(root),
  }) as Root;
  const controller = installToolview(reference, () => color);
  try {
    assert.equal(controller.active, true);
    assert.ok(tool.render(80).some((row) => plain(row).startsWith(" ┃ $ ")));
    assert.deepEqual(Object.getOwnPropertySymbols(root), symbols); assert.equal(root.handleViewportInput, native);
  } finally { controller.restore(); }
});


test("narrow truncated bash hints cannot reset the panel background or dim foreground", async () => {
  const root = new Root(), tool = bashTool(); root.addChild(tool);
  tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
  const theme: CardTheme = {
    fg: (_role, text) => `\x1b[38;2;180;180;180m${text}\x1b[39m`,
    bg: (_role, text) => `\x1b[48;2;32;32;32m${text}\x1b[49m`,
  };
  const controller = installToolview(root, () => theme);
  const terminal = new xterm.Terminal({ cols: 22, rows: 30, allowProposedApi: true });
  try {
    const rows = tool.render(22);
    await new Promise<void>((done) => terminal.write(rows.join("\r\n"), done));
    for (let y = 0; y < rows.length; y++) {
      if (!plain(rows[y]!).includes("┃")) continue;
      for (let x = 0; x < 22; x++) {
        const cell = terminal.buffer.active.getLine(y)!.getCell(x)!;
        if (x <= 1 || x >= 21) assert.equal(cell.getBgColorMode(), 0, "exterior and stripe keep default background");
        else assert.equal(cell.getBgColor(), 0x202020, `painted panel cell (${x},${y})`);
      }
    }
    const hint = rows.findIndex((row) => plain(row).includes("… (Click"));
    assert.ok(hint >= 0);
    for (let x = 3; x < 3 + visibleWidth(plain(rows[hint]!).slice(3, -2).trimEnd()); x++) {
      assert.equal(terminal.buffer.active.getLine(hint)!.getCell(x)!.getFgColor(), 0xb4b4b4, "entire hint retains semantic foreground");
    }
  } finally { controller.restore(); terminal.dispose(); }
});


test("renderer replacement preserves cards and clicks without touching any native input method", () => {
  for (const fullscreenFirst of [true, false]) {
    const noop = () => {};
    const terminal: Terminal = { columns: 80, rows: 20, kittyProtocolActive: false,
      start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop,
      showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop };
    const roots = fullscreenFirst ? [new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false), new TuiAltScreen(terminal, false)]
      : [new TuiMainScreen(terminal, false), new TuiAltScreen(terminal, false), new TuiMainScreen(terminal, false), new TuiAltScreen(terminal, false)];
    for (const root of roots) root.requestRender = noop;
    let current = roots[0]!;
    const reference = new Proxy({}, {
      get: (_target, property) => {
        const value = Reflect.get(current, property, current);
        return typeof value === "function" ? (...args: unknown[]) => Reflect.apply(value, current, args) : value;
      },
      set: () => { throw new Error("No receiver capture/migration writes allowed"); },
      getPrototypeOf: () => Reflect.getPrototypeOf(current),
    }) as TuiAltScreen;
    const inputs = roots.map((root) => Reflect.get(root, "handleViewportInput"));
    const descriptors = roots.map((root) => Object.getOwnPropertyDescriptor(root, "handleViewportInput"));
    const symbols = roots.map((root) => Object.getOwnPropertySymbols(root));
    const tool = bashTool(); tool.result = { content: [{ type: "text", text: Array(11).fill("OUT").join("\n") }] };
    current.addChild(tool);
    const controller = installToolview(reference, () => color);
    try {
      const expected = tool.render(80);
      for (let index = 0; index < roots.length; index++) {
        if (index) { current.clear(); current = roots[index]!; current.addChild(tool); }
        assert.equal(controller.active, true); assert.deepEqual(tool.render(80), expected);
        assert.equal(tool.handleMouse({ ...mouse(2), type: "move", button: "none" }), undefined);
        assert.deepEqual(tool.render(80), expected);
        assert.ok(tool.handleMouse(mouse(2))?.handled); assert.equal(tool.expanded, true);
        assert.ok(tool.handleMouse(mouse(2))?.handled); assert.equal(tool.expanded, false);
        for (let other = 0; other < roots.length; other++) {
          assert.equal(Reflect.get(roots[other]!, "handleViewportInput"), inputs[other]);
          assert.deepEqual(Object.getOwnPropertyDescriptor(roots[other]!, "handleViewportInput"), descriptors[other]);
          assert.deepEqual(Object.getOwnPropertySymbols(roots[other]!), symbols[other]);
        }
      }
    } finally { controller.restore(); }
    for (let index = 0; index < roots.length; index++) assert.equal(Reflect.get(roots[index]!, "handleViewportInput"), inputs[index]);
  }
});


test("one-column padding reserves both sides without losing long command characters", () => {
  const command = `python3 -c "from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('/tmp/neon-blocks-check.js').write_text(m.group(1))" && node --check /tmp/neon-blocks-check.js`;
  const tool = bashTool(command); tool.args.description = "Validate game JavaScript syntax";
  const before = structuredClone(tool.args);
  const { controller } = setup([tool]);
  try {
    for (let width = 6; width <= 180; width++) {
      const rows = tool.render(width).map(plain);
      for (const row of rows) {
        assert.equal(visibleWidth(row), width);
        assert.equal(row[0], " "); assert.equal(row[1], "┃"); assert.equal(row[2], " ");
        assert.equal(row[width - 2], " ", "right inside padding is reserved even on full rows");
        assert.equal(row[width - 1], " ", "right exterior stays outside the panel");
      }
      const first = rows.findIndex((row) => row.slice(3, -2).startsWith("$"));
      assert.ok(first > 0);
      assert.equal(rows.slice(first, -1).map((row) => row.slice(3, -2)).join("").trimEnd(), `$ ${command}`,
        `all characters survive hard wrapping at component width ${width}`);
    }
    assert.deepEqual(tool.args, before);
  } finally { controller.restore(); }
});


test("ordinary and error stripes use terminal-default background, not panel or inherited paint", async () => {
  const root = new Root(), tool = bashTool("true"); root.addChild(tool);
  const theme: CardTheme = {
    colors: { toolErrorBg: parseColor("#500000") },
    fg: (role, text) => `\x1b[38;2;${role === "error" ? "200;30;40" : "120;120;120"}m${text}\x1b[39m`,
    bg: (_role, text) => `\x1b[48;2;32;32;32m${text}\x1b[49m`,
    style: (text) => `\x1b[38;2;80;0;0m${text}\x1b[39m`,
  };
  const controller = installToolview(root, () => theme);
  try {
    for (const failed of [false, true]) {
      tool.result = { content: [], isError: failed, details: { exit_code: failed ? 7 : 0 } };
      for (const width of [2, 5, 12, 22]) {
        const rows = tool.render(width);
        const terminal = new xterm.Terminal({ cols: width, rows: rows.length + 2, allowProposedApi: true });
        try {
          await new Promise<void>((done) => terminal.write("\x1b[48;2;99;99;99m" + rows.join("\r\n"), done));
          for (let y = 0; y < rows.length; y++) {
            const line = terminal.buffer.active.getLine(y)!;
            let stripe = -1;
            for (let x = 0; x < width; x++) if (line.getCell(x)!.getChars() === "┃") stripe = x;
            assert.ok(stripe >= 0);
            const cell = line.getCell(stripe)!;
            assert.equal(cell.getBgColorMode(), 0, `default stripe background: failed=${failed}, width=${width}, row=${y}`);
            assert.equal(cell.getFgColor(), failed ? 0xc81e28 : 0x787878, "stripe foreground follows footer error role, never toolErrorBg");
            for (let x = stripe + 1; x < width - (width >= 5 ? 1 : 0); x++) {
              assert.equal(line.getCell(x)!.getBgColor(), 0x202020, "body and internal padding retain panel background");
            }
            assert.equal(visibleWidth(rows[y]!), width);
          }
        } finally { terminal.dispose(); }
      }
    }
  } finally { controller.restore(); }
});


test("unchanged UI frames reuse custom layout; one tool update does not rebuild its neighbors", () => {
  const root = new Root();
  const tools = Array.from({ length: 8 }, (_, i) => {
    const tool = bashTool(`command_${i}`);
    tool.result = { content: [{ type: "text", text: Array.from({ length: 1000 }, (_, j) => `PERF_OUTPUT_${j}`).join("\n") }] };
    root.addChild(tool); return tool;
  });
  let segments = 0;
  const original = Intl.Segmenter.prototype.segment;
  Intl.Segmenter.prototype.segment = function (input) { if (input.startsWith("PERF_OUTPUT_")) segments++; return original.call(this, input); };
  const controller = installToolview(root, () => color);
  try {
    root.render(80);
    assert.equal(segments, 88, "only first eleven output rows are wrapped once per tool");
    assert.equal(controller.cacheStats().builds, 8);
    segments = 0; const a = root.render(80); const b = root.render(80);
    assert.deepEqual(a, b); assert.equal(segments, 0); assert.equal(controller.cacheStats().builds, 8);
    tools[3].updateResult({ content: [{ type: "text", text: "PERF_OUTPUT_NEW" }] });
    root.render(80); assert.equal(segments, 1); assert.equal(controller.cacheStats().builds, 9);
    root.render(81); assert.equal(controller.cacheStats().builds, 17);
    controller.clearCache(); assert.equal(controller.cacheStats().retainedBytes, 0);
    root.render(81); assert.equal(controller.cacheStats().builds, 25);
    controller.setCacheLimitMiB(0); assert.equal(controller.cacheStats().entries, 0);
    controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0);
  } finally { controller.restore(); Intl.Segmenter.prototype.segment = original; }
});

test("reused mutable arguments and results invalidate only through native update methods", () => {
  const tool = new Tool("custom", { query: "before" });
  const { root, controller } = setup([tool]);
  try {
    assert.ok(root.render(80).some((row) => plain(row).includes("before")));
    const args = tool.args; args.query = "after"; tool.updateArgs(args);
    assert.ok(root.render(80).some((row) => plain(row).includes("after")));
    tool.result!.isError = true; tool.result!.content[0].text = "new error"; tool.updateResult(tool.result);
    assert.ok(root.render(80).some((row) => plain(row).includes("new error")));
    const builds = controller.cacheStats().builds;
    tool.invalidate(); root.render(80); assert.equal(controller.cacheStats().builds, builds + 1);
  } finally { controller.restore(); }
});


test("render cache bounds retained bytes/entries and drops evicted values without retaining owners", () => {
  const cache = new RenderCache(2000, 2);
  const a = cache.put({ rows: ["a"] }, ["a"]), b = cache.put({ rows: ["b"] }, ["b"]);
  assert.equal(cache.stats().entries, 2); cache.get(a);
  const c = cache.put({ rows: ["c"] }, ["c"]);
  assert.equal(b.value, undefined); assert.ok(a.value); assert.ok(c.value);
  assert.ok(cache.stats().retainedBytes <= 2000); assert.equal(cache.stats().evictions, 1);
  assert.deepEqual(Object.keys(a).sort(), ["bytes", "value"], "recency entries contain no owner, raw source or closure fields");
  cache.setLimit(600); assert.ok(cache.stats().retainedBytes <= 600); assert.equal(cache.stats().entries, 1);
  cache.clear(); assert.equal(a.value, undefined); assert.equal(c.value, undefined);
  assert.equal(cache.stats().retainedBytes, 0); assert.equal(cache.stats().entries, 0);
  const big = cache.put({ rows: ["x".repeat(1000)] }, ["x".repeat(1000)]);
  assert.equal(big.value, undefined); assert.equal(cache.stats().skips, 1);
  cache.setLimit(0); const zero = cache.put({ rows: ["z"] }, ["z"]);
  assert.equal(zero.value, undefined); assert.equal(cache.stats().retainedBytes, 0);
  for (const limit of [-1, NaN, Infinity, 65 * 1024 * 1024]) assert.throws(() => cache.setLimit(limit), RangeError);
});

test("cache lifecycle restores inherited/owned invalidation methods and respects later owners", () => {
  const names = ["updateArgs", "updateResult", "setExpanded", "invalidate"];
  const originals = names.map((name) => Object.getOwnPropertyDescriptor(Tool.prototype, name));
  const tool = new Tool(), { root, controller } = setup([tool]);
  try {
    root.render(80); assert.ok(controller.cacheStats().entries > 0);
    const replacement = function () {};
    Object.defineProperty(Tool.prototype, "updateArgs", { configurable: true, writable: true, value: replacement });
    controller.restore();
    assert.equal(controller.cacheStats().entries, 0); assert.equal(Tool.prototype.updateArgs, replacement);
    for (let i = 1; i < names.length; i++) assert.deepEqual(Object.getOwnPropertyDescriptor(Tool.prototype, names[i]), originals[i]);
  } finally {
    controller.restore();
    names.forEach((name, i) => { if (originals[i]) Object.defineProperty(Tool.prototype, name, originals[i]!); else Reflect.deleteProperty(Tool.prototype, name); });
  }
});

test("new theme and expansion/structure changes do not leave stale cache geometry or separators", () => {
  const a = new Tool("custom", { query: "x".repeat(80) }), b = new Tool();
  const root = new Root(); root.addChild(a); root.addChild(b);
  let theme = { fg: (_role: string, text: string) => `\x1b[31m${text}\x1b[39m` };
  const controller = installToolview(root, () => theme);
  try {
    root.render(80); const built = controller.cacheStats().builds;
    theme = { fg: (_role: string, text: string) => `\x1b[32m${text}\x1b[39m` };
    const changed = root.render(80); assert.ok(changed.some((row) => row.includes("\x1b[32m"))); assert.equal(controller.cacheStats().builds, built + 2);
    root.removeChild(a); assert.notEqual(b.render(80)[0], "", "lazy sibling position repair handles removal");
    a.setExpanded(true); root.addChild(a); assert.ok(root.render(80).some((row) => row.includes("NATIVE")));
  } finally { controller.restore(); }
});


test("optional cache diagnostics distinguish retained estimates from whole-process heap and validate controls", async () => {
  const h = extensionHarness("tui", { "toolview-cache-mb": "0.01" });
  const command = h.commands.get("toolview")!.handler;
  const stats = () => JSON.parse(h.notices.at(-1)!.replace("Pi Toolview cache: ", ""));
  try {
    h.events.get("session_start")!({}, h.ctx); h.root.render(80);
    await command("cache", h.ctx);
    const first = stats(); assert.equal(first.limitBytes, Math.floor(0.01 * 1024 * 1024)); assert.ok(first.entries > 0);
    assert.ok(first.retainedBytes <= first.limitBytes); assert.ok(first.processHeapUsedBytes > 0);
    assert.match(first.processMemoryScope, /whole Pi process, not Toolview/);
    await command("cache clear", h.ctx); assert.equal(stats().entries, 0); assert.equal(stats().retainedBytes, 0);
    h.root.render(80); await command("cache limit 0", h.ctx); assert.equal(stats().retainedBytes, 0); assert.equal(stats().limitBytes, 0);
    await command("off", h.ctx); await command("on", h.ctx); await command("cache", h.ctx); assert.equal(stats().limitBytes, 0);
    for (const invalid of ["cache limit -1", "cache limit 65", "cache limit NaN", "cache wrong", "cache limit 1 extra"] ) {
      await command(invalid, h.ctx); assert.match(h.notices.at(-1)!, /limit must be|Usage:/);
    }
  } finally { h.events.get("session_shutdown")!({}, h.ctx); }
  const bad = extensionHarness("tui", { "toolview-cache-mb": "NaN" });
  try {
    bad.events.get("session_start")!({}, bad.ctx); assert.ok(bad.notices.some((text) => /invalid.*using 8 MiB/u.test(text)));
    await bad.commands.get("toolview")!.handler("cache", bad.ctx);
    assert.equal(JSON.parse(bad.notices.at(-1)!.replace("Pi Toolview cache: ", "")).limitBytes, 8 * 1024 * 1024);
  } finally { bad.events.get("session_shutdown")!({}, bad.ctx); }
});


test("actual SDK viewport caches work and permits detached tool collection with active adapter", () => {
  const probe = spawnSync(process.execPath, ["--expose-gc", "tests/fixtures/cache-probe.ts"], { encoding: "utf8", timeout: 20000 });
  assert.equal(probe.status, 0, probe.stderr);
  const records = JSON.parse(probe.stdout);
  assert.equal(records[0].segments, 88); assert.equal(records[1].segments, 0);
  assert.ok(records.some((record: { detachedToolCollected?: boolean }) => record.detachedToolCollected === true));
  mkdirSync(".test-artifacts/render-cache-proof", { recursive: true });
  writeFileSync(".test-artifacts/render-cache-proof/sdk.json", JSON.stringify(records, null, 2));
});


test("forced compact Bash invalidates all displayed parameters on reused mutable argument updates", () => {
  const args = { command: "echo ok", timeout: 1 }, tool = new Tool("bash", args);
  const { root, controller } = setup([tool], { compact: ["bash"] });
  try {
    assert.ok(root.render(80).some((row) => plain(row).includes("timeout=1")));
    args.timeout = 2; tool.updateArgs(args);
    assert.ok(root.render(80).some((row) => plain(row).includes("timeout=2")));
    assert.equal(controller.cacheStats().builds, 2);
  } finally { controller.restore(); }
});
