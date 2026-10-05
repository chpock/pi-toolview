# Testing and coverage

This is the maintained guide to reproducing Toolview checks, not a journal of past runs. Use a repository checkout with its development dependencies; the npm package contains runtime code/documentation, not test fixtures. Visual behavior is specified in the [presentation contracts](../README.md#documentation); integration boundaries are described in [architecture](architecture.md).

## Requirements and commands

- Node.js >=22.19.0, as declared in `package.json`.
- Pinned development host packages installed from the lockfile.
- For terminal tests: a POSIX environment, Python 3 with PTY support, and the real Pi CLI. `PI_TEST_CLI` can select an alternative CLI executable.
- No model credentials are required. The terminal driver uses an offline scripted provider.

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:terminal
npm pack --dry-run
```

`check` is the authoritative strict project TypeScript gate. Unit tests include actual-SDK component/ownership probes as well as deterministic presenter cases. The terminal runner uses `--test-concurrency=1` because its controls drive real CLI processes. Packaging must include every runtime module and maintained document linked from the README, without bundling host libraries or tests.

For a focused edit check, without claiming the unrelated full CLI suite was rerun:

```sh
node --test --test-name-pattern='OpenCode-style edit syntax' --test-concurrency=1 tests/terminal.test.mjs
```

Test names, scenario switches and audited package versions live in the test sources; do not maintain a second version inventory or fixed historical test total here.

## Test layers

| Layer | Purpose |
| --- | --- |
| `tests/unit.test.ts` | Pure formatting/geometry/state regressions, actual SDK integration, compatibility guards and ownership/counter tests |
| `tests/fixtures/cache-probe.ts` | Actual-SDK viewport work and first-installer collection with an active adapter, including an active execution clock |
| `tests/fixtures/cache-partition-probe.ts` | Actual-SDK mixed transcript, independent ordinary/card pressure and detached-edit collection |
| `tests/terminal.test.mjs` | Real bundled CLI execution, physical terminal cells, keyboard/mouse, controls and same-session replay |
| `tests/fixtures/driver.ts` | Offline provider, representative custom tools, explicit metadata-shape scenarios and test-only diagnostics/gates |
| `tests/fixtures/pty_bridge.py` | Real pseudo-terminal transport used by the CLI harness |
| `tests/fixtures/integration-profile.mjs` | Version-audited, isolated installed-extension profile with explicit exclusions |

The unit runner invokes the SDK cache probes in separate Node processes with `--expose-gc`. Forced GC and diagnostic instrumentations are test-only; none run in the extension.

## CLI isolation and evidence

Each CLI run starts with a fresh temporary HOME, agent directory, settings, workspace and session. It loads the offline driver and exercises actual built-in tools, not replacements presented as native execution. Representative metadata fixtures are separate explicit opt-ins. Native, Toolview, off/on, reload and replay controls use the same supplied data and owned workspaces. Child processes use isolated settings and do not inherit model credentials. The installed-profile helper inspects the local package inventory, but tests do not modify user settings, publish packages or change user installations.

Python transports actual PTY output into `@xterm/headless`. Physical-screen assertions inspect terminal cells, including foreground/background/attributes and cursor width, not only calls to `component.render(width)`. The terminal emulator answers native cursor/device queries. Input exercises real keyboard sequences and normalized mouse clicks/selection; no production pointer observer is introduced.

The harness writes fresh evidence under `.test-artifacts/terminal-<timestamp>-<pid>/`. Captures include invocations, dumps, terminal output/screens, tool events, model contexts, sessions and coverage/counter packets. Standalone experiments and review reports also belong under ignored `.test-artifacts/`. Record the tested source baseline, exact command, executed versus skipped coverage, findings and unresolved limits there. Do not append run histories or local agent-session paths to project specifications.

## Strict control comparisons

- Compare actual tool arguments/results, cumulative model contexts and persisted metadata exactly. Presentation checks must not weaken these data checks.
- UI actions must leave saved session bytes unchanged. History replay must execute zero new tools/results/model requests.
- Compare native opt-out/restoration with appropriate native controls, retaining all available output. Normalize only an explicitly variable field, such as native execution duration across separate executions; never erase semantic text to make a comparison pass.
- Native live edit preflight and persisted replay are different in Pi 1.0.0. Compare an edit native override with unpatched replay of the identical session, not a fresh execution whose header may include an asynchronous preview.
- Check complete source/command reconstruction without trimming source characters. Distinguish frame padding from actual source indentation and trailing spaces.
- At narrow widths find complete expected summary row blocks, not only shared title prefixes. When user cards are present, identify Bash frames by actual `$ ` content, not by assuming every `┃` panel is Bash.

## Coverage by presentation

| Area | Required controls |
| --- | --- |
| Compact summaries | Exact primary/parameter ordering and values; payload/secret rules; comma/CJK/grapheme wrapping; continuation origins and one-cell right margin; tiny/zero widths; complete failure colors; no result bodies/badges by default; native expansion |
| Shared frame and Bash | Complete multiline commands; comments/workdir; ten-row visual preview and overflow; partial/final metadata; exact separated footer exception; tabs/Unicode/controls; panel/stripe/margins in both themes; selection-safe whole-panel clicks; regular/fullscreen controls |
| User cards | Original Markdown transformations and semantic styles at equal content widths; OSC 133 zones; physical geometry/colors; native selection and copied text; no user expansion; off/on/reload and replay |
| Edit cards | Actual built-in successes/failures; argument-streaming and executing gates; final failure summaries; old/new syntax including multiline tokens and hidden opening context; metadata formats/hunks/numbers; context cap and omission rules; one-sided unified/mixed split; exact Multiply colors; empty-pane/right-padding paint; native click expansion |
| Edit computation | Complete minified source and bounded ANSI output; monotonic grapheme/ANSI work; per-build colors; validation-only uncached spacing/rejected input; malformed native fallback; large changed blocks without argument-spread overflow |
| Lifecycle/compatibility | Existing/future/history components; hidden/image/native safeguards; exact-name overrides; reload/shutdown/later-owner restoration; native TUI renderer replacement; active-adapter first-installer collection |

CLI edit controls cover dark/light themes, narrow/unified/wide layouts and regular/fullscreen same-session replay. Unit controls additionally cover file-type dispatch beyond the CLI TypeScript/HTML files, alternate metadata shapes, impossible tiny glyphs and native image-protocol fallback. These are distinct layers, not exhaustive parser or graphical-terminal coverage.

## Performance counter discipline

Use observable work counters, not timings as the sole proof:

- An unchanged retained frame must build no custom body and repeat no custom highlighting/wrapping/color work. Updating one tool rebuilds that tool; actual width/theme changes legitimately rebuild affected layouts. Height-only changes/scrolling should reuse retained bodies.
- Proven stock edit custom states must make no discarded native visibility render calls. Unpatched/expanded native controls must remain positive. Custom/mixed/reused-Box self-render visibility must remain native-authoritative, with no phantom neighbor spacing.
- Ordinary and card limits/recency are independent. Card pressure must not evict/rebuild ordinary views. Check per-pool zero/limit reduction, oversized skips, clear/off/shutdown and exact aggregate arithmetic. Lookup misses are not body builds: metadata-only spacing may miss without materializing a diff.
- Retained-byte statistics are accounting estimates; reported process heap is the whole Pi process. Neither establishes Toolview heap ownership, GC pauses or user-session latency.
- SDK synthetic workloads prove mechanisms, not real tool execution. Keep their results separate from actual CLI traffic/replay evidence.

Alternate-width manual dump probes intentionally replace the latest-width cache. Diagnostic scenarios suppress those probes when measuring warm frames; generic captures keep them for width coverage. Spinner diagnostics also avoid width-zero probes, which intentionally stop animation participation. Native asynchronous startup/grammar invalidation can add cold work; establish a controlled cache-clear epoch before asserting exact warm deltas.

Spinner checks prove one shared 100 ms clock, one request per tick regardless of participant count, unchanged custom builds on ticks, real screen glyph movement, immediate final/expansion/off/restore stop and zero idle ticks/requests. They also retain cancellation, native full-information, replay and active-first-installer GC controls. No total CPU/latency or O(1) host-layout claim follows from these counters.

## Installed-extension profile and limits

The installed-profile test reads the allowlist/version audit in `integration-profile.mjs`. An unavailable or mismatched safe profile is an explicit skip, not a passing integration. Its sanitized environment and temporary configuration preserve real registration while disabling networked/secondary model work and unrelated background services. Fresh HOME is required as well as the isolated agent directory because some packages read `homedir()` directly.

In that profile, local task tools have real execution/renderer coverage. Agent, web, ask and Magic Context integrations have registration-only coverage; registration does not prove their renderer ran. AFT is excluded because startup schedules auto-build/refresh/warmup work; keep-awake is excluded because it starts an OS sleep inhibitor. Deterministic AFT-shaped diff/diagnostic/exit metadata tests do not execute installed AFT or subscribe to its LSP.

No full user-runtime compatibility guarantee is made. Graphical Kitty/iTerm2 image display, all host/parser/terminal versions, identical OpenCode Tree-sitter grammars or literal screenshots, arbitrary competing private-method hooks and whole-process heap/latency distributions are not established by this harness.

## Changing behavior

Start with a failing regression for the contract being changed. Keep native/data controls strict, run the affected gates, and use an independent fresh-file review for substantive behavior/integration changes. Reviewers should read the current source and authoritative SDK/reference sources; summaries and an earlier green run are not a substitute. Record findings and final execution evidence locally, explicitly separating reviewer source inspection from parent-run compiler/tests.

Maintained documentation describes the current architecture, accepted behavior and reproducible verification method. Historical run counts, superseded proposals and agent handoffs are working artifacts, not new project contracts.
