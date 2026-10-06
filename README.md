# Pi Toolview

An alternative presentation for Pi: concise tool summaries, terminal-style bash cards, framed user messages, OpenCode-style syntax-colored edit diffs, source-aware write cards, and native rich cards for other commands.

```text
 → read src/app.ts [offset=5, limit=10]
 ⚙ grep "handleRequest" in src
 ⠋ aft_zoom src/app.ts [symbols="render"]

 ┃
 ┃ # Run the regression tests
 ┃
 ┃ $ npm test
 ┃
 ┃ tests passed
 ┃

 → read missing.ts
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

- Collapsed text-only tools use compact summaries by default, including third-party tools. Action/target fields precede auxiliary and content fields; payloads are visible and exact top-level secrets remain masked. Displayed values are capped at 256 Unicode graphemes, with 1024 for the complete name/argument preview; `…` marks abbreviation and wrapping adds no further truncation.
- Summaries show `→` for `read`, otherwise `⚙`. Actual execution replaces that glyph with a shared spinner. Final failures color the entire summary with `error`; result/error bodies stay available through native expansion. Trailing status markers are disabled by the source constant `SHOW_COMPLETION_MARKERS = false`.
- `bash` uses a terminal-style card with the complete command, optional description/workdir, a ten-visual-row output preview and a metadata-derived error footer. Expansion shows all already-available output, never rereads output files or reconstructs upstream truncation.
- Ordinary user messages share the frame, using `customMessageLabel` for the stripe and `userMessageBg` for the panel. Native Markdown styles, transformations, selection/copy and navigation zones are preserved; user cards have no expansion behavior.
- `edit` uses a compact `edit <path>` before completion and on failure, ignoring every other argument when `path` is a nonempty string; without that path it uses generic formatting. Only final success enters the syntax-colored diff presenter: `← Edited <path>`, original line numbers, up to three unchanged context lines per side (`DIFF_CONTEXT_LINES`), and syntax highlighting inside changed code. Addition-only/removal-only diffs are always unified; mixed changes split above 120 columns. Missing metadata gives an inline success title; unsupported metadata delegates to native.
- `write` follows edit's path-only compact lifecycle, then shows `Created` (additions only), `Edited` (additions plus context), `Replaced` (any removals), or `Wrote` (no changes/diff or explicitly truncated diff). Created/Wrote use numbered syntax-colored source without diff signs/tint; Edited/Replaced reuse edit's diff. All available changes remain visible. `Created` includes filling an existing empty file, not proof of new-file creation. No-diff Wrote shows submitted content, not guaranteed post-format bytes; explicit truncation is noted.
- `powershell` keeps its original renderer. Ordinary expanded calls, images and intentional native hiding remain native; expanded Bash retains its custom card unless opted out.
- Consecutive single-row summaries are adjacent; a wrapped summary introduces one blank row before the following tool. Card content has one exterior and one interior column per side, a left-only stripe and no hover paint.
- Ctrl+O remains Pi's global expansion control. In fullscreen mode, completed summaries/edit/write panels expand on click and expandable Bash panels toggle; exterior margins/separators are not targets. Card clicks do not interrupt active selection. Regular mode uses terminal-owned mouse handling, so use Ctrl+O there.
- Colors follow the active Pi theme and layouts follow the actual viewport width. Tool execution, model-facing results and saved session data are unchanged.

Exact formatting, metadata, geometry and safeguards are defined in the [specifications](#documentation).

### Controls

```text
/toolview status
/toolview off
/toolview on
/toolview cache
/toolview cache clear
/toolview cache limit 4
/toolview cache cards limit 128
```

Rendered layouts use two independent least-recently-used caches, each capped at 2048 entries:

| Pool | Default budget | Contents |
| --- | ---: | --- |
| `ordinary` | 8 MiB | Summaries, user cards, edit headings and edit/write native fallback |
| `cards` | 128 MiB | Collapsed/expanded Bash, successful edit diffs and write frames |

Card pressure cannot evict ordinary views. Each component keeps only its latest width/state; unchanged frames reuse prepared rows. Actual width/theme and relevant state changes rebuild affected content. The execution spinner changes only its prefix and has no idle timer.

`/toolview cache` reports each pool and their aggregate. `clear` releases both; `limit <MiB>` changes ordinary retention (0–64) and `cards limit <MiB>` changes card retention (0–128). Zero disables only the selected pool. Optional `--toolview-cache-mb` and `--toolview-card-cache-mb` set initial limits. Limits survive off/on but are not persisted; reload returns to launch/default limits.

Budgets estimate retained custom data, not upfront allocation or total process memory. Oversized entries are not retained. Reported heap usage is **whole Pi process**, not Toolview. Native host work and transient formatting remain outside these budgets; see the [cache contract](docs/render-cache-spec.md).

Controls apply to the current extension runtime only. Disabling restores the original rendering methods; re-enabling covers existing and future calls. Reload creates a fresh enabled runtime.

Use exact, case-sensitive tool names to customize the presentation for one invocation:

```sh
pi -e ./src/index.ts --toolview-card Agent,ask_user_question
pi -e ./src/index.ts --toolview-compact write
```

`--toolview-card` adds to the native-card defaults; explicitly naming `bash`, `edit` or `write` restores its original Pi card. `--toolview-compact` takes precedence over that list, but never over expansion, image, or hidden-component safeguards. There is no separate configuration file.

## Compatibility

The supported/tested host is **Pi 1.0.0**. One adapter obtains the stable TUI reference through a public widget factory and narrowly wraps private component rendering, normalized tool clicks, UI updates and child attachment. Native methods still execute; no tool execution or raw input is intercepted. Host libraries are not bundled or privately imported. See [architecture](docs/architecture.md) for the integration and ownership boundaries.

This is intentionally a compatibility-sensitive integration. If the inspected component contract cannot be established, Toolview warns and retains native rendering. Runtime restoration does not overwrite hooks subsequently replaced by another extension. Arbitrary extensions wrapping the same private methods and future Pi versions are not guaranteed compatible; run the terminal checks after upgrading.

The extension is inactive in print, JSON, and RPC modes. Presentation changes are limited to interactive terminal tools and ordinary user messages, not HTML exports or standalone user shell messages.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run test:terminal
```

Development copies of host packages are pinned for reproducible tests; runtime imports are wildcard peer dependencies supplied by Pi. There is no bundling step.

Terminal tests require a POSIX environment, Python 3, and a real Pi CLI. They use an offline scripted provider, isolated configuration/workspaces, real tool execution and keyboard/mouse input, and native control runs. They do not require model credentials. Generated evidence belongs in the gitignored `.test-artifacts/` directory.

The installed-package smoke test is version-audited and explicitly skips unavailable profiles; it is not a full user-runtime compatibility guarantee. See [testing and coverage](docs/testing.md) for the harness, reproducible checks and exclusions.

## Documentation

- [Architecture](docs/architecture.md) — modules, host integration, lifecycle, data and ownership boundaries.
- [Tool summary specification](docs/tool-summary-spec.md) — arguments, status, wrapping and compact input.
- [Bash card specification](docs/bash-card-spec.md) — command/output/footer semantics and expansion.
- [Edit card specification](docs/edit-card-spec.md) — persisted metadata, syntax, diff format and lifecycle.
- [Write card specification](docs/write-card-spec.md) — source classification, numbered plain/diff bodies and fallbacks.
- [Shared frame specification](docs/card-frame-spec.md) — geometry, paint, user cards and click bounds.
- [Render-cache specification](docs/render-cache-spec.md) — invalidation, memory pools, controls and performance guarantees.
- [Testing and coverage](docs/testing.md) — automated gates, strict native/data controls and coverage limits.

These documents describe the current project. Run evidence and working review reports belong in gitignored `.test-artifacts/`, not in the documentation tree.
