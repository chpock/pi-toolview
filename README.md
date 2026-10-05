# Pi Toolview

An alternative presentation for Pi tools: concise summaries for ordinary operations, terminal-style bash cards, and native rich cards for other commands, writes, and diffs.

```text
 → read src/app.ts [offset=5, limit=10] ✓
 ⚙ grep "handleRequest" in src ✓
 ⚙ aft_zoom src/app.ts [symbols="render"] ✓

 ┃
 ┃ # Run the regression tests
 ┃
 ┃ $ npm test
 ┃
 ┃ tests passed
 ┃

 → read missing.ts — ENOENT: … ✗
```

This is not a blanket card shrinker. Tool purpose determines the default presentation; reading a large file still produces a summary. Full available results remain accessible through expansion.

## Try it

From this repository, without changing your settings:

```sh
pi -e ./src/index.ts
```

Or install this directory as a local Pi package:

```sh
pi install /absolute/path/to/pi-toolview
```

Pi loads the TypeScript source directly. No build, fork, copying into `~/.pi`, or npm publication is necessary. To remove the local installation, use `pi remove /absolute/path/to/pi-toolview`.

## Behavior

- Collapsed text-only tools use a summary by default, including third-party tools.
- `bash` uses a terminal-style card: optional muted description/workdir comments, `$ ` followed by the complete command with no continuation alignment, streamed first-ten-visual-row output, and a metadata-only error/exit footer. Clicking anywhere in an expandable panel toggles full available output; Ctrl+O works too. Exterior margins are not clickable; active text selection suppresses toggling. The panel has a neutral background, left-only strip (terminal-default background in all states, the same `error` foreground as the footer on failure), one exterior and one interior column on each side. Hover highlighting is disabled; pointer motion does not change its background. See the [shared card frame specification](docs/card-frame-spec.md). Status is never inferred from output and no additional output files are read. The only semantic output exception removes a separated terminal exit footer exactly matching our metadata-derived final footer; trailing blank preview rows are removed before the expansion hint. Raw tool/model/session content is unchanged. See the [normative bash card specification](docs/bash-card-spec.md), including metadata and upstream truncation limits.
- `powershell`, `write`, and `edit` retain their original cards/renderers.
- Single-row summaries are adjacent. A wrapped summary gets one blank row before the following tool, without a trailing spacer or duplicate native-card separator.
- Summaries show the exact tool name, a primary pattern/object when present, all remaining non-payload arguments, and `…` (pending), `✓` (complete), or `✗` (failed). Completed errors include a short first-line explanation.
- The leading symbol uses `dim`, the tool name uses `toolTitle`, and the primary pattern/object uses `muted`. Named parameters are enclosed in `[]` and use `dim`; an empty block is omitted. These are active-theme roles, not hardcoded colors.
- Argument formatting is tool-name independent: pattern first, otherwise the first nonempty string in `path`/`target`/`url`/`scope` (also required for `path` after a pattern). Empty strings and non-string values remain named parameters. `paths` is always a named parameter and comes first, followed by unconsumed `path`, `target`, `url`, `scope`, other important named fields and alphabetically sorted remaining fields. Strings use JSON quoting, payload fields are excluded, and exact top-level secret fields are masked. Masking does not redact native expansion, nested secrets, or saved/model data.
- Long descriptions wrap rather than truncate. Continuations align with the tool name (three spaces), not the parameter bracket. Widths 1–4 show only the state marker. See the [normative summary specification](docs/tool-summary-spec.md) for the exact lists and examples.
- Ctrl+O uses Pi's original global expansion behavior. In fullscreen mode, clicking a completed summary expands that call; clicking the expanded native card collapses it. Regular mode uses terminal-owned mouse handling, so use Ctrl+O there.
- Expanded ordinary tools, images, and tools deliberately hidden by their renderer keep native behavior. Expanded bash remains a terminal-style card unless explicitly opted out.
- Summaries respect the current theme and terminal column widths. Untrusted arguments cannot inject terminal controls or arbitrary newlines; wrapping is renderer-controlled.
- Tool execution, model-facing results, and saved session data are unchanged.

### Controls

```text
/toolview status
/toolview off
/toolview on
/toolview cache
/toolview cache clear
/toolview cache limit 4
```

Custom content is cached between frames with an **8 MiB estimated retained-layout budget** and a **2048-entry cap**, using weak component state and one latest width per component. Collapsed Bash wraps only enough output to show ten rows and detect overflow. Neighbor spacing reuses metadata instead of rebuilding previous Bash output. Changed args/results, expansion, theme and actual width rebuild the affected layout. No polling or UI-update throttling is introduced; commands/results remain complete and physical width/click bounds stay safe.

`/toolview cache` samples cache bytes/entries/hit/miss/build/eviction/skip counters and labels heap usage as **whole Pi process**, not Toolview. `clear` releases retained layouts; `limit <MiB>` changes the current budget (0–64; 0 disables retention). Estimates bound retained custom layout, not host/native cache or total process memory. Oversized entries are not retained, and transient formatting of new/expanded large data is not subject to that retained-data budget. Optional `--toolview-cache-mb 4` sets the initial budget. Limits are not persisted and reload returns to the launch/default limit. See the [render-cache/performance contract](docs/render-cache-spec.md).

Controls apply to the current extension runtime only. Disabling restores the original rendering methods; re-enabling covers existing and future calls. Reload creates a fresh enabled runtime.

Use exact, case-sensitive tool names to customize the presentation for one invocation:

```sh
pi -e ./src/index.ts --toolview-card Agent,ask_user_question
pi -e ./src/index.ts --toolview-compact write
```

`--toolview-card` adds to the native-card defaults; explicitly naming `bash` restores its original Pi card. `--toolview-compact` takes precedence over that list, but never over expansion, image, or hidden-component safeguards. There is no separate configuration file in this initial version.

## Compatibility

The initial supported and tested host is **Pi 1.0.0**. The extension obtains Pi's stable TUI reference through a public widget factory, then narrowly replaces private tool component `render`/`handleMouse` methods and observes `Container.addChild`. Cache invalidation additionally wraps the UI component's `updateArgs`, `updateResult`, `setExpanded` and `invalidate` without changing their native behavior; no tool execution method is wrapped. Hover and its dedicated input interception have been removed: no raw input observer, private viewport-input wrapper, receiver probe or input-hook migration. Pi retains native mouse/focus processing; Toolview handles only already-normalized card clicks. See the [frame integration contract](docs/card-frame-spec.md). It does not import private host modules or ship copies of Pi's libraries.

This is intentionally a compatibility-sensitive integration. If the inspected component contract cannot be established, Toolview warns and retains native rendering. Runtime restoration does not overwrite hooks subsequently replaced by another extension. Arbitrary extensions wrapping the same private methods and future Pi versions are not guaranteed compatible; run the terminal checks after upgrading.

The extension is inactive in print, JSON, and RPC modes. Presentation changes are limited to interactive terminal tools, not HTML exports or standalone user shell messages.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:terminal
```

Development copies of host packages are pinned for reproducible tests; runtime imports are wildcard peer dependencies supplied by Pi. There is no bundling step.

Terminal tests require a POSIX environment, Python 3, and a real Pi CLI. They use an offline scripted provider, isolated configuration/workspaces, real tool execution and keyboard/mouse input, and native control runs. They do not require model credentials. Generated evidence belongs in the gitignored `.test-artifacts/` directory.

The installed-package smoke test is version-audited and skips explicitly when that profile is unavailable. In the verified profile, real task tools are executed; Agent, web, ask, and Magic Context tools have registration-only coverage. AFT and keep-awake are excluded because of their startup side effects. This is not a full user-runtime compatibility guarantee.

See [the implementation contract](docs/implementation.md), [verification record](docs/verification.md), and [independent review](docs/review.md) for scope, evidence, and limits.
