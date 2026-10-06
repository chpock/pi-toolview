# Tool summary specification

This specification defines compact tool calls, with one shared exact-name short-view rule for `edit` and `write`. Native cards, ordinary-tool expansion, images and hidden renderers retain native behavior; execution and persisted data are unchanged. The separate [bash card specification](bash-card-spec.md) governs bash's default collapsed/expanded card; these summary rules apply to bash only when explicitly forced compact. The separate [edit card specification](edit-card-spec.md) governs edit's default collapsed presentation; these summary rules apply to edit by default before completion and on final failure, and to every state when explicitly forced compact. The [write card specification](write-card-spec.md) uses the same compact lifecycle before success and on failure.

## 1. Primary description

Given the explicitly supplied argument object:

1. For exact, case-sensitive tool names `edit` and `write`, a nonempty primitive string `path` takes precedence over everything else, including `pattern`. Show only `<tool name> <formatted path>`: do not enumerate, sort, read or format any other argument. This applies wherever compact presentation is selected, including a forced-compact successful edit/write. Absent, empty or non-string `path` falls through to the generic rules below. This formatting rule does not select the successful file card.
2. Otherwise, if `pattern` is a string, including `""`, it takes precedence. Show its quoted value. If `path` is a nonempty string, append ` in ` and the formatted path. Consume only those used fields. Other object candidates remain ordinary parameters in this branch.
3. Otherwise choose the first nonempty string value in this exact priority: `path`, `target`, `url`, `scope`. Show it as the primary object and consume that field only. Other candidates remain ordinary parameters.
4. Empty strings and all other types (including arrays, null, numbers, booleans and structured objects) remain named parameters; they are not discarded or interpreted as primary locations. A primary location must be a primitive string with supplied length greater than zero; no implicit trimming is performed.
5. If neither generic primary rule applies, omit the primary description. Do not invent an ellipsis placeholder. `query` and `paths` remain named parameters; `paths` never becomes a primary object.

Primary strings are unquoted unless empty or containing whitespace, double quotes, backslashes, square brackets or commas; such strings use JSON quoting. Pattern strings always use JSON quoting. Formatting operates within the budgets below, not on the complete unbounded input.

## 2. Remaining parameters

Remove only consumed primary fields. There is **no payload suppression list**, at either top-level or nested levels. `content`, `edits`, `code`, `input`, `messages`, `prompt`, replacement text and the other former payload names participate as low-priority fields. Runtime `undefined` is omitted because it is not a supplied JSON value. Explicit false, zero, empty string and null are retained. Schema defaults are not added.

The single `PRIORITY_FIELDS` inventory in [the pure argument formatter](../src/summary-args.ts) contains exact top-level names from the built-in, file/search, context, web, agent and management tools. Its declared order is the exact ordering contract; categories below explain that order without maintaining a second exhaustive inventory:

| Order | Purpose | Representative names, in relative order |
| --- | --- | --- |
| 1 | Action and intent | `op`, `action`, `command`, `query`, `queries`, `subject`, `description`, `agent`, `subagent_type`, `task`, `workflow` |
| 2 | Targets and identity | `paths`, `path`, `target`, `targets`, `url`, `urls`, `scope`, `files`, `symbol`, `symbols`, `ids`, `note_ids` |
| 3 | Selection and ranges | `pattern`, `include`, `globs`, `lang`, `filter`, `status`, `category`, `startLine`, `endLine`, `offset`, `limit`, `topK` |
| 4 | Modes and auxiliary settings | `mode`, `sections`, `provider`, `model`, timeouts, `wait`, `background`, `includeTests`, budgets and output/control settings |
| 5 | Unknown fields | Locale-independent, case-sensitive JavaScript string comparison (UTF-16 code-unit order) |
| 6 | Large content fields | `content`, `edits`, `code`, `input`, `messages`, `prompt`, `newString`, `oldString`, `appendContent`, `rewrite`, `oldText`, `newText` |

Matching is exact and case-sensitive. Unknown fields rank after known operational settings but before the content tail. There is no separate field-count limit; the total text budget limits the visible ordered prefix. A supplied key is not reprioritized by its value or tool schema.

Render as `[key=value, key=value]`. Omit the entire block when no parameters remain. Identifier-like keys (`[A-Za-z_$][A-Za-z0-9_$]*`) are bare; other keys use JSON quoting.

## 3. Values, budgets, masking and sanitization

- `VALUE_TEXT_LIMIT = 256` caps each displayed value, including a whole array/object, primary description, parameter label and tool-name preview, in **Unicode graphemes**. Quotes, JSON escapes, container delimiters and abbreviation `…` count toward the value budget. These constants live in `src/summary-args.ts`; they are not runtime settings.
- `SUMMARY_TEXT_LIMIT = 1024` caps the tool-name text plus its argument description, including spaces and parameter punctuation, before terminal wrapping. Prefix glyph/spinner, indentation, an outside separator and optional status indicators are not part of this budget. Retain a prefix of complete parameter previews; if the next field cannot fit, stop and append `…` inside the outer brackets. Do not read later field values or skip a large earlier field to display later small ones.
- Strings use JSON double quotes; numbers, booleans and null use JSON literals when they fit. Arrays and objects use compact JSON-shaped previews, retaining source order and nesting. Truncated containers retain delimiters and use a standalone `…` for an omitted suffix; an abbreviated preview is not necessarily valid JSON. Quoted strings retain their closing quote and never split an escape or a combining/emoji grapheme.
- Preparation is bounded as well as output: read only a bounded grapheme prefix of each input string **before** control cleanup and JSON escaping, and recursively visit only the visible prefix of container values. Do not stringify a full large array/object or scan/sanitize a full large string and then slice its result. Raw-prefix limits may abbreviate a long input whose whitespace/control cleanup would otherwise produce a shorter value. Root key enumeration/sorting remains proportional to the supplied key count; this is not an O(1) or whole-host CPU guarantee.
- Remove terminal control sequences and invisible directional controls from displayed string prefixes; collapse whitespace to single spaces. Preserve Unicode joining marks needed by emoji and scripts. Nested strings use the same rules. Formatting never modifies the original argument object or its strings.
- Encountered cyclic graphs or scalar serialization failures use the visible quoted placeholder `"[unavailable]"` within the same budget. Exotic JavaScript objects are outside the JSON tool-input contract; omitted branches are not inspected just to validate them.
- Mask values of these exact top-level keys as `"<redacted>"` **before** value formatting: `password`, `passwd`, `api_key`, `apiKey`, `authorization`, `Authorization`, `access_token`, `refresh_token`, `secret`, `token`. Undefined values remain omitted. There is no payload hiding beyond the dedicated edit/write-path rule.
- Masking is not recursive and does not inspect URL credentials or free text. It is a presentation precaution, not a security boundary. Native expansion and model/session data remain complete and unredacted by this extension. Fields such as `maxTokens` are not matched by substring. Native cards, Bash output/commands, edit/write source bodies and user messages do not acquire these compact-text budgets.

An abbreviation ellipsis belongs to the call description and is independent of `SHOW_COMPLETION_MARKERS`: disabling pending/completion markers does not disable visible truncation indicators.

## 4. Colors and status

Use current theme roles at render time:

| Segment | Role |
| --- | --- |
| Leading spinner during execution; otherwise ` → ` for exact tool name `read`, ` ⚙ ` for every other compact tool | `dim` |
| Tool-name preview | `toolTitle` |
| Primary pattern/object | `muted` |
| ` in ` connector | `dim` |
| Parameter block including punctuation | `dim` |
| Optional trailing pending/partial `…` | `muted` |
| Optional success `✓`, failure `✗` | `success`, `error` |
| Every segment of a completed failed summary, including its leading glyph, name, primary description, connector and parameters | `error` (overrides the ordinary roles above) |

Only a completed result with `isError` marks a summary failed; a partial result does not. Compact summaries never append result/error content, not even a first-line preview. Clicking a completed summary opens the unmodified native information, including the complete available error. Result bodies, metadata, model context and session data are unchanged.

The source constant `SHOW_COMPLETION_MARKERS = false` in `src/index.ts` disables all trailing status indicators: pending/partial `…`, success `✓`, and failure `✗`. Their code remains available: changing this one constant to `true` restores them, without restoring error-body previews. The leading execution spinner is independent of this constant. A hidden indicator adds no separator space and occupies no layout column. There is no runtime setting or command for this source-level policy.

After Pi marks actual execution as started, a visible compact call uses a one-column Braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) in place of its leading tool glyph. Argument streaming before execution does not animate. Partial results, including partial errors, keep the spinner; a final result immediately restores `→`/`⚙`, with the complete-summary error color on failure. Native representations and successful Bash/edit/write cards do not acquire this spinner. See the [animation lifetime and cached-work contract](render-cache-spec.md#execution-spinner).

## 5. Wrapping and indentation

- Build the bounded logical description and optional status, then wrap to the actual terminal viewport before applying colors. Spaces remain ordinary word-wrap points. Within the named-parameter block, standalone comma graphemes are additional soft break points immediately after the comma: this covers JSON array/object separators and comma-separated string values such as `drop="3,4,5,8,9,10"`. No spaces, newlines or other characters are inserted into values; primary descriptions keep ordinary word wrapping. Fill available first-row space using these break points rather than moving an entire comma-separated value to the next row. An individual fragment longer than a full content row still wraps at grapheme boundaries. A comma plus a combining mark is not split. Do not introduce further truncation or field omission merely to keep one terminal row; wrap the already-budgeted preview.
- Reserve at least one blank terminal column at the right edge before wrapping: the effective summary viewport is `width - 1` and the text budget after indentation is `width - 4`. Do not add padding to argument values or reduce the width passed to native renderers. Short rows may leave more space; full rows still leave the last column blank.
- At normal widths the first row begins ` → ` only for the exact, case-sensitive tool name `read`; every other compact tool begins ` ⚙ ` (literal U+2699 without an emoji variation selector). During actual execution the glyph position instead contains a one-column spinner frame. All prefixes occupy three columns and use the same `dim` role, overridden by `error` for completed failures. Native tool representations and the separate Bash-card prompt are unchanged. Tool-name text starts at zero-based column 3. Every continuation row has exactly three spaces of indentation, aligned with the tool name, **not** with the parameter block or its opening bracket.
- A visible pending indicator (or a completion badge when explicitly enabled in source) is at the end of the final content row and may itself wrap onto a continuation row. With status markers disabled, both pending and completed rows end at the call description, without trailing separator spaces. Brackets/quotes are retained across rows because content is wrapped rather than cut.
- At widths 1–5 show only the spinner during actual execution; otherwise show the tool glyph (`→` for `read`, otherwise `⚙`) when status markers are disabled. With markers enabled, use `…` before execution starts or `✓`/`✗` on completion; an executing spinner still takes precedence because there is no room for both leading and trailing indicators. The completed glyph uses `dim` normally and `error` on failure; enabled completion badges replace it with `✓`/`✗`. These widths cannot reliably fit the full prefix, a wide grapheme, and the right margin. Width one keeps the visible indicator/glyph even though a right margin cannot fit; widths 2–5 still leave at least one right column blank. Width zero renders no rows. No general maximum row count is introduced.
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

Custom rows and neighbor metadata follow the [bounded render-cache contract](render-cache-spec.md). Unchanged UI frames reuse formatting/wrapping; width/state/theme changes rebuild affected content without a multi-width history. Visibility remains native-authoritative, including the verified stock-edit fast path described in [architecture](architecture.md#native-visibility).

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
custom [query="find this", paths=["src","tests"]]
aft_inspect src [sections="diagnostics"]
aft_inspect [scope=["src/index.ts","tests/unit.test.ts"], sections="diagnostics"]
custom "needle" [query="find this", path=[], target=""]
TaskCreate [subject="Investigate rendering", description="Check native visibility"]
TaskList
Agent [description="Review rendering", subagent_type="reviewer", prompt="Inspect current source"]
ctx_memory [action="write", category="CONSTRAINTS", content="Durable project fact"]
edit src/app.ts
edit [oldText="before", newText="after"]
write src/app.ts
write [content="export const result = 1;"]
custom [query="find this", limit=0, api_key="<redacted>", enabled=false]
```

Generic formatting is shared by all tools, except the exact `edit`/`write` path-only rule. Native card policy is a separate choice; these formatting rules also apply when a normally native tool is explicitly forced compact.

## Verification

Use the shared [testing and coverage guide](testing.md), preserving exact argument/model/session equality, native delegation and physical width/style/input controls. Working evidence belongs in `.test-artifacts/`, not in this specification.
