# Real CLI terminal harness

Run the complete implementation gate from the project root:

```sh
node --test --test-concurrency=1 tests/terminal.test.mjs
```

Validate only the offline provider, native tools, PTY transport, screen parser and stock controls (also works before production source exists):

```sh
TOOLVIEW_TERMINAL_STOCK_ONLY=1 node --test --test-concurrency=1 tests/terminal.test.mjs
```

Requirements: Node >=22.19, Python 3 with standard-library `pty`, installed development dependencies, and the real bundled Pi 1.0.0 CLI. The harness runs `PI_TEST_CLI || 'pi'`, resolving `pi` through the child's PATH; invocation artifacts retain the actual command and arguments. `PI_TEST_CLI` can select a different installed CLI path, but the adapter contract is still specifically Pi 1.0.0. No SDK replacement terminal or external model is used.

## Mechanics and coverage

- `pty_bridge.py` forks a controlling native PTY, sends unchanged bytes over JSON lines, applies real `TIOCSWINSZ` resize, and terminates the PTY process group on transport shutdown. Each PTY has a 180-second hard lifetime; test cases and file/event waits also have bounded deadlines.
- `driver.ts` registers an offline scripted provider and six fixture tools, while retaining real built-in `read`, `bash`, `write` and `edit` by default. Only separate invocations explicitly setting `TOOLVIEW_TEST_BASH_SHAPE=1` register a representative fixture named `bash`; built-in scenarios reject this opt-in. A driver slash command inspects the **current live** component tree; it never invokes `handleMouse` or changes expansion fields. Widths 0–4 are direct live-component probes in the dump; 21, 24 and 100 are actual PTY viewport widths.
- `@xterm/headless` parses the actual PTY ANSI stream. Assertions check visible rows, adjacency, card/summary background cells, collapsed/expanded contents, markers and narrow-width wrapping. Ctrl+O and SGR primary press/release are actual terminal input. The mouse row is discovered from the parsed screen, not a hardcoded coordinate.
- The suite executes consecutive read/read, bash, write, edit, an unknown custom tool, and a missing-file read. Stock and patched fresh executions share **the same temporary workspace**, resetting fixture files before each fresh run. Exactly seven calls, seven results, and eight provider contexts are compared without content normalization. Persisted calls/results are compared as well.
- Live cross-process native renderer comparisons normalize **only** bash `Took <elapsed>s` text. This does not affect calls/results/history comparisons. Restart controls replay the exact patched session file through stock Pi, comparing native cards without elapsed-time normalization. Disable on replay is compared against exact same-session stock rendering.
- Lifecycle coverage includes repeated enable, disable, reload, an actual future tool attachment after reload, restart/replay, dark-to-light theme changes, resize to 24 columns, and fullscreen versus regular mode. Regular mode uses keyboard expansion, not unsupported terminal-owned mouse handling.
- Pending argument streaming and a tool partial update use file gates, not machine-speed assumptions. The running spinner is deliberately sampled after a render interval instead of waiting for an idle terminal that cannot exist while the spinner animates.
- Image fallback uses a real built-in read of a valid one-pixel PNG; an empty `renderShell: "self"` fixture tests intentionally hidden native rendering. Exact-name card flags, comma-separated names, case/prefix mismatches, compact precedence, and image/hidden safeguards are checked through real replay.

Each run creates fresh evidence under `.test-artifacts/terminal-<timestamp>-<pid>/`: invocation, raw ANSI bytes, parsed screen text and cell colors, live dumps, tool/provider events, persisted sessions, bridge stderr, and the mutated file when present. Prior evidence is never an input to these tests. Fresh HOME, XDG directories, agent settings and workspace are test-owned and removed after cleanup. User settings and installed host/package files are never written.

## Integration-profile handoff

The exported `PiTerminal` constructor accepts `agentSettings`, `extraEnv`, explicit `extensions`, and a synchronous `profileFactory`. The factory receives `{ homeDir, agentDir, workDir, provider, model }`; `getInstalledIntegrationProfile` can be supplied directly. Its `configFiles` are materialized inside the fresh HOME before spawning. Its `env` is used as the **complete** child environment, with only the driver output location added; it is not merged with `process.env`. Profile runs omit `-ne` and `--no-themes` but retain `-ns -np -nc -na` and explicit offline-provider selection. The full profile is saved as an artifact.

## Installed-profile smoke

The full terminal gate includes a separate installed-profile case. Source settings/packages come from `TOOLVIEW_SOURCE_AGENT_DIR` or the launching user's real `homedir()/.pi/agent`, not the fresh child HOME. When that source or an eligible audited configured `@tintinweb/pi-tasks` package is absent, only this integration case skips with an explicit reason; core tests still run. The gate loads the actual eligible audited configured packages rather than requiring a fixed package count. Changed/unaudited versions remain excluded; nothing removed from the user's configuration is re-added or installed. The historical pre-specification audit exercised all 11 eligible packages without skipping. Current coverage is the nine configured eligible packages below, plus two explicit safety exclusions.

The scenario executes **real registered `TaskCreate` and `TaskList`** from `@tintinweb/pi-tasks`: no definitions or results are replaced. `PI_TASKS=off` keeps their real store in memory. A tiny profile-only tool-call allowlist rejects any unplanned call; Agent/TaskExecute, network tools, model-requesting commands, dialogs and Magic Context tools are never executed. Stock-profile control runs first. Fresh stock and patched executions compare exactly two calls, two results and three provider contexts within the same profile, never against the isolated core profile's different prompt configuration. On/off preserves actual result contents; Ctrl+O reveals native results; disabling restores exact same-session stock-profile renderer output. Compact summaries are also asserted on the parsed screen, including terminal-default backgrounds.

Registrations are verified for Agent, TaskCreate/TaskList/TaskExecute, ask_user_question, web_search/fetch_content, and ctx_memory/ctx_search/ctx_note/ctx_expand when their owning audited packages are included. All those assertions ran in the current nine-package profile. **Only the two task tools have execution/renderer coverage** (their registered native/default renderer); other tool registrations are not claimed as renderer coverage. Powerline/footer coexistence is present in the same real UI. The current configuration omits curated themes and pi-notify; the profile uses the built-in `dark` theme when the curated package is absent.

Audited package loading/coexistence coverage (current nine-package gate; removed optional packages explicitly marked historical):

| Package | Version | Coverage |
| --- | --- | --- |
| @victor-software-house/pi-curated-themes | 0.2.1 | Not configured in current profile; historical all-11 theme coverage only |
| @cortexkit/pi-magic-context | 0.44.4 | Loader/registrations; local storage only, no tool execution |
| pi-hide-providers | 0.1.22 | Loader coexistence |
| pi-web-access | 0.35.0 | Loader/registrations only; no network tools |
| @tintinweb/pi-subagents | 0.19.0 | Loader/registrations only; scheduler off, no workers |
| @tintinweb/pi-tasks | 0.9.0 | Actual TaskCreate/TaskList execution and compact/native rendering |
| @juicesharp/rpiv-ask-user-question | 2.12.0 | Loader/registration only; no dialog |
| @raidou/pi-notify | 0.7.4 | Not configured in current profile; historical all-11 loader coverage only |
| @pedro_klein/pi-adhd | 0.2.0 | Loader coexistence; no model commands |
| pi-context-view | 0.6.0 | Loader coexistence |
| pi-powerline-footer | 0.19.1 | Footer UI coexistence |

Exclusions remain explicit: **@cortexkit/aft-pi 0.58.2** eagerly starts a Rust bridge and may download binaries/models/LSP servers; **@pedro_klein/pi-caffeinate 0.2.0** unconditionally spawns a sleep inhibitor on agent_start. Neither loader nor renderer is covered for those packages.

The stock profile already emits manifest warnings for pi-subagents and pi-tasks declaring host-provided TypeBox packages in dependencies. Native Pi resource diagnostics distinguish warnings from errors by the active theme's error role; runtime extension-error output is checked separately. Warnings are byte-identical in stock and patched profiles. Nonfatal `not a git repository` subprocess stderr also occurs in the fresh non-Git stock workspace. No extension load/lifecycle errors were observed. No installed manifests were changed to suppress these existing warnings.

`integration-profile-probe.json`, each child's `integration-profile.json`, and `integration-coverage.json` retain actual versions, source paths, exclusions, registrations, executed tools and native diagnostic evidence.

## Verification record and resolved finding

Historical pre-specification verification: **7/7 passed, 0 failed, 0 skipped**, under `.test-artifacts/terminal-1791052213875-1284444/`. This is not the accepted multiline-specification gate; see the current verification record below.

The previous hidden-self-renderer finding is resolved at the production adapter layer by the main implementation: `hideComponent=false` is not evidence of native visibility; a self-shell renderer can return zero rows at the actual viewport width. The adapter now preserves that zero-row native result before producing a summary, and uses the same visibility rule for spacing/mouse routing. The original live-hidden and explicit-override replay assertions remain unchanged and pass. Production was not edited by this harness work.

## Limits

The synthetic provider tests UI/tool execution, not a remote model's protocol. Native image **result fallback** is covered; Kitty/iTerm/Sixel graphics display is not emulated. Only the explicit hidden fixture is tested, not every third-party renderer. Geometry is deterministic (100x80/24x80 for the core suite, 100x120/24x120 for multiline and 100x80/21x80 for the boundary regression), not an exhaustive terminal matrix. At narrow widths the entire long transcript need not fit in the visible viewport; complete argument retention is checked in live component rows and the parsed document, while actual screen cells verify wide multiline output. No full user-environment compatibility claim, OS sandbox claim, or installation fingerprint audit is made. Installed profile coverage is limited to the version-audited safe startup configuration and the two real local task calls above; Magic Context, web, ask and subagent tools have registration-only coverage.

## Semantic summary formatting

The first real built-in `read` in the controlled suite uses `offset=1` and `limit=1` in both stock and Toolview runs. This supplies visible range options without changing the strict execution/control assertions. Toolview shows the filename separately from the bracketed parameter block.

The driver captures reference styles from the active host theme. The actual ANSI-screen assertions compare foreground color/mode and faint attributes for the arrow (`dim`), tool name (`toolTitle`), filename (`muted`), and parameter brackets (`dim`), in both dark and light themes. An additional screen assertion checks bracketed arguments for the unknown fixture tool. The terminal gate also checks the foreground role on every continuation of the long parameter block and terminal-default backgrounds. Narrow assertions recover complete logical argument text across wrapping instead of requiring one-row truncation.

Historical semantic-formatting verification before the accepted multiline specification: TypeScript passed, **22/22 unit tests**, **7/7 terminal tests with zero skips**. Evidence: `.test-artifacts/terminal-1791056389610-1381042/`.

## Accepted summary specification: multiline scenario

The controlled `multiline` scenario executes 19 calls, 19 results and 20 offline-provider contexts through the real CLI. Fresh stock and Toolview executions share one test-owned workspace. All recorded calls/results/provider contexts and persisted calls/results are compared exactly; only cross-process native bash elapsed-time text is normalized. A real built-in `read` opens a 198-character relative path with explicit range parameters. No tool execution is replaced.

`tv_summary` supplies a quoted query containing Unicode, quotes, backslashes and a 330-character unbreakable token, all priority keys in deliberately reversed insertion order, alphabetically sorted ordinary keys, a quoted non-identifier key, false, zero, null, empty strings, arrays and nested JSON. It includes every exact payload-exclusion key and every top-level secret key with synthetic sentinels. Nested `input`/`token`, differently cased `Content`/`Token` and `maxTokens` remain visible. Top-level and nested strings also exercise whitespace/control sanitization. Original arguments, results and details retain the synthetic payloads/secrets. Additional calls cover quoted pattern with its path array retained as a named parameter, nonempty-string path/target/url/scope primary priority, first-ranked named paths parameters followed by unconsumed location keys, wrong-type candidates, and empty pattern/array values.

The scenario checks complete logical summaries at 100 and 24 columns, row-width bounds, exactly three-space continuation indentation, retained brackets/quotes and final state marker, more than 30 content rows at narrow width, and no arbitrary argument or row truncation. The width-independent oracle ignores wrapping whitespace only; every non-whitespace character, field order and JSON punctuation must match the complete expected summary. Every row of the long read and long parameter block is checked on the actual 100-column screen, together with continuation theme colors and background cells.

Separation checks cover single→single, single→multiline, multiline→single with an intervening zero-row hidden fixture, single-row calls that themselves have a leading separator, and no trailing spacer. `tv_card` uses a real registered `renderShell: "self"` fixture whose Text components request no padding; Pi 1.0.0 still supplies a native leading blank row. The CLI check therefore verifies that this separator is not duplicated. The fallback that adds a missing separator, and its native mouse-coordinate correction, are directly covered by the synthetic `NativeSelf` component unit test, not by this CLI fixture. The accepted bash-card follow-up replaces only bash presentation by default. Explicit native-card/off controls still retain the native separator; self-shell/read/image/hidden comparisons remain unchanged.

Actual fullscreen SGR input clicks a separator (no expansion), the last continuation of the long read (only that call expands), and native titles to collapse both the read and a following call that owned a separator. The native long-path read places its filename below its title; click coordinates are discovered from the fresh parsed screen. Ctrl+O restores stock rendering for ordinary summaries; bash remains a custom card unless explicitly opted out. Off/on/reload/restart replay preserve full stored data without new tool execution. Fullscreen and **regular** mode both perform actual wide→24→wide resizes; regular mode uses keyboard expansion only. Tiny widths 0–4 are separately asserted on the actual live tool components, not a resized zero-column PTY.

`multiline-coverage.json` records counters, executed names, widths, input and lifecycle checks. This scenario executes only real built-in read/bash and the local fixtures; it does not add installed-package tool execution. Installed-profile registration coverage and real TaskCreate/TaskList execution remain a separate optional, version-audited gate.

### Earlier verification and handoff findings

- Adapted existing suite against the old implementation: **5 passed, 1 failed, 1 skipped** (7 tests). The authorized `query=` assertion exposed the old `[wide … query]` heuristic. Evidence: `.test-artifacts/terminal-1791061865774-1531421/`.
- First full run after production readiness: **6 passed, 1 failed, 1 skipped** (8 tests). Existing core/stock/input/replay and fallback gates passed. The new scenario stopped on a harness assumption that the wrapped native read title shared the path row; this was corrected. Evidence: `.test-artifacts/terminal-1791062254683-1542676/`.
- Targeted multiline run then confirmed a production boundary defect: compact live `render(0)` returned `[""]`, rather than `[]`, because a separator survived empty content. The scenario proceeded through all resize/input/off/reload/replay checks. Its final artifact-writing error (`events()` after closing the child) was a harness defect and is corrected. Evidence: `.test-artifacts/terminal-1791062348665-1545614/`, especially `multiline-toolview/narrow.json`. Fresh source review also found that the newly added regular-mode child had omitted its mode option; it is now explicitly `mode: "regular"`.
- Final targeted run of the corrected harness (including sanitization, continuation colors and explicit regular mode): **1 passed, 2 failed** (3 tests: the width-zero child and its parent fail on the same single production defect; widths 1–4 pass). Every subsequent resize/input/off/reload/replay/regular assertion passed and `multiline-coverage.json` was written. Evidence: `.test-artifacts/terminal-1791062694222-1555652/`. No other failing assertion remained.
- Current JS syntax and strict standalone driver TypeScript checks pass. Production, unit tests, accepted specification, package/config files, host settings and installed package files were not edited by this work; no commits were made.
- In those earlier runs the installed-profile preflight found nine eligible audited configured packages but incorrectly required a fixed count of 11, so it skipped. Main independently confirmed unchanged audited versions: curated themes and pi-notify had simply been removed from the user's configured package list. The fixed-count gating was a fixture defect, not a version change. It is now removed; the audit/version allowlist and safety exclusions are unchanged.

Main corrected the production width-zero entry point and replaced colored-string wrapping with plain logical text wrapping followed by semantic source-span coloring. The assertions above remain strict; neither the empty separator nor malformed continuation indentation is ignored. See the fresh full gate below.

## Width-21 ANSI boundary regression

The `boundary` scenario uses real built-in `read` with `{ path: "abcdefghijklm", limit: 1 }` and registered `tv_summary` with the same path plus a 40-character query. Both run first in stock Pi and then Toolview over one test-owned workspace. Exactly two calls, two results and three provider contexts, plus persisted data, are compared unchanged. The actual PTY resizes 100→21→100.

At 21 columns the read primary fills the complete 18-column content area; the parameter block must be the second row `   [limit=1] ✓`. This reproduces the colored-segment boundary that previously produced four-space indentation or an empty content row. Assertions check the actual ANSI-parsed screen against every component content row, exactly three spaces on every continuation, no internal blank rows, retained full primary/query/brackets/quotes/status, row-width bounds, default background and exactly one separator before the following multiline call. Off restores the exact width-21 stock renderer; on and resizing back restore the original compact rows. `boundary-coverage.json` records actual arguments, counters and checked invariants.

## Previous full accepted-summary-specification verification

Fresh command:

```sh
node --test --test-concurrency=1 tests/terminal.test.mjs
```

**11/11 passed, 0 failed, 0 skipped**. This includes six top-level CLI tests and five nested regression checks. The width-zero, widths 1–4, multiline 24/100, fullscreen mouse/input/lifecycle, real regular-mode resize/keyboard, width-21 ANSI boundary, native hidden/image safeguards and configured installed-profile gate all pass. JavaScript syntax checking for both `.mjs` files and strict standalone TypeScript checking for `driver.ts` also pass. Scoped AFT diagnostics reported zero errors/warnings; its Tier-2/cache metrics were incomplete, so the compiler/syntax checks and real CLI run are the verification gates.

Evidence: `.test-artifacts/terminal-1791063636295-1582018/`, including `multiline-coverage.json`, `boundary-coverage.json`, `integration-coverage.json`, each invocation/live dump/parsed screen/raw ANSI capture, provider/tool events and persisted sessions.

The installed gate loaded **nine** eligible audited configured packages: Magic Context, pi-hide-providers, pi-web-access, pi-subagents, pi-tasks, ask-user-question, pi-adhd, pi-context-view and pi-powerline-footer. The two configured safety exclusions remain AFT and pi-caffeinate. Curated themes and pi-notify were absent from configuration and were not loaded, installed or re-added. Real registered TaskCreate/TaskList execution/results and compact/native rendering pass, with two calls, two results and three provider contexts exactly equal to stock; the other included tools have registration-only coverage. Native extension warnings are identical between stock and Toolview, with no load/lifecycle errors. Historical all-11 coverage is not presented as current coverage.

This follow-up changed only `tests/terminal.test.mjs`, `tests/fixtures/driver.ts`, `tests/fixtures/TERMINAL.md` and the explicitly authorized minimal correction to `tests/fixtures/integration-profile.mjs`. Production, units, specification, package/config files, host settings and installed package sources were not edited by this test work. No commits were made.

## Accepted bash-card CLI gate

The agreed contract is `docs/bash-card-spec.md`. This follow-up owns only `tests/terminal.test.mjs`, `tests/fixtures/driver.ts` and this report; production, units, specification, configuration and git remain the main implementation's responsibility. No user settings, installed packages or commits were changed by the harness work.

The previous assertions that bash stayed native by default now require the full custom card, including after Ctrl+O. Exact native write/edit, self-shell card, image and hidden assertions remain intact. Explicit `--toolview-card bash`, off, and compact-precedence controls retain native behavior.

### New actual built-in scenarios

- `bash-real` executes four actual built-in bash calls: a complete multiline heredoc with supplied indentation, a 240-character unbroken argument, eleven real output lines, and `exit 7` with a real diagnostic. The ASCII hard-cell oracle checks the complete command/comments/output/footer, blank rows, indentation and preview against fresh live components, independently of production helpers. Actual screen assertions verify heredoc indentation and semantic foreground/background cells in dark and light themes.
- Fullscreen SGR clicks exercise command/output gaps and non-primary events (ignored), hint/output expansion, and output collapse. Ctrl+O keeps bash custom. Actual PTY resizes 100→24→100 preserve complete commands and output; regular-mode replay performs the same resize and keyboard expansion. Off/on, reload, exact same-session native replay, explicit native card, and compact precedence all pass. Four calls, four results and five offline-provider contexts remain recorded without re-execution; native same-session controls compare persisted command arguments and actual result content/details/isError exactly.
- `bash-stream` uses the real built-in bash, not the metadata fixture. The offline provider gates command-argument completion. The real shell emits twelve lines, writes `shell-ready`, and waits for the test's `shell-final` before emitting the final line. Observed native `tool_execution_update` payloads prove the partial result is present before capture. Mouse expansion/collapse works while streaming, including across 24/100 resize; final snapshots replace overlapping partial snapshots. Pending background and output foreground are checked on real parsed cells. This run observed one call, one result, two provider contexts and **four native update events**; chunk/update counts can vary and are evidence, not fixed test expectations.

### Separate representative metadata fixture

`TOOLVIEW_TEST_BASH_SHAPE=1` explicitly opts into a tool named `bash` in separate isolated processes. It returns representative text/details/isError/onUpdate shapes; **it does not execute installed AFT, any AFT runtime, or a real shell**. Existing and actual-shell scenarios reject this opt-in.

Fourteen completed cases cover description/workdir comments, normalized relative directory, equivalent `.` and absolute current cwd, returned literal `(no output)`/background/task/exit-looking text, multiple content-block order, whitespace-only output, edge whitespace/interior blank rows, exactly ten/eleven visual rows, long soft output wrapping into eleven visual rows at 24 columns, nonzero metadata with/without error, zero/unknown error, zero/string/null codes, and transient structuredContent. A separate gated fixture call supplies **two partial snapshots** followed by a distinct final snapshot. Partial errors/nonzero metadata produce no footer; replacement drops old output, and final output/footer replace both snapshots. Comment, comment gap and footer mouse clicks do not expand. Numeric status comes only from persisted `details.exit_code`; transient structuredContent is intentionally ignored, so live/replay cards agree. Generic error text follows the contract.

### Fresh commands and evidence

```sh
node --check tests/terminal.test.mjs
node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext tests/fixtures/driver.ts
node --test --test-concurrency=1 tests/terminal.test.mjs
```

Fresh full run: **14/14 passed, 0 failed, 0 skipped** (nine top-level CLI cases plus five existing nested checks), approximately 95 seconds. Strict standalone driver TypeScript and JS syntax passed. Scoped AFT diagnostics reported zero errors/warnings for the TypeScript fixture; Tier-2 cache metrics were incomplete, not a clean full-analysis claim.

Evidence: `.test-artifacts/terminal-1791073705316-1866290/`. Inventory counted **32 actual CLI invocations**, **286 JSON files** (including **122 live dumps** and **122 parsed cell captures**), **128 text files** (122 parsed screens plus six existing mutated-file copies), **64 JSONL files** (32 event streams and 32 saved sessions), **32 raw ANSI files**, **32 bridge stderr files**, and **seven shell/fixture gate files**. Six coverage artifacts include the new `bash-real-coverage.json`, `bash-stream-coverage.json` and `bash-shapes-coverage.json`, plus the existing multiline/boundary/installed reports. Installed-profile scope and exclusions are unchanged.

### Earlier failures and interpretation

The first targeted run finished 0/3 under `.test-artifacts/terminal-1791073555487-1861104/`, after the main implementation had already become visible. This is **not** evidence of a pre-implementation production first-red. All three failures were harness assumptions: xterm preserves background-padding spaces on captured screen rows; animated resize cannot use idle detection; and native live cards display unpersisted `Took` duration that native replay does not reconstruct. Corrected checks preserve full card assertions, use animated sampling during active streaming, compare live off→on→off renderer bytes exactly, and compare replay-off/native-replay bytes exactly. Actual arguments/results always remain exact.

The next targeted run finished 2/3 under `.test-artifacts/terminal-1791073637835-1864155/`. The remaining failure sampled the command occurrence of `HEREDOC_END` as if it were output. The style probe now selects the returned-output occurrence; it does not change the expected theme role. The subsequent full gate above passes all assertions. No production blocker was found by these CLI tests.

### Coverage boundaries

This is real Pi CLI/PTY/keyboard/mouse evidence with an offline scripted provider, not a remote model protocol test. The bash command oracle's new inputs are ASCII; Unicode/grapheme/tab/control safety and widths 0–4 remain component/unit responsibilities, not newly claimed CLI bash coverage. Existing native image and hidden fallback checks remain present, but no bash-specific image/hidden renderer was added. Wheel/drag host behavior is not newly asserted. Regular mode deliberately uses keyboard rather than terminal-owned mouse input. The built-in numeric-exit replay limitation is accepted: persisted isError and original diagnostic text remain visible, but transient structuredContent is not a numeric footer source. Native live duration is also not persisted; exact native comparisons are made within live components or between same-session replay controls, never by normalizing result/session data. Installed AFT remains excluded from runtime coverage.

### Main-agent current-source final gate

After the main-agent padding/Unicode/control fixes, the combined project/fixture/syntax/packaging gate freshly repeated the complete CLI suite: **14/14 passed, 0 skipped**, alongside **45/45 unit tests** and strict checks. Evidence: `.test-artifacts/terminal-1791074553336-1890782/`. The actual built-in streaming coverage artifact records **three** update events in this run; the earlier harness run's four events were an observation, not an invariant. The traffic counters remain built-in batch 4 calls/4 results/5 contexts, built-in stream 1 call/1 result, representative metadata batch 14 calls/14 results and representative stream 1 call with two updates. Coverage boundaries above are unchanged.

## Shared OpenCode-style bash shell CLI follow-up

Contract: `docs/card-frame-spec.md` supersedes the historical bash shell geometry, state backgrounds and limited output-only click regions described above. Body policy in `docs/bash-card-spec.md` remains unchanged. This follow-up edits only `tests/terminal.test.mjs`, `tests/fixtures/driver.ts` and this report. Production, units, specifications, settings and git are owned by the parent; no commits are made here.

### Independent oracles and real input

The ASCII oracle independently computes content width `W-7`, column-five origin, left-only `┃`, inside-left two cells, no inside-right padding and two unpainted exterior columns per side. It compares every plain component row, both full panel padding rows and at most one genuinely empty outside separator. Direct live-component probes now include bash widths 0–8, including border-first/padding-second/balanced-margin allocation; actual PTY bash widths remain 24/100. Commands/comments/output, whitespace, ten-visual-row previews, footer combinations and partial/final replacement are still checked independently. Existing strict execution/model/persisted comparisons and native/compact/image/hidden/summary/theme/lifecycle controls remain.

Fresh parsed ANSI cells check every panel and exterior background cell, both padding rows and every border foreground cell. The driver records reference strings only through public theme `fg`, `bg`, `colors`, `style` and `mixColors(panel,text,0.08)`. Normal borders use `borderMuted`; final error borders use the concrete `toolErrorBg` color as foreground, never as panel background. Dark and light checks include neutral/error panels and normal/error hovered borders.

Actual SGR motion (button code 35), not direct component methods, covers enter, leave to all exterior columns/editor/focus-out, transfer between expanded receiving cards, nonexpandable guards and re-entry after reload. Actual primary press/release covers command, gap, border, inside-left, right panel edge, both padding rows, expanded error footer and exterior/separator bounds. A real SGR press/drag/release must create native selection, confirmed by public root `hasActiveSelection()`, without toggling. The driver records public selection state in live dumps, not by changing input or invoking handlers. The PTY harness saves the exact SGR/focus input strings separately in `pointer-inputs.json`. Separate single-click gestures are kept outside Pi's 500ms multi-click selection interval. Secondary/wheel events must not toggle; a smaller actual viewport also checks native wheel scrolling. Resize, off/on and reload must discard hover, then fresh normalized movement may acquire it again. Streaming expandable comment/gap clicks now toggle; nonexpandable comment/footer clicks still do not.

`pointer-*` dumps intentionally render only the actual viewport width. Alternate-width probes would themselves correctly invalidate hover and destroy the state being measured. Other dumps retain the prior render probes and add widths 5–8. Native selection is cleared through real exterior input, never by mutation.

### Pre-readiness checks

- `node --check tests/terminal.test.mjs`: passed.
- `node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2023 --module NodeNext --moduleResolution NodeNext tests/fixtures/driver.ts`: passed after fixing one fixture callback's inferred `void` return to explicit public-listener `undefined`.
- Scoped AFT diagnostics: 0 errors, 0 warnings for the authoritative TypeScript fixture. Tier-2/cache analysis remains incomplete; this is not a clean whole-project-analysis claim.
- `node --test --test-concurrency=1 --test-name-pattern='isolated offline stock control' tests/terminal.test.mjs`: **1 passed, 0 failed, 0 skipped**. Fresh evidence: `.test-artifacts/terminal-1791100186265-2560960/`. This validates the updated driver's real CLI loading/public theme references and the unchanged stock transport/control scenario, not the new production shell.

The parent sent source readiness; targeted tests then exposed the production observer-order blocker below. Full gate is held on that blocker rather than knowingly spending the one full run on an already-failing implementation. This section is not a completion claim. Installed AFT remains excluded; metadata-shaped fixture cases do not execute installed AFT or a real shell. The new command/body oracle inputs remain ASCII; grapheme/control safety is not newly claimed as CLI coverage. Installed-package execution remains limited to the existing real TaskCreate/TaskList scenario.

### Fresh targeted gate and production blocker

After parent readiness:

```sh
node --test --test-concurrency=1 --test-name-pattern='built-in bash full commands|gated actual built-in bash|isolated opt-in representative bash' tests/terminal.test.mjs
```

**1 passed, 2 failed, 0 skipped** under `.test-artifacts/terminal-1791100363359-2566243/`.

- Actual built-in streaming passed completely (one call/result and two model contexts; partial/final replacement, streaming mouse expansion/collapse, 24/100 resize, pending background and existing Ctrl+O).
- The built-in batch passed all independent full-body/narrow 0–8 probes, dark neutral/error border/background cells, nonexpandable move/click and actual SGR hover entry. Moving into exterior x=0 left the whole panel painted with hover background **4211782**, not neutral **3422266**. Failure is `panelCells` on `pointer-margin-0`; raw ANSI, live JSON and parsed exact cells are retained.
- The metadata batch initially failed only a harness body-row count: trimming before stripping `┃` left padding rows counted as body. The corrected independent body slicing preserves exact body assertions. Subsequent targeted runs `.test-artifacts/terminal-1791100554346-2571677/` and `.test-artifacts/terminal-1791100578359-2572369/` each failed 0/1 on a separate old/full or mistyped shortened-hint substring assertion; the exact independent oracle itself passed. This redundant substring now checks the hint's retained prefix, while `allBashCards` still compares the entire independently computed shortened hint and every body row.

Root cause verified from fresh installed host files: `node_modules/@earendil-works/pi-tui/dist/tui-alt-screen.js:105` installs the native viewport listener in the constructor. Its mouse/focus paths return `consume:true`. `tui.js:687–690` stops iterating listeners immediately on that result. Both the appended Toolview observer and an initially attempted fixture observer consequently receive no fullscreen SGR/focus input. The fixture observer has been removed; selection tests inspect public root state through the live dump, and sent input is recorded by the PTY harness. Production was not changed by this task, and the hover assertion is not weakened.

Corrected isolated metadata command:

```sh
node --test --test-concurrency=1 --test-name-pattern='isolated opt-in representative bash' tests/terminal.test.mjs
```

**1 passed, 0 failed, 0 skipped**, evidence `.test-artifacts/terminal-1791100617530-2573485/`. This completed all 14 representative result cases, strict 14-call/14-result/15-context counters, native/off/on/replay comparisons, 24/100 body/preview checks and the independent one-call stream with two fixture snapshots/final replacement. It is not installed-AFT or actual-shell execution.

Final JS syntax and strict standalone driver TypeScript passed. Final scoped AFT inspect could not obtain an authoritative fixture diagnostic report within its budget and had cache writer/Tier-2 gaps; no clean final AFT claim is made. No full suite was run yet. Pending actual coverage after the first margin blocker: remaining hover exits/transfer, native selection drag/double-click, full click-bound matrix, native wheel scrolling, hover resize/off/reload cleanup and light-theme concrete frame/hover cells. Their assertions are implemented but not claimed passed. Existing unrelated full-suite controls have not been freshly rerun in this follow-up. Formal independent review remains the parent's responsibility.


### Main-agent current-source shared-frame gate

This section supersedes the interim observer/proxy/mode blockers and pending coverage above. Confirmed findings, root causes and first-red evidence are recorded in `docs/review.md` Pass 9. The parent fixed the observer before native consumption, captured the actual receiver rather than shadowing the stable proxy, removed synthetic static-hint resets before styling, and migrated the owned input hook on native renderer replacement.

The final main-agent combined gate passed **57/57 units**, **14/14 real-CLI checks, 0 failed, 0 skipped**, strict project/standalone driver TypeScript, both JavaScript syntax checks, Python parsing and whitespace checking. Current evidence: `.test-artifacts/terminal-1791106561810-2745709/`. The complete body/cell/native/model/session oracles and old controls remain intact. Narrow substring locators now fit `W-7`; native unpersisted live duration is checked before the pointer matrix's reload, not normalized or removed.

The full actual SGR click/hover/exterior/transfer/resize/off/reload matrix, genuine native drag and double-click selection, smaller-viewport wheel scrolling, dark/light neutral/error/hover cells and regular/fullscreen replay pass. `bash-real-coverage.json` records **4 calls, 4 results, 5 model contexts**, component probes 0–8 and **74 actual pointer/focus input packets**. Native `/settings` search/Enter performs fullscreen → regular → fullscreen without extension reload, direct handler calls or renderer mutation; the terminal's actual alternate/normal buffer confirms replacement. Regular Ctrl+O preserves complete output and collapsed/expanded state; the new fullscreen receiver shows hover entry and clears it on exterior/focus-out input. No lifecycle or execution events are added; exact saved arguments/results and call identities remain unchanged. The focused prior mode check passed once under `.test-artifacts/terminal-1791104607615-2688082/`.

Current actual built-in stream evidence is **1 call, 1 result, 4 native update events**. Metadata-only fixture evidence remains **14 calls/results**, plus **1 stream call with 2 updates**; it does not execute installed AFT or a real shell. The installed-profile and ASCII/Unicode/image/hidden coverage boundaries remain as documented; actual AFT and keep-awake are still excluded. Scoped cache analysis is not substituted for compiler/CLI gates. All evidence is generated in isolated test HOME/agent/session directories; no user settings, installed host files or commits were changed. Final independent fresh-file review found no actionable findings and closed all four root defects. It independently passed 57/57 units, project/standalone driver types, syntax and diff checking; programmatically inspected fresh mode-switch snapshots, exact traffic/IDs/data and hover/margin/focus cells; and checked first-red logs and installed-profile evidence. It did not repeat the full CLI or package dry-run. Formal closure and limits are recorded in `docs/review.md` Pass 9.


## One-column spacing and actual command-cell regression

This refinement supersedes earlier W-7/column-five/two-exterior geometry. The independent ASCII oracle now uses W-5/column-three, one exterior column per side and one inside column per side, including reserved inside-right cells. Tiny allocation, preview, body, heredoc, streaming, frame color, selection and native controls remain exact. Click checks distinguish the two exterior cells from both internal padding cells. The truncated ANSI hint unit retains actual content-width-17 truncation rather than silently ceasing to test it.

A separate `bash-width` scenario executes real built-in bash commands (249-char longword and the supplied Python script with only owned relative input/output). No installed AFT or fixed `/tmp` output is executed. The new physical-screen oracle does not import production helpers or rely on manual render(viewportWidth). It observes the actual painted panel end, checks every frame/inner/exterior cell and every displayed command character, then restores only known logical newline boundaries to reconstruct the original command exactly, preserving spaces.

Fullscreen auto/always and regular, live plus replay, each perform 100→24→140→100: **24 captures and 48 exact reconstructions**, with **6 calls, 6 results, 9 model contexts and zero replay execution**. Allocated/content widths are respectively 24/19,100/95,140/135 or 23/18,99/94,139/134 when the host reserves an always-visible scrollbar. No current built-in character loss was found; old native-AFT display is not claimed covered. Source `ScrollView.getContentWidth` and child layout forwarding confirm why actual allocation can differ from the terminal width.

The final combined main-agent gate passes **58/58 units**, **15/15 CLI checks, zero failures/skips**, project/standalone driver types, JS/Python syntax and diff checking. Evidence: `.test-artifacts/terminal-1791108927640-2813959/`, including `actual-command-width-coverage.json`, all raw ANSI/screens/cells/events and persisted data. Earlier full 13/15 was a harness prefix mismatch after geometry changes; three old `  ┃  ` heredoc/stream prefixes were changed without removing overlapping-snapshot or exact-body assertions. The earlier new-helper failure was an always-scrollbar border locator, corrected without relaxing padding checks. Current pointer evidence records 70 packets; actual built-in streaming records four updates (observed, not fixed). Existing AFT/keep-awake exclusions and Unicode/unit boundaries remain unchanged. Final independent review is recorded in `docs/review.md` Pass 10; no user/host configuration or commits changed.

Final independent fresh-file review for the spacing refinement found no actionable findings. The reviewer independently passed all 58 units, project types and diff checking, checked every physical-width screen and all 48 reconstructions/boundaries, and verified exact traffic, 70 recorded pointer/focus packets and stream-update counts against original events. Full CLI and standalone-driver/syntax checks were not redundantly repeated. See `docs/review.md` Pass 10 for closure and precise coverage limits.


## Hover removal (current contract)

Positive-hover/input-wrapper coverage above is historical and superseded by the explicit no-hover contract. Shared one-column inner/exterior geometry, complete command/output oracles, error-border colors, exact body/native/session/model assertions and real selection/click/wheel/mode-switch behavior remain required. Mouse motion/transfer/focus/resize/reload now check an unchanged neutral background, not hover entry/exit. No new raw-input observer, listener, receiver probe or private viewport hook replaces the deleted mechanism.

Five current-contract unit regressions failed against the preceding hover implementation before removal: `.test-artifacts/no-hover-first-red/units.log`. They replace seven obsolete hover/wrapper tests: **56 total units** preserve retained behavior and add no-hook dependency, immutable/absent/throwing private input methods, zero motion redraw/body-layout, stable references forbidding private input access/renderer writes, real fullscreen input consumption and renderer replacement with intact clicks. Full current-source CLI and independent closure will be recorded in `docs/review.md` Pass 11 and `docs/verification.md`.

Current-source main gate: **56/56 units, 15/15 CLI, zero failures/skips**, strict project/standalone-driver types, JS/Python syntax and diff checking. Fresh evidence `.test-artifacts/terminal-1791110659651-2863755/` retains 70 real pointer/focus packets with constant neutral physical paint across motion/transfer/focus/resize/reload/native mode replacement and all prior normalized click/selection/scroll tests. Body/model/persisted controls are unchanged: batch 4/4/5, actual stream 1/1 with four updates, metadata-only 14/14 plus one stream/two updates, complete command widths 24 physical captures/48 reconstructions and 6/6/9 with zero replay execution. `frameStyles.hover` and its `mixColors` fixture dependency were removed; ordinary/error border references remain independent active-theme values. Main verified delegated changes and raw counters. Current AFT/Unicode/host-version boundaries remain unchanged; final independent closure is in Pass 11.

Final independent fresh-file review found no actionable findings, independently passed 56/56 units, strict project types and diff checking, and checked current assertions/SDK/first-red evidence. Its additional 11 raw-screen checks cover 533 panel rows and 46,686 strictly neutral cells during motion, focus, transfer, resize, reload and mode changes. Full CLI, driver/syntax checks and other exact traffic counts remain main-agent evidence. Packaging confirms ten files with only four runtime modules and no pointer module. See `docs/review.md` Pass 11 for closure and precise boundaries.


## Terminal-default stripe background

Current logical panel bounds still include the clickable `┃`, but stripe paint is separate: its background is terminal default for ordinary/error cards; body/internal padding stays neutral and exterior cells stay blank/default. The physical panel oracle checks this distinction on every row. The independent command-width oracle starts body-paint scanning immediately after the unpainted stripe and still observes the allocated end, exact paddings and every command character; no viewport-width assumption or weakened equality is introduced. Existing foreground reference colors, no-hover and click/selection/scroll/mode/session controls remain.

New first-red evidence `.test-artifacts/default-stripe-first-red/units.log`; ordinary/error inherited-BG unit cases use widths 2/5/12/22. Trusted frame SGR49 is the only permitted control in the prior plain mock sanitation assertion. Final main gate **57/57 units, 15/15 CLI, no skips**, types/syntax/diff/package checks pass. Fresh raw evidence `.test-artifacts/terminal-1791111805790-2897323/`. Installed-AFT execution and new Unicode CLI coverage are not claimed; final independent closure is recorded in `docs/review.md` Pass 12.

Final independent fresh-file review found no actionable findings and passed 57/57 units (zero skips), project types and diff checking. It confirmed paint separation/default reset, unchanged stripe foreground/geometry/click bounds, strict sanitation and current physical CLI assertions/observed-width oracle. Full CLI, driver/syntax/package gates and raw counter processing remain main-agent evidence; all counts were independently rechecked by main against the current coverage JSON. See `docs/review.md` Pass 12 for exact closure and limits.


## Failed stripe matches completion-footer foreground

Driver `frameStyles.errorBorder` independently uses public `theme.fg("error", "┃")`, not `theme.colors.toolErrorBg` or production card helpers. Physical error panels also assert stripe FG/mode/dim equals the actual displayed `[exit code: ...]` / `[error: ...]` footer cell. Ordinary reference color, default stripe BG, neutral body BG, geometry/data/no-hover/click/selection/scroll/replay controls remain unchanged.

First-red two failures `.test-artifacts/error-stripe-role-first-red/units.log`; semantic unit metadata/success/partial cases plus distinct foreground/background-token ANSI-cell cases at widths 2/5/12/22. Current main **57/57 units, 15/15 CLI, zero skips**, compiler/syntax/whitespace/package gates pass. Fresh evidence `.test-artifacts/terminal-1791112727919-2924247/`. Coverage remains Pi 1.0.0, actual built-in bash versus explicit metadata-only fixtures; installed AFT execution/new Unicode CLI coverage not claimed. See `docs/review.md` Pass 13 for independent closure and limits.

Final independent fresh-file review found no actionable findings and passed 57/57 units, project types and diff checking; it read both first-red failures and verified physical-footer equality is additional to retained theme/BG/geometry checks. CLI, standalone/syntax/package gates remain main evidence. Fresh counters rechecked by main: batch4/4/5 plus70 packets; actual stream1/1 with three observed updates; metadata14/14 plus one stream/two updates; width24 captures/48 exact commands,6/6/9/replay0. Native update count is observational; no traffic/content/snapshot assertions changed to force prior-run counts.


## Render-cache performance and memory case

`run cache-performance` executes eight **real built-in** Bash commands, each returning 1000 exact ASCII rows, two real reads and the native-hidden fixture: **11 calls/results, 12 model contexts**. `TOOLVIEW_TEST_CACHE_DIAGNOSTICS=1` enables UI-only result replacement/reuse/restore and raises only this scripted provider's context capacity to 512k to avoid unrelated automatic compaction. The stored/model result is never mutated. The probe restores the original component result, including on shutdown. Normal built-in profiles retain 32k and no update command; installed AFT is not executed.

`pointer-cache-*` names suppress alternate-width manual probes without changing existing dump body/data fields. Diagnostic samples come from actual `/toolview cache` notifications in the native tree, not a production global or synthetic event. Exact miss/build/hit deltas cover unchanged frames, editor/motion/wheel, one native result update, resize/theme and real clicks, plus actual budget/eviction/zero/clear/off/on/replay. The editor screen is sampled before clearing text; dump commands must never be appended to a nonempty editor. Wheel change is observed before subsequent notifications/capture. Initial native control is captured with Toolview off **before** execution; later same-live restoration compares every original row including timing. Reconstructed native history is compared with separate stock history byte-for-byte, not by deleting timing rows. Both replay processes execute zero calls/results/contexts.

Pi asynchronously invalidates after startup syntax-grammar loading; initial replay totals are not assumed to be one cold frame. Clear establishes a controlled zero-retention epoch; the next cold phase builds exactly ten bodies, then warm frames build zero. Runtime diagnostics report estimated retained layout and separately labeled whole-Pi-process heap; the on-demand diagnostic itself has no tool/model calls. The standalone `cache-probe.ts` uses actual SDK viewport/components and test-only explicit GC to verify work counters and collection of the **first prototype-installer node** while the adapter is active. No forced GC, observer, timer or owner-reference probe runs in the extension.


## Narrow Bash output exceptions

The separate `bash-shape-exceptions` provider scenario uses the existing explicit `TOOLVIEW_TEST_BASH_SHAPE=1` metadata-only opt-in, with **20 calls/results and 21 model contexts**; the original fourteen shape cases and built-in profiles are unchanged. Match/combined cases remove a single separated terminal duplicate, while mismatched/no-gap/error-only/zero/unknown/string/indented/trailing-space/nonterminal/repeated literals remain as specified. `suffix-only` retains its leading separator until the independent oracle's match, yielding no output section but one synthesized footer. Preview cases cover one/two blank endings, interior blanks, an all-whitespace preview and a deep footer; no backfill is allowed, and expanded blanks remain. Exact original tool-result literals and cumulative provider contexts are checked independently of the body oracle and session file bytes stay unchanged across resize/theme/controls/reload/native/history. Stock and Toolview histories execute zero calls/results/contexts.

`bash-shape-exception-stream` emits exactly one partial snapshot, waits on `shape-exception-final`, and returns identical final content: **1 call/result, 2 model contexts, 1 update**. Partial retains the output suffix and its output foreground; final removes the duplicate and colors the sole footer as error. An actual hint click, 100→24→100 geometry, global Ctrl+O state synchronization, final nine-row overflow disappearance, exact raw data and replay are asserted. A local click does not change Pi's global expansion toggle. These fixtures do not execute installed AFT; real built-in execution/cache controls remain separate. The oracle wraps complete ASCII output independently; production's eleven-row cap, tab/Unicode/control safety and the reported duration-row example are unit gates.

## User-message cards

The opt-in `TOOLVIEW_TEST_USER_CARDS=1` scenario submits an actual multiline user message through native bracketed paste and executes real Bash/read calls (two calls/results, three provider contexts). A registered native user Markdown transformer appends a display-only sentinel. Native controls render the original message at the same content width; actual PTY cells compare every body glyph's foreground, bold/italic/underline attributes, full text, frame geometry and theme roles at 24/60/100 columns in dark/light. Native drag selection must copy exactly `USER_CARD_P` via the captured OSC 52 output; the transient native copy toast is awaited rather than excluded from the complete-card oracle. User zones, Ctrl+O independence, warm transform counters, off/on/reload, exact model-facing prompt/session bytes and fullscreen/regular same-session replay are checked. No synthetic user-message components or Markdown renderer replacement are used in the CLI test.

The existing cache-performance control now has eleven custom layouts: eight Bash, two compact tools and one actual user card. Hidden native tools still contribute none; resize/theme/clear/replay rebuild counts include exactly that extra user layout. Single-tool result/expansion updates still build only one layout; unchanged/editor/wheel/pointer frames build none. All original raw traffic, native result and body oracles remain strict.
