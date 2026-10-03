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
- `driver.ts` registers an offline scripted provider and six fixture tools, while retaining real built-in `read`, `bash`, `write` and `edit`. A driver slash command inspects the **current live** component tree; it never invokes `handleMouse` or changes expansion fields. Widths 0–4 are direct live-component probes in the dump; 21, 24 and 100 are actual PTY viewport widths.
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

`tv_summary` supplies a quoted query containing Unicode, quotes, backslashes and a 330-character unbreakable token, all priority keys in deliberately reversed insertion order, alphabetically sorted ordinary keys, a quoted non-identifier key, false, zero, null, empty strings, arrays and nested JSON. It includes every exact payload-exclusion key and every top-level secret key with synthetic sentinels. Nested `input`/`token`, differently cased `Content`/`Token` and `maxTokens` remain visible. Top-level and nested strings also exercise whitespace/control sanitization. Original arguments, results and details retain the synthetic payloads/secrets. Additional calls cover quoted pattern plus path array, path/target/url/scope/paths priority, wrong-type candidates, and empty pattern/string-array values.

The scenario checks complete logical summaries at 100 and 24 columns, row-width bounds, exactly three-space continuation indentation, retained brackets/quotes and final state marker, more than 30 content rows at narrow width, and no arbitrary argument or row truncation. The width-independent oracle ignores wrapping whitespace only; every non-whitespace character, field order and JSON punctuation must match the complete expected summary. Every row of the long read and long parameter block is checked on the actual 100-column screen, together with continuation theme colors and background cells.

Separation checks cover single→single, single→multiline, multiline→single with an intervening zero-row hidden fixture, single-row calls that themselves have a leading separator, and no trailing spacer. `tv_card` uses a real registered `renderShell: "self"` fixture whose Text components request no padding; Pi 1.0.0 still supplies a native leading blank row. The CLI check therefore verifies that this separator is not duplicated. The fallback that adds a missing separator, and its native mouse-coordinate correction, are directly covered by the synthetic `NativeSelf` component unit test, not by this CLI fixture. The real built-in bash card must remain unchanged, including its existing separator.

Actual fullscreen SGR input clicks a separator (no expansion), the last continuation of the long read (only that call expands), and native titles to collapse both the read and a following call that owned a separator. The native long-path read places its filename below its title; click coordinates are discovered from the fresh parsed screen. Ctrl+O restores stock rendering, and off/on/reload/restart replay preserve full stored data without new tool execution. Fullscreen and **regular** mode both perform actual wide→24→wide resizes; regular mode uses keyboard expansion only. Tiny widths 0–4 are separately asserted on the actual live tool components, not a resized zero-column PTY.

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

## Current full accepted-specification verification

Fresh command:

```sh
node --test --test-concurrency=1 tests/terminal.test.mjs
```

**11/11 passed, 0 failed, 0 skipped**. This includes six top-level CLI tests and five nested regression checks. The width-zero, widths 1–4, multiline 24/100, fullscreen mouse/input/lifecycle, real regular-mode resize/keyboard, width-21 ANSI boundary, native hidden/image safeguards and configured installed-profile gate all pass. JavaScript syntax checking for both `.mjs` files and strict standalone TypeScript checking for `driver.ts` also pass. Scoped AFT diagnostics reported zero errors/warnings; its Tier-2/cache metrics were incomplete, so the compiler/syntax checks and real CLI run are the verification gates.

Evidence: `.test-artifacts/terminal-1791063636295-1582018/`, including `multiline-coverage.json`, `boundary-coverage.json`, `integration-coverage.json`, each invocation/live dump/parsed screen/raw ANSI capture, provider/tool events and persisted sessions.

The installed gate loaded **nine** eligible audited configured packages: Magic Context, pi-hide-providers, pi-web-access, pi-subagents, pi-tasks, ask-user-question, pi-adhd, pi-context-view and pi-powerline-footer. The two configured safety exclusions remain AFT and pi-caffeinate. Curated themes and pi-notify were absent from configuration and were not loaded, installed or re-added. Real registered TaskCreate/TaskList execution/results and compact/native rendering pass, with two calls, two results and three provider contexts exactly equal to stock; the other included tools have registration-only coverage. Native extension warnings are identical between stock and Toolview, with no load/lifecycle errors. Historical all-11 coverage is not presented as current coverage.

This follow-up changed only `tests/terminal.test.mjs`, `tests/fixtures/driver.ts`, `tests/fixtures/TERMINAL.md` and the explicitly authorized minimal correction to `tests/fixtures/integration-profile.mjs`. Production, units, specification, package/config files, host settings and installed package sources were not edited by this test work. No commits were made.
