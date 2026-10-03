// Offline real-CLI fixture: built-in tools are observed, never replaced.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type ToolCall } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function terminalDriver(pi: ExtensionAPI) {
  const output = process.env.TOOLVIEW_TEST_OUTPUT!;
  let tui: any;
  const record = (event: object) => appendFileSync(join(output, "events.jsonl"), JSON.stringify(event) + "\n");
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  async function gate(name: string, signal?: AbortSignal) {
    const end = Date.now() + 15000;
    while (!existsSync(join(output, name))) {
      if (signal?.aborted || Date.now() > end) throw new Error(`Fixture gate expired: ${name}`);
      await wait(25);
    }
  }
  pi.registerTool({
    name: "tv_unknown", label: "Unknown fixture label", description: "Offline unknown text-only tool",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: `UNKNOWN_RESULT ${args.query}` }], details: undefined };
    },
  });
  pi.registerTool({
    name: "tv_stream", label: "Streaming fixture", description: "Offline gated streaming tool",
    parameters: Type.Object({ query: Type.String() }),
    async execute(_id, _args, signal, onUpdate) {
      onUpdate?.({ content: [{ type: "text", text: "STREAM_PARTIAL" }], details: undefined });
      record({ type: "tool_gate" });
      await gate("tool-go", signal);
      return { content: [{ type: "text", text: "STREAM_COMPLETE" }], details: undefined };
    },
  });
  pi.registerTool({
    name: "tv_hidden", label: "Hidden fixture", description: "Intentionally empty native renderer",
    parameters: Type.Object({}), renderShell: "self",
    renderCall: () => new Text("", 0, 0), renderResult: () => new Text("", 0, 0),
    async execute() {
      return { content: [{ type: "text", text: "HIDDEN_RESULT" }], details: undefined };
    },
  });
  // All credentials and payloads below are synthetic sentinels, not host data.
  const longReadPath = "long-directory/" + "r".repeat(180) + ".txt";
  pi.registerTool({
    name: "tv_summary", label: "Summary fixture", description: "Offline arbitrary JSON summary fixture",
    parameters: Type.Object({}, { additionalProperties: true }),
    async execute(_id, args) {
      return { content: [{ type: "text", text: "SUMMARY_RESULT " + JSON.stringify(args) }],
        details: { supplied: args } };
    },
  });
  pi.registerTool({
    name: "tv_noargs", label: "No arguments fixture", description: "Offline no-arguments tool",
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "NOARGS_RESULT" }], details: undefined }; },
  });
  pi.registerTool({
    name: "tv_card", label: "Self-shell card fixture", description: "Native self-shell renderer without padding",
    parameters: Type.Object({}), renderShell: "self",
    renderCall: (_args, theme) => new Text(theme.bg("toolSuccessBg", "NATIVE_CARD_CALL"), 0, 0),
    renderResult: (_result, _options, theme) => new Text(theme.bg("toolSuccessBg", "NATIVE_CARD_RESULT"), 0, 0),
    async execute() { return { content: [{ type: "text", text: "NATIVE_CARD_RESULT" }], details: undefined }; },
  });
  const multiline: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: "a.txt" } },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "read", arguments: { path: longReadPath, offset: 1, limit: 1 } },
    { name: "tv_hidden", arguments: {} },
    { name: "tv_noargs", arguments: {} },
    { name: "tv_noargs", arguments: {} },
    { name: "tv_summary", arguments: {
      zLast: "LAST_FIELD_VISIBLE", "odd key": "QUOTED_KEY", enabled: false, count: 0,
      empty: "", nothing: null, nested: { input: "NESTED_PAYLOAD_VISIBLE", token: "NESTED_TOKEN_VISIBLE", values: [false, 0, "nested quoted value"], clean: "clean\n \t nested\u202evalue" },
      sanitized: "white\n \tspace \u001b[31mred\u001b[0m\u202eend",
      token: "TOP_TOKEN_HIDDEN", password: "TOP_PASSWORD_HIDDEN", passwd: "TOP_PASSWD_HIDDEN", api_key: "TOP_API_KEY_HIDDEN",
      apiKey: "TOP_APIKEY_HIDDEN", authorization: "TOP_AUTHORIZATION_HIDDEN", Authorization: "TOP_AUTH_HIDDEN",
      access_token: "TOP_ACCESS_HIDDEN", refresh_token: "TOP_REFRESH_HIDDEN", secret: "TOP_SECRET_HIDDEN",
      content: "PAYLOAD_CONTENT_HIDDEN", edits: ["PAYLOAD_EDITS_HIDDEN"], code: "PAYLOAD_CODE_HIDDEN", input: "PAYLOAD_INPUT_HIDDEN",
      messages: ["PAYLOAD_MESSAGES_HIDDEN"], prompt: "PAYLOAD_PROMPT_HIDDEN", newString: "PAYLOAD_NEWSTRING_HIDDEN", oldString: "PAYLOAD_OLDSTRING_HIDDEN",
      appendContent: "PAYLOAD_APPEND_HIDDEN", rewrite: "PAYLOAD_REWRITE_HIDDEN", oldText: "PAYLOAD_OLDTEXT_HIDDEN", newText: "PAYLOAD_NEWTEXT_HIDDEN",
      maxTokens: 0, Content: "CASE_SENSITIVE_PAYLOAD_VISIBLE", Token: "CASE_SENSITIVE_TOKEN_VISIBLE",
      endLine: 0, startLine: 0, limit: 0, offset: 0, subject: "subject", command: "command", symbols: ["one", "two"], symbol: "symbol",
      action: "inspect", op: "trace", queries: ["first", "second"],
      query: "quoted \"query\"\\value 界 é " + "UNBREAKABLE".repeat(30) + " END_QUERY_VISIBLE",
      AFirst: "FIRST_ALPHA_VISIBLE",
    } },
    { name: "tv_hidden", arguments: {} },
    { name: "tv_card", arguments: {} },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "tv_summary", arguments: {
      paths: ["ordinary-path"], scope: "ordinary-scope", url: "https://example.invalid/ordinary", target: "ordinary-target",
      pattern: "needle \"quoted\"", path: ["src dir", "tests"], query: "always named", enabled: true,
    } },
    { name: "bash", arguments: { command: "printf 'MULTILINE_NATIVE_BASH\\n'" } },
    { name: "tv_summary", arguments: { pattern: 0, path: null, target: "chosen target", url: "ordinary-url", scope: "ordinary-scope", paths: ["ordinary-path"], query: "named" } },
    { name: "tv_summary", arguments: { path: "chosen-path", target: "ordinary-target", url: "ordinary-url", scope: "ordinary-scope", paths: ["ordinary-path"] } },
    { name: "tv_summary", arguments: { url: "https://example.invalid/chosen", scope: "ordinary-scope", paths: [], pattern: false } },
    { name: "tv_summary", arguments: { scope: [], paths: ["ordinary-path"] } },
    { name: "tv_summary", arguments: { paths: [] } },
    { name: "tv_summary", arguments: { pattern: "", path: [], query: "" } },
    { name: "tv_noargs", arguments: {} },
  ];
  const suite: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "bash", arguments: { command: "printf 'BASH_RESULT\\n'" } },
    { name: "write", arguments: { path: "written.txt", content: "WRITE_BEFORE\n" } },
    { name: "edit", arguments: { path: "written.txt", oldText: "WRITE_BEFORE", newText: "WRITE_AFTER" } },
    { name: "tv_unknown", arguments: { query: "wide 界 é query" } },
    { name: "read", arguments: { path: "missing.txt" } },
  ];
  pi.registerProvider("toolview-offline", {
    api: "toolview-offline", baseUrl: "http://127.0.0.1/unused", apiKey: "offline-fixture",
    models: [{ id: "scripted", name: "Offline terminal fixture", reasoning: false,
      input: ["text", "image"], contextWindow: 32000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: any = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      void (async () => {
        const last = context.messages.findLastIndex((m) => m.role === "user");
        const user: any = context.messages[last];
        const prompt = typeof user?.content === "string" ? user.content :
          user?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        const scenario = prompt?.includes("boundary") ? "boundary" : prompt?.includes("multiline") ? "multiline" : prompt?.includes("integration") ? "integration" :
          prompt?.includes("pending") ? "pending" : prompt?.includes("fallback") ? "fallback" :
          prompt?.includes("future") ? "future" : "suite";
        const results = context.messages.slice(last + 1).filter((m) => m.role === "toolResult");
        record({ type: "model_context", results: results.map((m: any) => ({
          name: m.toolName, content: m.content, isError: m.isError, details: m.details,
        })) });
        const calls: Pick<ToolCall, "name" | "arguments">[] = scenario === "boundary" ? [
          { name: "read", arguments: { path: "abcdefghijklm", limit: 1 } },
          { name: "tv_summary", arguments: { path: "abcdefghijklm", query: "x".repeat(40) } },
        ] : scenario === "multiline" ? multiline : scenario === "integration" ? [
          { name: "TaskCreate", arguments: { subject: "TERMINAL_LOCAL_TASK", description: "Offline installed renderer smoke; do not execute." } },
          { name: "TaskList", arguments: {} },
        ] : scenario === "pending" ? [
          { name: "read", arguments: { path: "a.txt" } },
          { name: "tv_stream", arguments: { query: "gated" } },
        ] : scenario === "fallback" ? [
          { name: "read", arguments: { path: "pixel.png" } },
          { name: "tv_hidden", arguments: {} },
        ] : scenario === "future" ? [
          { name: "tv_unknown", arguments: { query: "future after reload" } },
        ] : suite;
        const step = results.length;
        stream.push({ type: "start", partial: message });
        if (step < calls.length) {
          const call = { type: "toolCall" as const, id: `terminal-${last}-${step}`, ...calls[step] };
          message.content.push({ ...call, arguments: {} });
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          await wait(60);
          message.content[0] = call;
          stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(call.arguments), partial: message });
          if (scenario === "pending" && step === 0) {
            record({ type: "provider_gate" });
            await gate("provider-go", options?.signal);
          }
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          const text = `TERMINAL_DONE_${scenario}`;
          message.content.push({ type: "text", text });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      })().catch((error) => {
        record({ type: "provider_error", error: String(error) });
        message.stopReason = options?.signal?.aborted ? "aborted" : "error";
        message.errorMessage = String(error);
        stream.push({ type: "error", reason: message.stopReason, error: message });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("terminal-driver", (liveTui) => {
      tui = liveTui;
      record({ type: "start", sharedContainer: liveTui instanceof Container });
      return { render: () => [], invalidate() {} };
    });
    ctx.ui.setWidget("terminal-driver", undefined);
  });
  pi.on("tool_call", (event) => {
    record({ type: "call", name: event.toolName, input: event.input });
    // Installed-profile requests are restricted to the two audited, real local task tools.
    if (process.env.TOOLVIEW_TEST_PROFILE === "installed" && !["TaskCreate", "TaskList"].includes(event.toolName)) {
      record({ type: "unsafe_call_blocked", name: event.toolName });
      return { block: true, reason: "Installed-profile fixture only executes local TaskCreate/TaskList" };
    }
  });
  pi.on("tool_result", (event) => record({ type: "result", name: event.toolName,
    content: event.content, details: event.details, isError: event.isError }));
  pi.on("agent_end", () => record({ type: "agent_end" }));
  pi.registerCommand("tv-theme", {
    description: "Set a built-in theme for this isolated terminal",
    handler: async (name, ctx) => {
      const result = ctx.ui.setTheme(name);
      record({ type: "theme", name, result });
      ctx.ui.notify(`TERMINAL_THEME ${name}`, "info");
    },
  });
  pi.registerCommand("tv-dump", {
    description: "Inspect the actual live component tree (does not invoke mouse handlers)",
    handler: async (name, ctx) => {
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid capture name");
      const nodes: any[] = [];
      const parents = new Map<any, any>();
      function visit(node: any) {
        if (!node || nodes.includes(node)) return;
        nodes.push(node);
        for (const child of node.children ?? []) { parents.set(child, node); visit(child); }
      }
      visit(tui);
      const tools = nodes.filter((node) => typeof node.toolCallId === "string" && typeof node.updateResult === "function");
      const width = process.stdout.columns || 100;
      writeFileSync(join(output, `${name}.json`), JSON.stringify({
        session: ctx.sessionManager.getSessionFile(), width,
        registrations: pi.getAllTools().map((tool) => tool.name),
        commands: pi.getCommands().map((command) => command.name),
        errorStyle: ctx.ui.theme.fg("error", "TERMINAL_ERROR"),
        summaryStyles: Object.fromEntries((["dim", "toolTitle", "muted"] as const)
          .map((role) => [role, ctx.ui.theme.fg(role, "X")])),
        extensionIssues: nodes.filter((node) => node.constructor.name === "ThemedText")
          .map((node) => node.render(width)).filter((rows: string[]) => rows.some((row) => row.includes("[Extension issues]"))),
        tools: tools.map((node) => ({ name: node.toolName, id: node.toolCallId,
          expanded: node.expanded, isError: node.result?.isError,
          content: node.result?.content, lines: node.render(width), narrowLines: node.render(24),
          tinyLines: Object.fromEntries([0, 1, 2, 3, 4].map((size) => [size, node.render(size)])) })),
        document: parents.get(tools[0])?.render(width),
        branch: ctx.sessionManager.getBranch(),
      }, null, 2));
      ctx.ui.notify(`TERMINAL_CAPTURE ${name}`, "info");
    },
  });
}
