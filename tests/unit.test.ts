import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import toolview, { installToolview, describeArgs, sanitize, type ToolviewOptions } from "../src/index.ts";

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
class Root extends Container {
  requests = 0;
  requestRender() { this.requests++; }
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
  result: { content: { type: string; text?: string }[]; isError?: boolean } | undefined =
    { content: [{ type: "text", text: "FULL_OUTPUT" }] };
  constructor(name = "read", args: Record<string, unknown> = { path: "a.txt" }) {
    super(); this.toolName = name; this.args = args;
  }
  updateResult(result: Tool["result"], partial = false) { this.result = result; this.isPartial = partial; }
  updateArgs(args: Record<string, unknown>) { this.args = args; }
  setExpanded(value: boolean) { this.expanded = value; }
  getRenderContext() { return {}; }
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

function extensionHarness(mode: "tui" | "print" | "json" | "rpc" = "tui") {
  const root = new Root(); root.addChild(new Tool());
  const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const flags = new Map<string, unknown>();
  const widgets: string[] = [], notices: string[] = [];
  const api = {
    on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => void) => events.set(name, handler),
    registerCommand: (name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> }) => commands.set(name, command),
    registerFlag: (name: string, options: unknown) => flags.set(name, options),
    getFlag: () => undefined,
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
    assert.equal(h.flags.size, 2);
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
    ["custom", { pattern: "", path: "", target: "other", query: "why" }, '"" in "" [query="why", target="other"]'],
    ["aft_search", { includeTests: false, query: "where is auth", path: "/repo" }, '/repo [query="where is auth", includeTests=false]'],
    ["aft_outline", { target: ["src", "tests"], files: true }, '["src","tests"] [files=true]'],
    ["aft_inspect", { sections: "diagnostics", scope: ["src", "tests"] }, '["src","tests"] [sections="diagnostics"]'],
    ["aft_zoom", { path: "a.ts", symbols: ["render", "update"], callgraph: true }, 'a.ts [symbols=["render","update"], callgraph=true]'],
    ["aft_callgraph", { depth: 2, symbol: "render", path: "a.ts", op: "callers" }, 'a.ts [op="callers", symbol="render", depth=2]'],
    ["ast_grep_search", { paths: ["src"], lang: "typescript", pattern: "$X($$$)" }, '"$X($$$)" [lang="typescript", paths=["src"]]'],
    ["ast_grep_replace", { rewrite: "BULKY", pattern: "foo()", lang: "typescript" }, '"foo()" [lang="typescript"]'],
    ["TaskCreate", { description: "Investigate", subject: "Rendering" }, '[subject="Rendering", description="Investigate"]'],
    ["TaskUpdate", { status: "completed", taskId: "1" }, '[status="completed", taskId="1"]'],
    ["Agent", { prompt: "BULKY", subagent_type: "reviewer", description: "Review" }, '[description="Review", subagent_type="reviewer"]'],
    ["ctx_memory", { content: "BULKY", category: "CONSTRAINTS", action: "write" }, '[action="write", category="CONSTRAINTS"]'],
    ["web_search", { numResults: 5, queries: ["one", "two"] }, '[queries=["one","two"], numResults=5]'],
    ["fetch_content", { url: "https://example.com", prompt: "BULKY", mode: "answer" }, 'https://example.com [mode="answer"]'],
    ["aft_safety", { name: "snap", op: "checkpoint", files: ["src/a.ts"] }, '[op="checkpoint", files=["src/a.ts"], name="snap"]'],
    ["custom", { pattern: null, path: { id: 1 }, target: "valid", zero: 0, flag: false, empty: "", nullable: null }, 'valid [empty="", flag=false, nullable=null, path={"id":1}, pattern=null, zero=0]'],
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
  assert.equal(describeArgs("custom", { target: [], pattern: 0 }), '[] [pattern=0]');
  assert.equal(describeArgs("custom", { scope: "src", paths: ["tests"], url: null }), 'src [paths=["tests"], url=null]');
});

test("important fields precede locale-independent alphabetical keys regardless of input order", () => {
  const first = { zebra: 1, startLine: 2, query: "q", endLine: 3, alpha: 4, Alpha: 5, symbol: "s" };
  const second = Object.fromEntries(Object.entries(first).reverse());
  const expected = '[query="q", symbol="s", startLine=2, endLine=3, Alpha=5, alpha=4, zebra=1]';
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
