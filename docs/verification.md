# Verification record

## Environment and scope

- Production target: the installed bundled Pi 1.0.0 CLI, not a replacement SDK UI.
- Development runtime: Node 26.7.0; host packages are pinned to 1.0.0 for checking.
- No installed-host source edits, user settings changes, tool implementation overrides, model requests, or Git commits are part of this implementation.
- Tests use real pseudo-terminals and a scripted offline provider. The provider is synthetic; built-in tool execution, transcript persistence, native renderers, and terminal input are real.

## Test-first checks

The regression suite was written before the production file; its first run failed because the module did not yet exist. After implementation, an incorrect generic-argument fixture was corrected: it had used the recognized `target` key while expecting the unrecognized-key preview path. The test now uses `kind`, so it actually exercises that branch.

The real terminal harness subsequently found a separate, reachable hidden-renderer defect. A new component regression reproduced that defect before the adapter was changed (18 passed, 1 failed). See [the independent review record](review.md) for the root cause and fix.

## Pre-specification baseline gates

A fresh implementation run after the hidden-renderer fix passed:

- `npm test`: **22/22**, including component, width/input, restore, lifecycle, non-TUI, native self-shell visibility, semantic segment colors, and bracketed-parameter regressions.
- `npm run check`: **passed**, covering production source, unit tests, and the offline terminal driver.
- `npm run test:terminal`: **7/7** (four top-level scenarios and three fallback subtests), with **no skipped cases**, including the installed-package profile.
- `npm pack --dry-run --ignore-scripts`: package contains only the production TypeScript entry, README, manifest, and LICENSE; no development host copies are shipped.
- Explicit `pi -e . --help` in an isolated agent directory loads the package manifest and exposes both Toolview flags.

Terminal checks compare exactly seven calls, seven results, and eight provider contexts between stock and Toolview runs in the same workspace. Result content, error flags, details, and persisted tool messages are not normalized. The only normalization is cross-process native bash *display timing*; replay and disabled rendering are compared against a stock replay of the exact same saved session without that normalization.

The actual ANSI screen parser checks neighboring summary rows, absence of card backgrounds, pending/success/error states, hidden output, native cards, Unicode/narrow widths, mouse coordinates, and expanded contents. The harness sends real Ctrl+O and SGR input, restarts Pi, reloads extensions, attaches future calls, changes themes, and resizes the terminal. Both regular and fullscreen modes run.

The initial final main-agent run generated `.test-artifacts/terminal-1791052532782-1291897/` and passed JS/Python syntax checks plus `git diff --check`. The subsequent semantic-formatting run generated `.test-artifacts/terminal-1791056389610-1381042/`: strict checking, 22 unit tests, all 7 terminal tests (no skips), and diff checking passed. Fresh evidence is generated in `.test-artifacts/terminal-<timestamp>-<pid>/`, not read from archived inputs. Evidence includes invocations, raw terminal streams, parsed screens/cells, live component dumps, tool/provider events, and persisted sessions. Test-owned temporary homes/workspaces are removed after subprocess cleanup.

## Installed extensions

The original terminal gate loaded 11 audited packages in a separate temporary HOME/agent configuration with network/model/notification side effects disabled. The current configured profile has nine eligible audited packages: curated themes and pi-notify were removed from the user's package list; no audited versions changed. The current gate loads those nine without reinstalling or re-enabling removed packages. The profile executes actual registered `TaskCreate` and `TaskList` tools from `@tintinweb/pi-tasks`, comparing exactly two calls, two results, and three provider contexts against a stock profile. Their summary/native rendering, on/off, Ctrl+O, persisted results, and exact same-session stock replay are verified.

Agent, ask-user-question, web, and Magic Context tools have registration/loader checks, not tool execution or renderer coverage. Curated themes and the powerline/footer were present in the original profile. The current profile uses the built-in dark theme and still loads the powerline/footer. AFT's eager Rust/download startup lane and the keep-awake extension's unconditional inhibitor remain excluded; no full user-environment compatibility claim is made. Existing third-party manifest warnings are identical in stock and patched profiles; no extension load/lifecycle errors are observed.

The detailed package/version and coverage table is in [the terminal harness report](../tests/fixtures/TERMINAL.md). Integration evidence includes inventories, registrations, diagnostics, and actual executed tools.

## Initial independent completion gate

The final independent fresh-file review inspected the completed implementation, regressions, actual Pi source contracts, integration startup controls, and the final main-agent artifacts. **No actionable findings.** The hidden-renderer finding is closed; see [the review record](review.md). All initial implementation gates are complete within the documented compatibility and coverage boundary.

## Limits

Kitty/iTerm/Sixel image protocols are not emulated; real image result fallback is covered. Future Pi versions, arbitrary competing patches of the same private methods, every third-party schema/renderer, and every terminal geometry are outside the demonstrated compatibility boundary. Presentation changes do not apply to HTML exports or user shell-message components.

## Standardized multiline summaries

The normative [summary specification](tool-summary-spec.md) replaces the initial tool-specific selection and one-row truncation. Initial specification regressions failed **7 of 27** tests before implementation. The independent review and real CLI run subsequently exposed colored-wrap and zero-width-separator defects; each received a failing regression before correction. After the fixes and additional quoting/ordering cases, strict checking and **31/31 unit tests** pass.

Coverage includes name-independent logical examples for active tool schemas, primary precedence/type fallbacks, priority/alphabetical order, exact payload/secret lists, JSON quoting and nested structure, false/zero/null/empty values, source-data preservation, full long values, Unicode/ANSI wrapping, three-space continuation alignment, hidden predecessors, resize-sensitive single/multiline separators, continuation-row clicks and native self-renderer separator/mouse offset handling.

The final fresh main-agent gate passed `npm run check`, **31/31 unit tests**, **11/11 terminal tests with zero skips**, JS/Python syntax checks, standalone strict driver TypeScript, diff checking and package dry-run. The terminal count is **six top-level scenarios plus five nested regression checks**, not eleven separate CLI scenarios. The package now also ships the normative summary specification; it still contains no test fixtures or host-library copies.

Fresh main-agent evidence: `.test-artifacts/terminal-1791064065599-1594059/`. The multiline scenario compares **19 calls, 19 results and 20 provider contexts** against stock, including full payloads, synthetic credentials, nested values and exact persisted data. It verifies actual fullscreen and regular PTYs at 100/24 columns, adaptive gaps, continuation clicks, ignored separator clicks, native collapse, keyboard expansion, enable/disable, reload and same-session replay. A separate **two-call / two-result / three-context** real-PTY 100→21→100 boundary scenario verifies exactly three continuation spaces and no internal blank content rows after layout is separated from coloring. Widths 0–4 are checked on live components rather than claimed as physical terminal geometries.

The current nine-package gate compares real TaskCreate/TaskList execution, results and contexts with stock; other included tools retain registration-only coverage. AFT and caffeinate remain excluded. The full earlier eleven-package profile is historical evidence, not current coverage.

Final independent fresh-file review found **no actionable findings** and confirmed both root defects closed. The reviewer independently ran all 31 unit tests, strict checking and diff checking, exercised styled error/Unicode/status/source ranges at widths 5–100, and checked the fresh 19/19/20 and two 2/2/3 artifact comparisons. The full CLI run was not redundantly repeated. See [the review closure](review.md).

The real self-shell card fixture proves separator nonduplication: Pi 1.0.0 supplies its leading blank row even though fixture Text components request no padding. Adding an otherwise missing separator and correcting native mouse coordinates are directly covered by the synthetic NativeSelf unit case, not claimed as that CLI branch's coverage. All specification-change gates are closed within the stated compatibility and coverage boundary. No host/user configuration edits or commits were made.
