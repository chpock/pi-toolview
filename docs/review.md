# Independent review

## Pass 1: production adapter and component tests

An independent reviewer freshly read `src/index.ts`, `tests/unit.test.ts`, `package.json`, `tsconfig.json`, and `docs/implementation.md`, then compared the integration assumptions against the installed Pi 1.0.0 source files.

**Result: no actionable findings.** No reachable production defects were identified. The reviewer separately ran the then-current 15 component tests and strict TypeScript checking successfully. Three additional lifecycle/non-TUI tests were added afterward and passed in the main implementation run (18 total); those additions were not part of the first review's test count.

Confirmed host evidence:

- `dist/modes/interactive/components/tool-execution.js:7–33,168–223`: component fields and native rendering/mouse behavior.
- `dist/modes/interactive/interactive-mode.js:1812–1845`: live TUI passed to widget factories.
- `dist/core/extensions/loader.js:464–476` and `virtual-modules.js:13–29`: host module mapping for extension imports.
- Host `pi-tui/dist/tui.js:87–142`: attachment, rendering order, and mouse coordinate dispatch.
- `dist/core/agent-session.js:2899–2929` and `interactive-mode.js:5294–5368`: reload shuts down the old extension runtime and rebuilds transcript components before the next `session_start`.

The review verified that production code does not register replacement tools, rewrite arguments/results, or change session serialization. Selective presentation, native delegation, current-theme lookup, width/input safety, and owned-hook restoration match the contract.

Private component fields, the shared `Container.addChild` hook, future host changes, and arbitrary other extensions patching the same methods remain documented compatibility risks, not demonstrated defects.

This first pass deliberately did not close the real-terminal or installed-extension verification gates: the terminal harness was still being implemented. A final pass must inspect those completed artifacts and results before declaring the initial implementation complete.

## Terminal finding: hidden self-rendered components

The real-CLI harness found a reachable defect missed by the first component-test model: `tv_hidden` intentionally returns empty `Text` components from both native renderers with `renderShell: "self"`, but Toolview displayed a summary. The same-session stock control rendered `[]`. Compact policy overrides exposed the same problem on replay.

Root cause: Pi's `hideComponent` flag does **not** fully describe native visibility. `updateDisplay()` marks content present when a renderer returns a component, even if that component later renders zero rows. The self-shell branch in native `render(width)` separately returns `[]` when actual rendered content and images are empty. The initial adapter checked only the flag.

A new component regression first reproduced the failure (18 passed, 1 failed). The adapter now asks the original self-shell renderer for visibility at the actual viewport width before summarizing. The same native-visibility rule is used when determining neighboring summary spacing and mouse eligibility. Hidden output remains hidden even with explicit compact overrides; non-self tools do not incur the extra native visibility render. The regression additionally covers width-dependent visibility and expanded native delegation.

Initial failing live evidence is retained in `.test-artifacts/terminal-1791051260789-1262479/`. The terminal assertions were not weakened. Fresh full-suite verification and independent follow-up review are required to close this finding.

## Pass 2: final independent verification

A separate independent read-only reviewer freshly inspected the completed production source, unit and terminal tests/fixtures, manifest/TypeScript configuration, README and all implementation records against initial Git baseline `fc5da18`. The reviewer compared the private adapter assumptions with the actual installed Pi 1.0.0 component/TUI/loader/reload implementation, inspected the claimed installed-profile startup controls, and examined the fresh main-agent evidence in `.test-artifacts/terminal-1791052532782-1291897/`.

**Result: no actionable findings.** The hidden self-shell fix was confirmed at the correct layer, with consistent visibility rules for summaries, spacing and mouse routing. No weakened terminal assertions were found. The reachable finding above is **closed** by the regression, fresh passing terminal controls, and this independent follow-up.

The final reviewer independently ran Git state/diff checks and reviewed source/assertions/evidence; they did not redundantly run the full PTY suite. The main-agent fresh command passed production/unit/driver TypeScript, **19/19 unit tests**, **7/7 terminal tests with no skips**, JS/Python syntax, and `git diff --check`.

Future Pi versions, competing private-method patches, unexecuted third-party renderers, terminal graphics protocols, and the excluded AFT/keep-awake packages remain explicitly documented compatibility/coverage boundaries, not confirmed defects. No commits or user-configuration changes were made. All initial implementation verification gates are closed within the stated boundary.

## Pass 3: semantic summary formatting

The follow-up changes only compact-label composition: `dim` prefix, `toolTitle` name, `muted` read filename, and `dim` bracketed parameters. Statuses, native delegation, visibility, input routing, and lifecycle are unchanged. Three new unit regressions were added first; two failed against the previous implementation. After implementation, strict checking, **22/22 unit tests**, **7/7 real-terminal tests without skips**, and diff checking passed. Fresh evidence: `.test-artifacts/terminal-1791056389610-1381042/`.

An independent reviewer freshly inspected the focused source/tests/documentation and sampled the new evidence. They also independently ran the three focused regressions (**3/3**) and diff checking, without duplicating the full terminal run. **No actionable findings.** The real-screen role assertions cover dark/light theme foreground and faint attributes for the arrow, name, filename, and parameter block. Native behavior and the previous verification boundaries remain intact. No settings changes or commits.

## Pass 4: standardized multiline implementation — findings

An independent fresh-file review compared the new summary specification, source and component tests with the installed Pi 1.0.0 layout/mouse implementation. Terminal files were still under construction and deliberately excluded from this pass.

**P2, confirmed:** passing styled segments to Pi 1.0.0's `wrapTextWithAnsi` can turn a colored inter-segment space into content. At width 21, `read({path: "abcdefghijklm", limit: 1})` produced four rather than three leading continuation spaces. A long query at the same boundary could produce a whitespace-only content row, affecting both adaptive spacing and clickable height. Root cause was verified in `pi-tui/dist/utils.js`: whitespace classification uses `token.trim()` without removing attached ANSI codes.

A new colored-boundary regression reproduced the first failure before correction. The formatter now computes wrapping on plain logical text, then applies semantic colors to the corresponding source spans. This separates layout from styling rather than stripping padding or blank rows after a faulty colored wrap. The installed host is unchanged. The same regression also checks long-token preservation and absence of blank content rows.

The reviewer also found one documentation example with `limit` after alphabetically sorted fields; it was corrected to the normative importance order. The review/terminal gates are closed in Pass 5 below.

**Terminal boundary finding, confirmed:** a compact call at width zero could retain a leading separator even though its summary had no content rows, returning `[""]` instead of `[]`. A two-call component regression reproduced this before correction. The compact render path now exits before computing separation at nonpositive width. The full terminal rerun and independent follow-up are recorded in Pass 5 below.

**Harness environment change:** the currently configured installed profile contains nine eligible audited packages; curated themes and desktop notifications are no longer declared. No audited versions changed. The previous fixed eleven-package prerequisite therefore skipped otherwise valid current-profile coverage. The harness now uses the actual configured audited profile and a built-in theme when curated themes are absent, without installing or re-enabling removed packages. Its package/version allowlist and the AFT/caffeinate safety exclusions are unchanged.

Fresh main-agent verification passed strict checking, **31/31 unit tests**, **11/11 CLI checks with no skips** (six top-level scenarios and five nested checks), standalone driver TypeScript, JS/Python syntax, diff checking and package dry-run. Evidence: `.test-artifacts/terminal-1791064065599-1594059/`. The actual 21-column ANSI screen has exactly three continuation spaces and no internal blank content rows; live zero-width compact rendering returns `[]`. The 19-call multiline scenario and two-call boundary scenario preserve exact calls/results/provider contexts and session data against stock. The current nine-package profile passes real local task execution and registration checks, not a claim of execution coverage for every installed tool. The independent fresh-file closure is recorded in Pass 5 below.

## Pass 5: final standardized-summary acceptance

A fresh independent reviewer read the complete normative specification and the current production source, component/CLI tests and relevant fixtures/profile controls, documentation and manifest, then compared the input/layout assumptions with actual Pi 1.0.0 source. They checked the fresh main-agent evidence in `.test-artifacts/terminal-1791064065599-1594059/`, not only earlier summaries.

**Result: no actionable findings. Both root defects above are closed.** Plain logical wrapping followed by source-span styling retains text and semantic roles without post-render padding repair; the nonpositive-width entry point returns no compact rows before separation. The reviewer independently ran **31/31 unit tests**, strict TypeScript and diff checking, plus a separate styled error/Unicode/status/span check over widths **5–100**. They inspected the unchanged **19/19/20** multiline, **2/2/3** boundary and **2/2/3** installed-task event comparisons and the actual width-21/zero-width evidence. They did not redundantly rerun the complete CLI suite; the main-agent **11/11 zero-skip** result is supported by fresh source/assertion and artifact review.

One coverage clarification was incorporated into the terminal/verification reports: real Pi 1.0.0 inserts a leading blank row for the self-shell card fixture even when its Text components request no padding. That CLI case proves nonduplication, not execution of the missing-separator branch. The synthetic NativeSelf unit case directly verifies that branch and mouse-coordinate correction. Third-party tool execution is still demonstrated only for TaskCreate/TaskList; other included tools are registration-only, and AFT/caffeinate remain excluded.

All accepted-specification implementation and verification gates are closed within these documented limits. No commits, user settings changes or installed-host source edits were made.

## Pass 6: paths as the first named parameter

A focused independent read-only reviewer inspected the source, normative specification, unit/CLI expectations, README and harness report changes against commit `356739b`. **No actionable findings.** They confirmed that `paths` is no longer a primary candidate and precedes `query` in the importance list; the remaining primary precedence, pattern/path branch and value/color/wrapping/execution mechanisms are unchanged. The CLI change only updates three complete expected summaries without weakening controls or changing scenario arguments/results.

The reviewer independently ran the three focused unit tests and diff checking. The main-agent first-red run had failed all three against the previous implementation; fresh full verification then passed strict checking, **32/32 unit tests** and **11/11 CLI checks with no skips**. Evidence: `.test-artifacts/terminal-1791068438577-1717263/`. The reviewer did not independently repeat first-red or the full CLI suite. No settings changes or commits were part of this follow-up.

## Pass 7: nonempty-string primary locations

A fresh focused independent read-only reviewer inspected the current combined uncommitted changes against `356739b`: the preceding paths-first change and the new string-only location rule. They read the full normative specification and checked source, component/CLI expectations, README and harness contract statements. **No actionable findings.** Primary locations require primitive strings with supplied length greater than zero, without implicit trim; pattern/path selection uses the same guard, while empty pattern remains supported. Rejected primary values are retained as named JSON parameters in the agreed paths/path/target/url/scope-first order. No unrelated adapter changes or weakened CLI assertions were found.

The reviewer independently passed **5/5 focused unit tests** and diff checking. The main first-red run failed four affected tests before implementation; strict checking and **33/33 unit tests** then passed. Fresh full CLI verification passed **11/11 checks with zero skips**, with the original scenario data, stock result/context comparisons and input/lifecycle assertions preserved. Evidence: `.test-artifacts/terminal-1791069409913-1745350/`. The reviewer did not redundantly repeat first-red or the complete check/unit/CLI gates. No commits, user settings changes or installed-host source edits were made.
