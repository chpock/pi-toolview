# Tool summary specification

Status: accepted. This specification supersedes the original argument-preview heuristic and one-row-only layout. It applies to compact tool calls, independent of tool name. Native cards, expansion, images, hidden renderers, execution and persisted data remain native.

## 1. Primary description

Given the explicitly supplied argument object:

1. If `pattern` is a string, including `""`, it takes precedence. Show its quoted value. If `path` is a nonempty string, append ` in ` and the formatted path. Consume only those used fields. Other object candidates remain ordinary parameters in this branch.
2. Otherwise choose the first nonempty string value in this exact priority: `path`, `target`, `url`, `scope`. Show it as the primary object and consume that field only. Other candidates remain ordinary parameters.
3. Empty strings and all other types (including arrays, null, numbers, booleans and structured objects) remain named parameters; they are not discarded or interpreted as primary locations. A primary location must be a primitive string with supplied length greater than zero; no implicit trimming is performed. Strings containing spaces retain the existing quoting/sanitization rules.
4. If neither rule applies, omit the primary description. Do not invent an ellipsis placeholder. `query` and `paths` are always ordinary named parameters. `paths` never becomes a primary object, including when it is the only supplied argument.

Primary strings are unquoted unless empty or containing whitespace, double quotes, backslashes, square brackets or commas; such strings use JSON quoting. Pattern strings always use JSON quoting. Arrays are ordinary parameter values and use compact JSON.

## 2. Remaining parameters

Remove consumed primary fields and these exact top-level payload fields:

```text
content, edits, code, input, messages, prompt, newString, oldString,
appendContent, rewrite, oldText, newText
```

No recursive payload deletion is performed. All other supplied JSON fields participate. Runtime `undefined` is omitted because it is not a supplied JSON value. Explicit false, zero, empty string and null are retained. Schema defaults are not added.

Sort present priority fields in this order:

```text
paths, path, target, url, scope, query, queries, op, action,
symbol, symbols, command, subject,
offset, limit, startLine, endLine
```

Then sort all remaining keys by locale-independent, case-sensitive JavaScript string comparison (UTF-16 code-unit order). Matching is exact and case-sensitive. There is no maximum field count.

Render as `[key=value, key=value]`. Omit the entire block when no parameters remain. Identifier-like keys (`[A-Za-z_$][A-Za-z0-9_$]*`) are bare; other keys use JSON quoting.

## 3. Values, masking and sanitization

- Strings use JSON double quotes; numbers, booleans and null use JSON literals.
- Arrays and objects use compact JSON, preserving their structure and nested key order. No flattening occurs.
- Before display, remove terminal control sequences and invisible directional controls; collapse string whitespace to single spaces. This affects presentation only. Nested string values are sanitized too.
- Values that fail JSON serialization (including cyclic graphs), or have no JSON representation, use the visible quoted placeholder `"[unavailable]"`. Exotic JavaScript objects are outside the JSON tool-input contract; valid JSON argument values have no arbitrary length cap.
- Mask values of these exact top-level keys as `"<redacted>"`: `password`, `passwd`, `api_key`, `apiKey`, `authorization`, `Authorization`, `access_token`, `refresh_token`, `secret`, `token`.
- Masking is not recursive and does not inspect URL credentials or free text. It is a presentation precaution, not a security boundary. Native expansion and model/session data are not redacted by this extension. Fields such as `maxTokens` are not matched by substring.

## 4. Colors and status

Use current theme roles at render time:

| Segment | Role |
| --- | --- |
| Leading ` → ` | `dim` |
| Exact tool name | `toolTitle` |
| Primary pattern/object | `muted` |
| ` in ` connector | `dim` |
| Parameter block including punctuation | `dim` |
| Existing short error explanation | `toolTitle` |
| Pending `…`, success `✓`, failure `✗` | `muted`, `success`, `error` |

Retain the existing pending/partial/completion rules. Completed errors append the first line of the first text result after ` — `; its inherited 180-column preview bound is unchanged. This is not full result rendering.

## 5. Wrapping and indentation

- Build the complete colored description and status, then word-wrap to the actual terminal viewport. Long unbreakable tokens wrap at grapheme boundaries. Do not truncate arguments or discard later fields to keep one row.
- At normal widths the first row begins ` → `; tool-name text starts at zero-based column 3. Every continuation row has exactly three spaces of indentation, aligned with the tool name, **not** with the parameter block or its opening bracket.
- The status is at the end of the final content row and may itself wrap onto a continuation row. Brackets/quotes are retained across rows because content is wrapped rather than cut.
- At widths 1–4 content consists only of the state marker (normal separator rules still apply): these widths cannot reliably fit the prefix and a wide grapheme. Width zero renders no rows. No general maximum row count is introduced.
- Input newlines do not create arbitrary blank rows; only renderer wrapping produces content rows. Layout is computed from plain logical text before colors are applied to source spans; this avoids Pi 1.0.0's colored-whitespace wrapping defect. Styling is preserved across breaks, with no card background.

## 6. Separation and visibility

A content row is a row belonging to the tool visualization, excluding an extension-added leading separator.

- Consecutive single-row compact calls have no separator.
- A compact call following a multiline compact call has exactly one blank row before it. A multiline call following a single-row call does not acquire a separator merely because it is multiline.
- Hidden/zero-row components are skipped when finding the previous visible component.
- Existing separation from ordinary text and native cards is retained. Native cards keep their original rendering; when a native tool renderer lacks a leading separator after a multiline tool, add one without duplicating an existing leading blank row.
- Add separators before the following visible tool, not after the preceding tool. No trailing spacer is added to the last call.
- Recompute wrapping and separation at current width and expansion/visibility state. Do not count a single-row call plus its leading separator as multiline.

## 7. Input and native delegation

A fullscreen primary click on **any content row** of a completed compact call expands that call. Separator rows, pending/partial calls and wheel events do not trigger expansion. Coordinates forwarded to native handlers account for any added separator. Ctrl+O, native collapse, reload, enable/disable and history reconstruction continue to use Pi's existing mechanisms.

## 8. Representative logical summaries

These examples omit colors, prefix and status; terminal wrapping is viewport-dependent.

```text
read src/app.ts [offset=5, limit=10]
grep "needle" in src [include="*.ts"]
aft_search [query="where is authentication handled", includeTests=true]
aft_outline [target=["src","tests"]]
aft_zoom src/app.ts [symbols=["render","update"], callgraph=true]
aft_callgraph src/app.ts [op="callers", symbol="render", depth=2]
ast_grep_search "$X($$$)" [paths=["src"], lang="typescript"]
custom [paths=["src","tests"], query="find this"]
aft_inspect src [sections="diagnostics"]
aft_inspect [scope=["src/index.ts","tests/unit.test.ts"], sections="diagnostics"]
custom "needle" [path=[], target="", query="find this"]
TaskCreate [subject="Investigate rendering", description="Check native visibility"]
TaskList
Agent [description="Review rendering", subagent_type="reviewer"]
ctx_memory [action="write", category="CONSTRAINTS"]
custom [query="find this", limit=0, api_key="<redacted>", enabled=false]
```

All tools use the same rules. Native card policy is a separate choice; these formatting rules also apply when a normally native tool is explicitly forced compact.
