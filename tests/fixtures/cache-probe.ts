// Isolated actual-SDK work/ownership oracle; no real tools or user settings are touched.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, ScrollView, Spacer, Text } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { UserMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/user-message.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import toolview, { installToolview } from "../../src/index.ts";
import { InteractiveMode } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { CustomEditor, getSelectListTheme, createWriteToolDefinition, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

initTheme("dark", false);
class Root extends Container { requestRender() {} }
const root = new Root(), viewport = new ScrollView(root, { scrollbar: "hidden", follow: "none", primary: true });
const output = Array.from({ length: 1000 }, (_, i) => `CACHE_PROBE_${i}_` + "x".repeat(50)).join("\n");
const tools: (ToolExecutionComponent | undefined)[] = Array.from({ length: 8 }, (_, i) => {
  const node = new ToolExecutionComponent("bash", `cache-${i}`, { command: `printf command_${i}` },
    undefined, undefined, root as never, "/tmp");
  node.updateResult({ content: [{ type: "text", text: output }], isError: false }); root.addChild(node); return node;
});
let enabled = false, segments = 0;
const original = Intl.Segmenter.prototype.segment;
Intl.Segmenter.prototype.segment = function (input) {
  if (enabled && (input.startsWith("CACHE_PROBE_") || input.startsWith("WRITE_CACHE_PROBE_"))) segments++;
  return original.call(this, input);
};
root.render(80);
const controller = installToolview(root as never, () => theme);
const observations: object[] = [];
function frame(label: string, width = 80) {
  segments = 0; enabled = true;
  const result = renderLayoutFrame(viewport, width, 24, () => {});
  enabled = false;
  const observed = { label, segments, visibleRows: result.lines.length, ...controller.cacheStats() };
  observations.push(observed); return observed;
}
try {
   const cold = frame("cold"); assert.equal(cold.segments, 88); assert.equal(cold.builds, 8);
  for (const label of ["unchanged-1", "unchanged-2", "scroll"]) {
    if (label === "scroll") viewport.scrollBy(1);
    const same = frame(label); assert.equal(same.segments, 0); assert.equal(same.builds, 8); assert.equal(same.visibleRows, 24);
  }
  tools[3]!.updateResult({ content: [{ type: "text", text: output }], isError: false });
  const changed = frame("one-result"); assert.equal(changed.segments, 11); assert.equal(changed.builds, 9);
  const resized = frame("resize", 81); assert.equal(resized.segments, 88); assert.equal(resized.builds, 17);
  assert.equal(frame("same-resize", 81).segments, 0);
  tools[0]!.setExpanded(true);
  const expanded = frame("expand", 81); assert.equal(expanded.segments, 1000); assert.equal(expanded.builds, 18);
  assert.equal(frame("same-expand", 81).segments, 0);
  tools[0]!.setExpanded(false); assert.equal(frame("collapse", 81).segments, 11);
  controller.setCacheLimitMiB(0); controller.setCardCacheLimitMiB(0); assert.equal(controller.cacheStats().retainedBytes, 0);
  const disabled = frame("zero-budget", 81); assert.equal(disabled.segments, 88); assert.equal(disabled.entries, 0);
  controller.setCacheLimitMiB(8); controller.setCardCacheLimitMiB(128); frame("refill", 81);
  // Remove one node while its cached rendered data can still be in the bounded recency list.
  // Refresh host mouse layout, which independently owns references to formerly rendered children.
  const detach = () => {
    const removed = tools[0]!, reference = new WeakRef(removed);
    root.removeChild(removed); tools[0] = undefined;
    return reference;
  };
  const reference = detach();
  frame("removed", 81);
  assert.equal(typeof globalThis.gc, "function", "run with --expose-gc");
  for (let i = 0; i < 12; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc!();
  }
  assert.equal(reference.deref() === undefined, true, "cache/adapter must not retain a detached tool component");
  observations.push({ detachedToolCollected: true, ...controller.cacheStats() });
  controller.clearCache(); assert.equal(controller.cacheStats().retainedBytes, 0); assert.equal(controller.cacheStats().entries, 0);
  frame("after-clear", 81);
  controller.restore(); assert.equal(controller.cacheStats().retainedBytes, 0); assert.equal(controller.cacheStats().entries, 0);
  observations.push({ afterRestore: controller.cacheStats() });
  const compactRoot = new Root(), sharedArgs = { command: "echo ok", timeout: 1 };
  const compactNode = new ToolExecutionComponent("bash", "compact-mutable", sharedArgs,
    undefined, undefined, compactRoot as never, "/tmp");
  compactRoot.addChild(compactNode);
  const compactController = installToolview(compactRoot as never, () => theme, { compact: ["bash"] });
  try {
    assert.ok(compactRoot.render(80).some((row) => row.includes("timeout=1")));
    sharedArgs.timeout = 2; compactNode.updateArgs(sharedArgs);
    assert.ok(compactRoot.render(80).some((row) => row.includes("timeout=2")));
    assert.equal(compactController.cacheStats().builds, 2);
    observations.push({ compactBashMutationUpdated: true, ...compactController.cacheStats() });
  } finally { compactController.restore(); }
   // The first installer is genuinely executing while the adapter owns its animation clock.
  const spinnerRoot = new Root(), spinnerViewport = new ScrollView(spinnerRoot, { scrollbar: "hidden", primary: true });
  let spinning: ToolExecutionComponent | undefined = new ToolExecutionComponent("read", "spinner-owner", { path: "a.txt", limit: 1 },
    undefined, undefined, spinnerRoot as never, "/tmp");
  spinnerRoot.addChild(spinning);
  const spinnerController = installToolview(spinnerRoot as never, () => theme);
  const spinnerFrame = () => renderLayoutFrame(spinnerViewport, 80, 24, () => {}).lines.map(stripVTControlCharacters);
  try {
    const before = spinnerFrame(), builds = spinnerController.cacheStats().builds;
    spinning.markExecutionStarted(); const cold = spinnerFrame();
    assert.equal(cold[0]![1], "⠋");
    assert.deepEqual(cold.map((row) => row.slice(3)), before.map((row) => row.slice(3)));
    assert.equal(spinnerController.cacheStats().builds, builds, "actual native execution-start notification preserves cached argument layout");
    const reference = new WeakRef(spinning);
    const glyphs = new Set([cold[0]![1]]);
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      const warm = spinnerFrame(); glyphs.add(warm[0]![1]);
      assert.deepEqual(warm.map((row) => row.slice(3)), cold.map((row) => row.slice(3)));
      assert.equal(spinnerController.cacheStats().builds, builds, "actual SDK animation changes no cached argument layout");
    }
    assert.ok(glyphs.size >= 3, "real timer advances the actual SDK viewport prefix");
    const stillRunning = new ToolExecutionComponent("custom", "spinner-still-running", { query: "keep clock active" },
      undefined, undefined, spinnerRoot as never, "/tmp");
    spinnerRoot.addChild(stillRunning); stillRunning.markExecutionStarted(); spinnerFrame();
    spinnerRoot.removeChild(spinning); spinning = undefined; spinnerFrame();
    for (let i = 0; i < 12; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve)); globalThis.gc!();
    }
    assert.equal(reference.deref(), undefined, "adapter/active shared clock must not retain its first installer while a second tool is still running");
    observations.push({ animatedFirstInstallerCollected: true, spinnerFramesObserved: glyphs.size,
      spinnerBuilds: builds, spinnerCacheBuildsUnchanged: true });
  } finally { spinnerController.restore(); }
   const userRoot = new Root(), userViewport = new ScrollView(userRoot, { scrollbar: "hidden", primary: true });
   let user: UserMessageComponent | undefined = new UserMessageComponent("FIRST_USER_INSTALLER\n\n**native Markdown**");
   userRoot.addChild(user);
   const userController = installToolview(userRoot as never, () => theme);
   try {
     const draw = () => renderLayoutFrame(userViewport, 80, 24, () => {}).lines;
     draw(); assert.equal(userController.cacheStats().builds, 1);
     draw(); assert.equal(userController.cacheStats().builds, 1);
     const reference = new WeakRef(user);
     userRoot.removeChild(user); user = undefined; draw();
     for (let i = 0; i < 12; i++) {
       await new Promise<void>((resolve) => setImmediate(resolve)); globalThis.gc!();
     }
     assert.equal(reference.deref(), undefined, "active user hooks/cache must not retain their first installer");
     observations.push({ firstUserInstallerCollected: true, userCache: userController.cacheStats() });
   } finally { userController.restore(); }
   const writeRoot = new Root(), writeViewport = new ScrollView(writeRoot, { scrollbar: "hidden", primary: true });
   let writeNode: ToolExecutionComponent | undefined = new ToolExecutionComponent("write", "first-write-installer",
     { path: "example.txt", content: "WRITE_CACHE_PROBE_" + "x".repeat(2000) }, undefined, createWriteToolDefinition("/tmp"), writeRoot as never, "/tmp");
   writeNode.updateResult({ content: [{ type: "text", text: "STOCK_WRITE_RESULT" }], isError: false }); writeRoot.addChild(writeNode);
   const writeController = installToolview(writeRoot as never, () => theme);
   const writeFrame = () => { segments = 0; enabled = true; renderLayoutFrame(writeViewport, 80, 24, () => {}); enabled = false; return segments; };
   try {
     assert.equal(writeFrame(), 1); const cold = writeController.cacheStats();
     assert.equal(cold.cards.entries, 1); assert.equal(cold.ordinary.entries, 0);
     assert.equal(writeFrame(), 0); assert.equal(writeController.cacheStats().builds, cold.builds);
     const reference = new WeakRef(writeNode); writeRoot.removeChild(writeNode); writeNode = undefined; writeFrame();
     for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
     assert.equal(reference.deref(), undefined, "active write hooks and retained code rows do not own the first write installer");
     observations.push({ firstWriteInstallerCollected: true, writeColdSegments: 1, writeWarmSegments: 0, ...writeController.cacheStats() });
   } finally { writeController.restore(); }
    const editorRoot = Object.assign(new Root(), { terminal: { rows: 24 } });
    let editor: CustomEditor | undefined = new CustomEditor(editorRoot as never,
      { borderColor: text => theme.fg("border", text), selectList: getSelectListTheme() }, { matches: () => false } as never);
    const input = new Container(); input.addChild(editor);
    let upper: Container | undefined = new Container();
    upper.addChild(new Spacer(1)); upper.addChild(new Text("GC_UPPER_WIDGET", 0, 0));
    for (const child of [new Container(), new Container(), new Container(), upper, input, new Container(), new Container()]) editorRoot.addChild(child);
    const editorController = installToolview(editorRoot as never, () => theme, { editorStatus: true });
    try {
      editorRoot.render(80);
      assert.equal(editor.render(80)[0], "", "recognized upper group activates the first installer's separator");
      assert.ok(editor.render(80).some(row => row.includes("┃")));
      assert.equal(editorController.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }).length, 2);
      const reference = new WeakRef(editor), groupReference = new WeakRef(upper!);
      input.clear(); input.render(80); editorRoot.clear(); editorRoot.render(80); editor = undefined; upper = undefined;
      for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
      assert.equal(reference.deref(), undefined, "active editor prototype hooks/status widget must not retain their first installer or draft engine");
      assert.equal(groupReference.deref(), undefined, "upper-group measurement and transient spacer observation do not retain the first widget group");
      assert.deepEqual(editorController.renderEditorStatus(80, { model: "M", provider: "P", thinking: "off", idle: true }), []);
      observations.push({ firstEditorInstallerCollected: true, firstUpperGroupCollected: true, editorCache: editorController.cacheStats() });
    } finally { editorController.restore(); }
    const footerRoot = Object.assign(new Root(), { terminal: { rows: 24 }, setFocus() {} });
    const footerContainer = new Container(), aboveFooter = new Container(), belowFooter = new Container(), footerInput = new Container();
    const footerEditor = new CustomEditor(footerRoot as never,
      { borderColor: text => theme.fg("border", text), selectList: getSelectListTheme() }, { matches: () => false } as never);
    footerInput.addChild(footerEditor);
    const nativeFooter = new Text("NATIVE_FOOTER", 0, 0); footerContainer.addChild(nativeFooter);
    const footerHost = Object.assign(Object.create(InteractiveMode.prototype), { ui: footerRoot, footerContainer,
      footer: nativeFooter, footerDataProvider: { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
      defaultEditor: footerEditor, editor: footerEditor, editorContainer: footerInput, statusContainer: new Container(),
      widgetContainerAbove: aboveFooter, widgetContainerBelow: belowFooter,
      extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map() });
    for (const child of [new Container(), new Container(), footerHost.statusContainer, aboveFooter, footerInput, belowFooter, footerContainer]) footerRoot.addChild(child);
    const manager = SessionManager.inMemory("/tmp");
    const footerContext = { mode: "tui", cwd: "/tmp", ui: { ...footerHost.createExtensionUIContext(), notify() {} }, sessionManager: manager,
      getContextUsage: () => undefined, isIdle: () => true } as unknown as ExtensionContext;
    const handlers = new Map<string, Function[]>(); let footerCommand: Function;
    toolview({ on(name: string, callback: Function) { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
      registerFlag() {}, getFlag() {}, getThinkingLevel: () => "off", getSettings: () => ({}),
      registerCommand(name: string, options: { handler: Function }) { if (name === "toolview") footerCommand = options.handler; },
    } as unknown as ExtensionAPI);
    for (const callback of handlers.get("session_start") ?? []) callback({}, footerContext);
    const replaceFirstFooter = async () => {
      const first = footerHost.customFooter;
      first.render(80); const reference = new WeakRef(first);
      await footerCommand!("off", footerContext); assert.equal(footerContainer.children[0], nativeFooter);
      await footerCommand!("on", footerContext); assert.notEqual(footerHost.customFooter, first);
      assert.ok(footerHost.customFooter.render(80)[0].includes("↑"));
      return reference;
    };
    try {
      const reference = await replaceFirstFooter();
      for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => setImmediate(resolve)); globalThis.gc!(); }
      assert.equal(reference.deref(), undefined, "active runtime/events/next footer must not retain the first public footer component");
      observations.push({ firstFooterCollected: true });
    } finally { for (const callback of handlers.get("session_shutdown") ?? []) callback({}, footerContext); }
    console.log(JSON.stringify(observations));
} finally { controller.restore(); Intl.Segmenter.prototype.segment = original; }
