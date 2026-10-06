// Isolated real-CLI editor controls. Runs the production extension unchanged and
// observes drafts through a shortcut, never by submitting a capture command.
import { CustomEditor, type ExtensionAPI, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import toolview from "../../src/index.ts";

const identities = new WeakMap<object, number>();
let nextIdentity = 0;
export default function editorDriver(pi: ExtensionAPI) {
  const output = process.env.TOOLVIEW_TEST_OUTPUT!;
  let control: RegisteredCommand["handler"];
  let tui: any;
  toolview({ ...pi, registerCommand(name, options) {
    if (name === "toolview") control = options.handler;
    pi.registerCommand(name, options);
  } });
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setWidget("editor-probe", (value) => { tui = value; return { render: () => [], invalidate() {} }; });
    ctx.ui.setWidget("editor-probe", undefined);
  });
  pi.registerShortcut("ctrl+alt+d", {
    description: "Observe the unchanged draft or toggle production Toolview without submitting it",
    handler: async ctx => {
      const { name, action = "snapshot" } = JSON.parse(readFileSync(join(output, "editor-request.json"), "utf8"));
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid editor observation name");
      const nodes: any[] = [];
      const visit = (node: any) => { if (nodes.includes(node)) return; nodes.push(node); for (const child of node.children ?? []) visit(child); };
      visit(tui);
      const editor = nodes.find(node => Object.getPrototypeOf(node) === CustomEditor.prototype);
      if (!editor) throw new Error("Exported stock CustomEditor identity does not match the actual CLI editor");
      if (!identities.has(editor)) identities.set(editor, ++nextIdentity);
      const state = () => ({ text: editor.getText(), expanded: editor.getExpandedText(), cursor: editor.getCursor() });
      const before = state();
      if (action === "on" || action === "off") await control!(action, ctx as never);
      else if (action === "dark" || action === "light") ctx.ui.setTheme(action);
      else if (action !== "snapshot") throw new Error("Unknown editor action");
      const width = process.stdout.columns || 100;
      const rows = editor.render(width);
      writeFileSync(join(output, `${name}.json`), JSON.stringify({ width, rows, before, after: state(),
        identity: identities.get(editor), exactStockPrototype: true,
        sharedEditorPrototype: Object.getPrototypeOf(CustomEditor.prototype) === Editor.prototype,
        inputMethodUnchanged: editor.handleInput === CustomEditor.prototype.handleInput,
        padding: editor.getPaddingX(), menu: editor.isShowingAutocomplete(), session: ctx.sessionManager.getSessionFile(),
        styles: { border: ctx.ui.theme.fg("customMessageLabel", "┃"),
          text: ctx.ui.theme.fg("userMessageText", "X"), background: ctx.ui.theme.bg("userMessageBg", "X") },
      }, null, 2));
      tui.requestRender();
    },
  });
}
