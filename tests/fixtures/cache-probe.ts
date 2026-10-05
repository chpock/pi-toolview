// Isolated actual-SDK work/ownership oracle; no real tools or user settings are touched.
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { Container, ScrollView } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installToolview } from "../../src/index.ts";

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
  if (enabled && input.startsWith("CACHE_PROBE_")) segments++;
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
  controller.setCacheLimitMiB(0); assert.equal(controller.cacheStats().retainedBytes, 0);
  const disabled = frame("zero-budget", 81); assert.equal(disabled.segments, 88); assert.equal(disabled.entries, 0);
  controller.setCacheLimitMiB(8); frame("refill", 81);
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
  console.log(JSON.stringify(observations));
} finally { controller.restore(); Intl.Segmenter.prototype.segment = original; }
