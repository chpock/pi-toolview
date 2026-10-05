// Offline real-CLI fixture: built-ins stay real unless the isolated bash-shape opt-in is set.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, Type, type ToolCall } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export default function terminalDriver(pi: ExtensionAPI) {
  const output = process.env.TOOLVIEW_TEST_OUTPUT!;
  let tui: any;
  const record = (event: object) => appendFileSync(join(output, "events.jsonl"), JSON.stringify(event) + "\n");
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  // Opt-in UI-clock observations only: real timers/render requests, no model/session mutation.
  const spinnerDiagnostics = process.env.TOOLVIEW_TEST_SPINNER_DIAGNOSTICS === "1";
  const spinnerStats = { starts: 0, stops: 0, active: 0, maxActive: 0, ticks: 0, requests: 0, intervals: [] as number[] };
  let insideSpinnerTick = false;
  const spinnerWork = { widths: {} as Record<string, number>, invalidations: 0 };
  const observedSpinnerNodes = new WeakSet<object>();
  function observedToolRender(this: any, width: number) {
    const key = `${this.toolName}:${width}`; spinnerWork.widths[key] = (spinnerWork.widths[key] ?? 0) + 1;
    return Object.getPrototypeOf(this).render.call(this, width);
  }
  function observedToolInvalidate(this: any) {
    spinnerWork.invalidations++;
    return Object.getPrototypeOf(this).invalidate.call(this);
  }
  const spinnerHandles = new Set<ReturnType<typeof setInterval>>();
  const nativeInterval = globalThis.setInterval, nativeClear = globalThis.clearInterval;
  let nativeRequest: (() => void) | undefined;
  if (spinnerDiagnostics) {
    globalThis.setInterval = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (callback.name !== "tickSpinner") return nativeInterval(callback, delay, ...args);
      const handle = nativeInterval(function (this: unknown, ...values: unknown[]) {
        spinnerStats.ticks++; insideSpinnerTick = true;
        try { callback.apply(this, values); }
        finally { insideSpinnerTick = false; }
        if ([4, 20].includes(spinnerStats.ticks)) record({ type: "spinner_tick_checkpoint", ticks: spinnerStats.ticks });
      }, delay, ...args);
      spinnerHandles.add(handle); spinnerStats.starts++; spinnerStats.active = spinnerHandles.size;
      spinnerStats.maxActive = Math.max(spinnerStats.maxActive, spinnerStats.active); spinnerStats.intervals.push(delay ?? 0);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
      if (spinnerHandles.delete(handle)) { spinnerStats.stops++; spinnerStats.active = spinnerHandles.size; }
      nativeClear(handle);
    }) as typeof clearInterval;
    pi.on("session_shutdown", () => {
      globalThis.setInterval = nativeInterval; globalThis.clearInterval = nativeClear;
      if (nativeRequest && tui) tui.requestRender = nativeRequest;
    });
  }
  async function gate(name: string, signal?: AbortSignal) {
    const end = Date.now() + 15000;
    while (!existsSync(join(output, name))) {
      if (signal?.aborted || Date.now() > end) throw new Error(`Fixture gate expired: ${name}`);
      await wait(25);
    }
  }
  // Representative AFT-shaped results only; this never loads or executes installed AFT.
  // It must be enabled in a separate invocation, never in the built-in scenarios.
  const bashShape = process.env.TOOLVIEW_TEST_BASH_SHAPE === "1";
  if (bashShape) pi.registerTool({
    name: "bash", label: "Representative bash fixture", description: "Isolated deterministic bash-shaped result fixture",
    parameters: Type.Object({ command: Type.String(), description: Type.Optional(Type.String()),
      workdir: Type.Optional(Type.String()), fixtureCase: Type.String() }),
    async execute(_id, args, signal, onUpdate) {
      const text = (value: string) => [{ type: "text" as const, text: value }];
      const row = (count: number) => Array.from({ length: count }, (_, i) => `SHAPE_ROW_${String(i + 1).padStart(2, "0")}`).join("\n");
      const result = (value: string, code?: unknown, isError = false) => ({ content: text(value),
        details: code === undefined ? undefined : { exit_code: code }, isError });
      switch (args.fixtureCase) {
        case "literal": return { content: [...text("(no output)\nBackground task started: task-id-123"),
          ...text("[exit code: 99]\nCommand exited with code 77")], details: undefined };
        case "whitespace": return result(" \t\n\r\n  ");
        case "ten": return result(row(10));
        case "eleven": return result(row(11));
        case "soft": return result("S".repeat(221));
        case "edges": return result(" \n\n  INDENT  \n\nTAIL  \n \t");
        case "exit": return result("SHAPE_DIAGNOSTIC", 7);
        case "both": return result("SHAPE_DIAGNOSTIC", -2, true);
        case "zero-error": return result("SHAPE_DIAGNOSTIC", 0, true);
        case "unknown-error": return result("SHAPE_DIAGNOSTIC", undefined, true);
        case "zero": return result("SHAPE_OK", 0);
        case "string": return result("SHAPE_OK", "9");
        case "null": return result("SHAPE_OK", null);
        case "transient": return { ...result("SHAPE_OK"), structuredContent: { exit_code: 9 } };
        // Presentation-exception scenarios are separate from the original fourteen shape cases.
        case "suffix-match": return result("BODY\n \t\n[exit code: 7]\n\n \t", 7);
        case "suffix-only": return result("\n[exit code: 7]", 7);
        case "suffix-mismatch": return result("BODY\n\n[exit code: 8]", 7);
        case "suffix-no-gap": return result("BODY\n[exit code: 7]", 7);
        case "suffix-combined": return result("BODY\n\n[exit code: -2; error: execution failed]", -2, true);
        case "suffix-error-only": return result("BODY\n\n[error: execution failed]", undefined, true);
        case "suffix-error-mismatch": return result("BODY\n\n[exit code: 7]", 7, true);
        case "suffix-success": return result("BODY\n\n[exit code: 0]", 0);
        case "suffix-unknown": return result("BODY\n\n[exit code: 7]");
        case "suffix-string": return result("BODY\n\n[exit code: 7]", "7");
        case "suffix-indent": return result("BODY\n\n [exit code: 7]", 7);
        case "suffix-spaces": return result("BODY\n\n[exit code: 7] ", 7);
        case "suffix-fragment": return result("BODY\n\nPREFIX [exit code: 7]", 7);
        case "suffix-nonterminal": return result("BODY\n\n[exit code: 7]\nAFTER_SUFFIX", 7);
        case "suffix-double": return result("BODY\n\n[exit code: 7]\n\n[exit code: 7]", 7);
        case "preview-one-blank": return result(row(9) + "\n\nHIDDEN_TAIL");
        case "preview-two-blanks": return result(row(9) + "\n\n \t\nHIDDEN_TAIL");
        case "preview-interior": return result(row(3) + "\n\n" + row(5) + "\n\nHIDDEN_TAIL");
        case "preview-empty": return result(" ".repeat(1100) + "HIDDEN_TAIL");
        case "suffix-deep": return result(row(9) + "\n\nEXTRA_CONTENT\nHIDDEN_TAIL\n\n[exit code: 7]", 7);
        case "exception-stream": {
          const value = row(9) + "\n\n[exit code: 7]";
          onUpdate?.(result(value, 7));
          record({ type: "shape_exception_gate", stage: 1 });
          await gate("shape-exception-final", signal);
          return result(value, 7);
        }
        case "stream":
          onUpdate?.(result("OLD_PARTIAL\n" + row(11), 7, true));
          record({ type: "shape_gate", stage: 1 });
          await gate("shape-next", signal);
          onUpdate?.(result("REPLACEMENT_PARTIAL", -2, true));
          record({ type: "shape_gate", stage: 2 });
          await gate("shape-final", signal);
          return result("FINAL_ONLY", 7, true);
        default: return result("SHAPE_OK");
      }
    },
  });
  const bashReal: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "bash", arguments: { command: "cat <<'TV_EOF'\n  HEREDOC_INDENT\nHEREDOC_END\nTV_EOF\nprintf 'AFTER_HEREDOC\\n'" } },
    { name: "bash", arguments: { command: "printf '%s\\n' '" + "LONG_WORD".repeat(30) + "'" } },
    { name: "bash", arguments: { command: "for i in $(seq 1 11); do printf 'REAL_ROW_%02d\\n' \"$i\"; done" } },
    { name: "bash", arguments: { command: "printf 'REAL_ERROR\\n'; exit 7" } },
  ];
  // Real built-in execution. Python input/output are relative to the owned test workspace.
  const bashWidth: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "bash", arguments: { command: "printf '" + "LONGWORD".repeat(30) + "'" } },
    { name: "bash", arguments: { command: "python3 -c \"from pathlib import Path; import re; s=Path('index.html').read_text(); m=re.search(r'<script>(.*?)</script>', s, re.S); assert m; Path('neon-blocks-check.js').write_text(m.group(1))\" && node --check neon-blocks-check.js" } },
  ];
  // Explicit cache-only provider scenario; every shell call still uses the real built-in tool.
  const cacheSuite: Pick<ToolCall, "name" | "arguments">[] = [
    ...Array.from({ length: 8 }, (_, index) => ({ name: "bash", arguments: {
      command: `for i in $(seq 1 1000); do printf 'CACHE_OUTPUT_${index}_%04d_ASCII_PAYLOAD\\n' "$i"; done`,
    } })),
    { name: "read", arguments: { path: "a.txt", offset: 1, limit: 1 } },
    { name: "read", arguments: { path: "b.txt" } },
    { name: "tv_hidden", arguments: {} },
  ];
  const shapeCases = ["literal", "whitespace", "ten", "eleven", "soft", "edges", "exit", "both", "zero-error", "unknown-error", "zero", "string", "null", "transient"];
  const bashShapes: Pick<ToolCall, "name" | "arguments">[] = shapeCases.map((fixtureCase, index) => ({
    name: "bash", arguments: { command: "shape " + fixtureCase, fixtureCase,
      ...(index === 0 ? { description: "Representative task description", workdir: "../other/./dir" } : {}),
      ...(index === 1 ? { workdir: "." } : {}),
      ...(index === 2 ? { workdir: process.cwd() } : {}),
    },
  }));
  const exceptionCases = ["suffix-match", "suffix-mismatch", "suffix-no-gap", "suffix-combined", "suffix-error-only",
    "suffix-error-mismatch", "suffix-success", "suffix-unknown", "suffix-string", "suffix-indent", "suffix-spaces",
    "suffix-fragment", "suffix-nonterminal", "suffix-double", "preview-one-blank", "preview-two-blanks", "preview-interior", "preview-empty", "suffix-deep", "suffix-only"];
  const bashExceptions: Pick<ToolCall, "name" | "arguments">[] = exceptionCases.map((fixtureCase) => ({
    name: "bash", arguments: { command: "shape " + fixtureCase, fixtureCase },
  }));
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
      if ("fixtureError" in args && args.fixtureError === true) throw new Error("ERROR_BODY_SENTINEL first line\nERROR_STACK_SENTINEL second line");
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
  const commaWrap: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "tv_summary", arguments: { scope: [
      "experiments/gruvbox-dark-hard/semantic-implementation-review.md",
      "experiments/gruvbox-dark-hard/semantic-implementation.md",
      "experiments/gruvbox-dark-hard/semantic-analysis.md",
    ] } },
    { name: "tv_summary", arguments: { target: [
      "agent/npm/node_modules/pi-subagents/src/runs/shared/single-output.js",
      "agent/npm/node_modules/pi-subagents/src/shared/artifacts.js",
      "agent/npm/node_modules/pi-subagents/src/runs/background/async-execution.js",
    ] } },
    { name: "tv_summary", arguments: { drop: Array.from({ length: 60 }, (_, i) => i + 1).join(",") } },
  ];
  const compactErrors: Pick<ToolCall, "name" | "arguments">[] = [
    { name: "read", arguments: { path: "missing/" + "r".repeat(90) + ".txt", offset: 3, limit: 7 } },
    { name: "tv_summary", arguments: { pattern: "needle", path: "src/文件/" + "p".repeat(40), query: "a,b,c,".repeat(8), fixtureError: true } },
    { name: "tv_summary", arguments: { target: ["src/" + "t".repeat(50), "tests/文件/" + "u".repeat(40)], query: "named", fixtureError: true } },
    { name: "tv_summary", arguments: { query: "SUCCESS_CALL" } },
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
      // The opt-in eight-output cache scenario must not trigger unrelated automatic compaction.
      input: ["text", "image"], contextWindow: process.env.TOOLVIEW_TEST_CACHE_DIAGNOSTICS === "1" ? 512000 : 32000, maxTokens: 1024,
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
        const scenario = prompt === "run cache-performance" ? "cache-performance" : prompt?.includes("bash-width") ? "bash-width" : prompt?.includes("bash-stream") ? "bash-stream" : prompt?.includes("bash-real") ? "bash-real" :
          prompt?.includes("bash-shape-exception-stream") ? "bash-shape-exception-stream" : prompt?.includes("bash-shape-exceptions") ? "bash-shape-exceptions" :
          prompt?.includes("bash-shape-stream") ? "bash-shape-stream" : prompt?.includes("bash-shapes") ? "bash-shapes" :
          prompt?.includes("compact-errors") ? "compact-errors" : prompt?.includes("comma-wrap") ? "comma-wrap" : prompt?.includes("boundary") ? "boundary" : prompt?.includes("multiline") ? "multiline" : prompt?.includes("integration") ? "integration" :
          prompt?.includes("pending") ? "pending" : prompt?.includes("fallback") ? "fallback" :
          prompt?.includes("future") ? "future" : "suite";
        const results = context.messages.slice(last + 1).filter((m) => m.role === "toolResult");
        record({ type: "model_context", results: results.map((m: any) => ({
          name: m.toolName, content: m.content, isError: m.isError, details: m.details,
        })) });
        if (scenario.startsWith("bash-shape") && !bashShape) throw new Error("bash-shape scenario requires explicit isolated opt-in");
        if (["cache-performance", "bash-width", "bash-real", "bash-stream", "suite", "multiline"].includes(scenario) && bashShape) throw new Error("Built-in scenario cannot run with bash-shape opt-in");
        const calls: Pick<ToolCall, "name" | "arguments">[] = scenario === "cache-performance" ? cacheSuite : scenario === "bash-width" ? bashWidth : scenario === "bash-real" ? bashReal : scenario === "bash-shapes" ? bashShapes :
          scenario === "bash-shape-exceptions" ? bashExceptions :
          scenario === "bash-shape-exception-stream" ? [{ name: "bash", arguments: { command: "shape exception-stream", fixtureCase: "exception-stream" } }] :
          scenario === "bash-shape-stream" ? [{ name: "bash", arguments: { command: "shape stream", description: "Streaming comment", fixtureCase: "stream" } }] :
          scenario === "bash-stream" ? [{ name: "bash", arguments: { command:
            "for i in $(seq 1 12); do printf 'LIVE_ROW_%02d\\n' \"$i\"; done\n" +
            "touch \"$TOOLVIEW_TEST_OUTPUT/shell-ready\"\n" +
            "while [ ! -f \"$TOOLVIEW_TEST_OUTPUT/shell-final\" ]; do sleep 0.025; done\n" +
            "printf 'LIVE_FINAL\\n'" } }] : scenario === "boundary" ? [
          { name: "read", arguments: { path: "abcdefghijklm", limit: 1 } },
          { name: "tv_summary", arguments: { path: "abcdefghijklm", query: "x".repeat(40) } },
        ] : scenario === "compact-errors" ? compactErrors : scenario === "comma-wrap" ? commaWrap : scenario === "multiline" ? multiline : scenario === "integration" ? [
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
          if ((scenario === "pending" || scenario === "bash-stream") && step === 0) {
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
      if (spinnerDiagnostics) {
        nativeRequest = tui.requestRender;
        tui.requestRender = () => { if (insideSpinnerTick) spinnerStats.requests++; nativeRequest!(); };
      }
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
  pi.on("tool_execution_update", (event) => record({ type: "execution_update", name: event.toolName, partialResult: event.partialResult }));
  pi.on("agent_end", () => record({ type: "agent_end" }));
  pi.registerCommand("tv-theme", {
    description: "Set a built-in theme for this isolated terminal",
    handler: async (name, ctx) => {
      const result = ctx.ui.setTheme(name);
      record({ type: "theme", name, result });
      ctx.ui.notify(`TERMINAL_THEME ${name}`, "info");
    },
  });
  // Native component update probe is opt-in, UI-only and never mutates model/session objects.
  if (process.env.TOOLVIEW_TEST_CACHE_DIAGNOSTICS === "1") {
    const replacements = new Map<string, { node: any; original: any; replacement: any }>();
    pi.registerCommand("tv-cache-update", {
      description: "Isolated cache regression: update one native result, reuse it, or restore it",
      handler: async (args, ctx) => {
        const [id, operation, extra] = args.trim().split(/\s+/u);
        if (!id || extra || !["replace", "reuse", "restore"].includes(operation)) throw new Error("Invalid cache update probe");
        if (operation === "replace") {
          if (replacements.has(id)) throw new Error("Restore the previous cache probe first");
          const nodes: any[] = [];
          const visit = (node: any) => {
            if (!node || nodes.includes(node)) return;
            nodes.push(node);
            for (const child of node.children ?? []) visit(child);
          };
          visit(tui);
          const node = nodes.find((item) => item.toolCallId === id && item.toolName === "bash" && typeof item.updateResult === "function");
          if (!node?.result || node.isPartial) throw new Error("Cache probe requires a completed real bash component");
          const replacement = structuredClone(node.result);
          replacement.content = [{ type: "text", text: "CACHE_UPDATE_REPLACED\n" }];
          replacements.set(id, { node, original: node.result, replacement });
          node.updateResult(replacement, false);
        } else {
          const saved = replacements.get(id);
          if (!saved) throw new Error("No cache probe to reuse/restore");
          if (operation === "reuse") {
            saved.replacement.content[0].text = "CACHE_UPDATE_REUSED\n";
            saved.node.updateResult(saved.replacement, false);
          } else {
            saved.node.updateResult(saved.original, false);
            replacements.delete(id);
          }
        }
        tui.requestRender();
        ctx.ui.notify(`TERMINAL_CACHE_UPDATE ${id} ${operation}`, "info");
      },
    });
    pi.on("session_shutdown", () => {
      for (const { node, original } of replacements.values()) node.updateResult(original, false);
      replacements.clear();
    });
  }
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
      if (spinnerDiagnostics) for (const node of tools) {
        if (observedSpinnerNodes.has(node)) continue;
        observedSpinnerNodes.add(node); node.render = observedToolRender; node.invalidate = observedToolInvalidate;
      }
      writeFileSync(join(output, `${name}.json`), JSON.stringify({
        session: ctx.sessionManager.getSessionFile(), width, cwd: ctx.cwd, bashShape,
        ...(spinnerDiagnostics ? { spinnerStats, spinnerWork } : {}),
        selectionActive: typeof tui.hasActiveSelection === "function" ? tui.hasActiveSelection() : false,
        frameStyles: {
          border: ctx.ui.theme.fg("borderMuted", "┃"),
          errorBorder: ctx.ui.theme.fg("error", "┃"),
        },
        registrations: pi.getAllTools().map((tool) => tool.name),
        commands: pi.getCommands().map((command) => command.name),
        errorStyle: ctx.ui.theme.fg("error", "TERMINAL_ERROR"),
        summaryStyles: Object.fromEntries((["dim", "toolTitle", "muted", "toolOutput", "error"] as const)
          .map((role) => [role, ctx.ui.theme.fg(role, "X")])),
        backgroundStyles: Object.fromEntries((["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const)
          .map((role) => [role, ctx.ui.theme.bg(role, "X")])),
        // Read actual command notifications, not production globals, private hooks or test events.
        cacheDiagnostics: nodes.flatMap((node) => {
          if (typeof node.text !== "string") return [];
          const text = stripVTControlCharacters(node.text);
          const prefix = "Pi Toolview cache: ";
          const start = text.indexOf(prefix + "{");
          return start < 0 ? [] : [JSON.parse(text.slice(start + prefix.length))];
        }),
        extensionIssues: nodes.filter((node) => node.constructor.name === "ThemedText")
          .map((node) => node.render(width)).filter((rows: string[]) => rows.some((row) => row.includes("[Extension issues]"))),
        tools: tools.map((node) => ({ name: node.toolName, id: node.toolCallId,
          expanded: node.expanded, executionStarted: node.executionStarted, isError: node.result?.isError,
          content: node.result?.content, details: node.result?.details, structuredContent: node.result?.structuredContent,
          args: node.args, partial: node.isPartial, lines: node.render(width),
          ...(spinnerDiagnostics ? { before: parents.get(node)?.children.slice(Math.max(0, parents.get(node).children.indexOf(node) - 3), parents.get(node).children.indexOf(node))
            .map((previous: any) => ({ kind: previous.constructor.name, name: previous.toolName, lines: previous.render(width).map(stripVTControlCharacters) })) } : {}),
          // Pointer/clock-work captures inspect only actual viewport paint; alternate widths intentionally rebuild layouts and width zero stops/restarts animation.
          ...(name.startsWith("pointer-") || spinnerDiagnostics ? {} : { narrowLines: node.render(24),
            tinyLines: Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8].map((size) => [size, node.render(size)])) }) })),
        document: parents.get(tools[0])?.render(width),
        branch: ctx.sessionManager.getBranch(),
      }, null, 2));
      ctx.ui.notify(`TERMINAL_CAPTURE ${name}`, "info");
    },
  });
}
