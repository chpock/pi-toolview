# Pi Toolview

An alternative presentation for Pi: concise tool summaries, terminal-style bash cards, framed user messages and input, OpenCode-style syntax-colored edit diffs, source-aware write cards, native rich cards for other commands, and a compact session footer.

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

- Collapsed text-only tools use compact summaries by default, including third-party tools. Action/target fields precede auxiliary and content fields; payloads are visible and exact top-level secrets remain masked. Displayed values are capped at 256 Unicode graphemes, with 1024 for the complete name/argument preview; `…` marks abbreviation and wrapping adds no further truncation. Oversized words fill preceding-row space and prefer nearby path/URL separators without wasting more than half the available space; fitting words remain whole.
- Summaries show `→` for `read`, `←` for `edit`/`write`, otherwise `⚙`. Actual execution replaces that glyph with a shared spinner. Final failures color the entire summary with `error`; result/error bodies stay available through native expansion. Trailing status markers are disabled by the source constant `SHOW_COMPLETION_MARKERS = false`.
- `bash` uses a terminal-style card with the complete command, optional description/workdir, a ten-visual-row output preview and a metadata-derived error footer. Expansion shows all already-available output, never rereads output files or reconstructs upstream truncation.
- Ordinary user messages share the frame, using `customMessageLabel` for the stripe and `userMessageBg` for the panel. Native Markdown styles, transformations, selection/copy and navigation zones are preserved; user cards have no expansion behavior.
- Main text input shares the user-card stripe/background, without horizontal borders or a prompt glyph. The same native editor retains paste/image markers, undo/history, shortcuts and autocomplete; native menus stay below the panel. One unpainted row separates upper widgets from the input panel; absent/zero-row widgets add no extra separator, and lower widgets do not trigger it. Pi's **Editor padding** sets exterior margins of the whole input panel, including its status and lower edge, immediately; its inner gap stays one column even at zero. Transcript cards are unaffected. A public `belowEditor` widget adds model-name/provider-ID/thinking information, ` • Idle` only at idle, a right-aligned `cwd:branch`, and a `╹▀…` half-height panel edge. The session footer requires the same eligible stock input; losing input ownership also releases our footer without overwriting a later footer owner. Directory fitting prioritizes its last name; Git determines whether a named branch exists. Both widget rows disappear while the native autocomplete list is open; pending lookup alone does not hide them. Working and other activity remain in Pi's separate native container above the input, with Pi's own object, animation and lifecycle. Metadata follows ordinary belowEditor height clipping, independently of native activity. Custom editor factories remain native; impossible tiny widths delegate to Pi. See the [editor contract](docs/card-frame-spec.md#main-input-editor).
- `edit` uses a compact `edit <path>` before completion and on failure, ignoring every other argument when `path` is a nonempty string; without that path it uses generic formatting. Only final success enters the syntax-colored diff presenter: `← Edited <path>`, original line numbers, up to three unchanged context lines per side (`DIFF_CONTEXT_LINES`), and syntax highlighting inside changed code. Addition-only/removal-only diffs are always unified; mixed changes split above 120 columns. Missing metadata gives an inline success title; unsupported metadata delegates to native.
- `write` follows edit's path-only compact lifecycle, then shows `Created` (additions only), `Edited` (additions plus context), `Replaced` (any removals), or `Wrote` (no changes/diff or explicitly truncated diff). Created/Wrote use numbered syntax-colored source without diff signs/tint; Edited/Replaced reuse edit's diff. All available changes remain visible. `Created` includes filling an existing empty file, not proof of new-file creation. No-diff Wrote shows submitted content, not guaranteed post-format bytes; explicit truncation is noted.
- `powershell` keeps its original renderer. Ordinary expanded calls, images and intentional native hiding remain native; expanded Bash retains its custom card unless opted out.
- Consecutive single-row summaries are adjacent; a wrapped summary introduces one blank row before the following tool. Pi's **Output padding** (0 or 1, default 1) sets the exterior left/right margins of transcript summaries, Bash/edit/write cards and user messages, immediately without reload. Cards retain one fixed interior column per side, a left-only stripe and no hover paint. Output padding does not change Editor padding, the input/status panel or the footer.
- Ctrl+O remains Pi's global expansion control. In fullscreen mode, completed summaries/edit/write panels expand on click and expandable Bash panels toggle; exterior margins/separators are not targets. Card clicks do not interrupt active selection. Regular mode uses terminal-owned mouse handling, so use Ctrl+O there.
- One public session footer shows input/output totals, current context count/window/percent, cache read/write and hit rate, cost/subscription, then right-aligned extension statuses. Cwd/branch and model/provider/thinking are omitted there. Indicators/numbers use separate theme roles; CH and context percentages retain their specified effectiveness/fullness colors. Whole statuses move to later rows when needed; only a status wider than a full row is ellipsized, never internally wrapped. Left metric overflow wraps instead of hiding numbers. See the [footer contract](docs/footer-spec.md).
- Fixed file-backed themes can set terminal defaults from `export.pageBg` and `colors.text`, including variable chains and native color formats. Missing/empty values release only our channels; source errors retain the last valid complete targets. Auto/system modes suspend application and release defaults before Pi queries its profile. A zero-row observer follows native theme/hot-reload updates without polling. RGB calculations use a local concrete projection rather than modifying Pi's Theme. See the [terminal-color contract](docs/terminal-colors-spec.md).
- Colors follow the active Pi theme and layouts follow the actual viewport width. Tool execution, model-facing results and saved session data are unchanged.

Exact formatting, metadata, geometry and safeguards are defined in the [specifications](#documentation).

### Controls

```text
/toolview status
/toolview off
/toolview on
/toolview colors status
/toolview colors off
/toolview colors on
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

Card pressure cannot evict ordinary views. Each component keeps only its latest width/state; unchanged frames reuse prepared rows. Actual width/Output-padding/theme and relevant state changes rebuild affected content. The execution spinner changes only its prefix and has no idle timer.

`/toolview cache` reports each pool and their aggregate. `clear` releases both; `limit <MiB>` changes ordinary retention (0–64) and `cards limit <MiB>` changes card retention (0–128). Zero disables only the selected pool. Optional `--toolview-cache-mb` and `--toolview-card-cache-mb` set initial limits. Limits survive off/on but are not persisted; reload returns to launch/default limits.

Budgets estimate retained custom data, not upfront allocation or total process memory. Oversized entries are not retained. Reported heap usage is **whole Pi process**, not Toolview. Native host work and transient formatting remain outside these budgets; see the [cache contract](docs/render-cache-spec.md).

`/toolview colors off` stops terminal-default application and theme reads without disabling cards. Remaining presentation can make a one-shot profile RGB query after releasing colors. On retries the current source; global on respects local off. Reload enables the feature again. Releases restore terminal **profile defaults**, not another application's prior dynamic override. Disable the old standalone `theme-background` extension manually: concurrent default-color writers are unsupported.

Controls apply to the current extension runtime only. Disabling restores the original presentation methods, including the editor, without transferring its draft; re-enabling covers existing and future components. Reload creates a fresh enabled runtime.

Use exact, case-sensitive tool names to customize the presentation for one invocation:

```sh
pi -e ./src/index.ts --toolview-card Agent,ask_user_question
pi -e ./src/index.ts --toolview-compact write
```

`--toolview-card` adds to the native-card defaults; explicitly naming `bash`, `edit` or `write` restores its original Pi card. `--toolview-compact` takes precedence over that list, but never over expansion, image, or hidden-component safeguards. There is no separate configuration file.

## Compatibility

The supported/tested host is **Pi 1.0.0**. One adapter obtains the stable TUI reference through a public widget factory and narrowly wraps private component rendering, normalized tool clicks, UI updates, stock-editor presentation and child attachment. Native methods still execute; no tool execution or raw input is intercepted. Host libraries are not bundled or privately imported. See [architecture](docs/architecture.md) for the integration and ownership boundaries.

This is intentionally a compatibility-sensitive integration. If the inspected component contract cannot be established, Toolview warns and retains native rendering. Runtime restoration does not overwrite hooks subsequently replaced by another extension. Arbitrary extensions wrapping the same private methods and future Pi versions are not guaranteed compatible; run the terminal checks after upgrading.

**Main-input styling is stock-editor-only.** If another extension installs or replaces its own editor (for example, `pi-powerline-footer`), Toolview leaves that editor and its appearance under the owning extension's control. It does not disable the extension or replace its editing behavior. This ownership limitation also disables Toolview's session footer, restoring stock only while we own that slot. Tool and user-message cards retain their own eligibility safeguards. Terminal-default synchronization is global and remains independent of editor/footer ownership. After the stock editor returns, `/toolview on` or reload reinstalls the footer; an ineligible editor cannot reclaim it. Footer-only extensions do not block input styling. Footer replacements instead compete for Pi's single footer slot: the last owner wins. Off restores stock only while Toolview still owns it, never removes a later owner, and cannot restore a previous foreign footer. Publishers using `setStatus` coexist through the shared status map. See the [editor contract](docs/card-frame-spec.md#main-input-editor).

The extension is inactive in print, JSON, and RPC modes. Component restyling applies to interactive terminal tools, ordinary user messages, the stock main editor and the session footer, not HTML exports or standalone user shell messages. Terminal defaults affect the shared terminal. Their eligibility additionally depends on one guarded native renderer flag; missing/incompatible state disables only this feature with a warning.

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
- [Shared frame specification](docs/card-frame-spec.md) — geometry, paint, user cards, main input and click bounds.
- [Terminal-color specification](docs/terminal-colors-spec.md) — fixed-theme metadata, automatic-mode boundaries, OSC ownership and concrete RGB.
- [Session-footer specification](docs/footer-spec.md) — native usage/context data, colors, whole-status fitting and ownership.
- [Render-cache specification](docs/render-cache-spec.md) — invalidation, memory pools, controls and performance guarantees.
- [Testing and coverage](docs/testing.md) — automated gates, strict native/data controls and coverage limits.

These documents describe the current project. Run evidence and working review reports belong in gitignored `.test-artifacts/`, not in the documentation tree.
