# Architecture

Pi Toolview changes interactive terminal presentation, not tool execution or conversation data. Pi loads `src/index.ts` directly as a TypeScript extension. Runtime host libraries are wildcard peer dependencies; development copies are pinned to Pi/pi-tui 1.0.0. They are not bundled or privately imported.

For user-facing behavior and controls, start with the [README](../README.md). Exact presentation rules belong to the six linked specifications below; this document describes their common implementation boundaries.

## Modules and dependencies

| Module | Responsibility |
| --- | --- |
| `src/index.ts` | The sole live-host adapter, presentation selection, compact summaries, transcript separation, normalized tool clicks, invalidation, animation and extension lifecycle |
| `src/summary-args.ts` | Pure bounded argument previews, edit/write path-only formatting, field priority, Unicode/control handling and display-only secret masking |
| `src/bash-card.ts` | Bash command/comments, bounded collapsed output preview, available expanded output and metadata-derived footer |
| `src/file-card.ts` | Shared edit/write saved-source validation/classification, highlighting, context projection, numbered plain/unified/split content and validation-only measurement |
| `src/user-card.ts` | Reframing native Markdown output and terminal navigation zones without reparsing user text |
| `src/card-frame.ts` | Pure geometry, caller-supplied frame paint and panel hit bounds |
| `src/card-theme.ts` | Active-theme tool-panel paint |
| `src/render-cache.ts` | Bounded rendered-data accounting and least-recently-used retention, independent of components |

The adapter passes presentation data and active-theme callbacks to the presenters. Presenters share the frame; the frame does not know about tool names, execution, expansion or private host classes. Only the adapter owns component hooks and weak per-component state. There is no second extension, dynamic presenter registry, external common package or duplicate input adapter.

## Host integration and lifecycle

1. On `session_start` in TUI mode, a temporary empty public widget factory supplies Pi's stable TUI reference. The widget is removed immediately and contributes no rows.
2. The adapter validates the shared host `Container` and the inspected tool/user component contracts, then visits the existing tree. Observing `Container.addChild` also covers future calls and prebuilt history subtrees.
3. Tool prototypes receive rendering and normalized mouse wrappers. Native `updateArgs`, `updateResult`, `setExpanded`, `invalidate` and the UI notification `markExecutionStarted` continue to execute; wrappers manage custom layout/animation state. Ordinary user-message prototypes receive rendering and `rebuild`/`setOutputPad`/`invalidate` wrappers.
4. Off, failure and shutdown stop animation, release both caches and restore owned descriptors. Restoration checks that Toolview still owns each hook and does not overwrite a later extension's replacement. On re-enablement, existing and future components are covered again. Reload creates a fresh runtime.

This integration deliberately depends on inspected private component shapes, while obtaining host classes/functions through public imports. It does not import an internal component class from a second package location. Incompatible contracts or rendering exceptions disable Toolview with a warning and restore native rendering.

The stable TUI reference survives native fullscreen/regular renderer replacement. Public method/child access is sufficient; no receiver-capture probe, raw input observer, private `handleViewportInput` wrapper or input-hook migration is used. Pi retains focus, selection and terminal mouse processing. Toolview handles only normalized tool clicks; user cards add no mouse handler. Regular mode uses terminal-owned mouse handling, so expansion there uses native keyboard controls.

Persistent prototype wrappers are constructed in prototype-only factory scopes, not in an installer scope containing a component parameter. Otherwise a shared V8 closure context can retain the first installer even when all explicit component maps are weak. Ownership tests must collect the first installer while the adapter remains active, including an executing installer while another call keeps the clock running.

## Presentation selection

Selection is based on the current lifecycle and safeguards, not output size:

| Presentation | Default routing |
| --- | --- |
| Compact summary | Collapsed text-only tools other than native-card defaults; also incomplete/partial/failed `edit`/`write` calls |
| Bash frame | Exact `bash` with displayable command/context, collapsed or expanded |
| Edit diff frame | Final successful exact `edit` with a path and supported persisted diff metadata |
| Edit inline title/native fallback | Successful `edit` without diff metadata / with malformed or unsupported metadata |
| Write frame | Final successful exact `write`: saved changes or submitted source, classified by available metadata; malformed metadata stays native |
| Native tool presentation | `powershell`, ordinary expanded calls, images, intentional hiding and explicit native opt-outs |
| User frame | Compatible ordinary native user messages, using the original Markdown renderer |

Exact-name `--toolview-card` adds native-card policy; naming `bash`, `edit` or `write` opts out of its custom presentation. `--toolview-compact` wins over that policy, but not over expansion, images or native hiding. The file-success condition is shared by render, spacing, mouse and animation teardown: partial errors are still running summaries, final errors are wholly error-colored summaries, and only final non-errors can enter the file presenter.

### Native visibility

A self-shell renderer can intentionally return zero rows even with `hideComponent=false`. Unknown, custom, mixed or replaced renderers therefore retain original rendering at the actual viewport width when visibility must be established. Tool names or schemas alone cannot prove visibility.

One narrow Pi 1.0.0 exception avoids discarded native edit rows. Every visit verifies the `ToolExecutionComponent` contract, the exact stock call/result function pair obtained from public `createEditToolDefinition`, and a current plain call `Box` with stock `render`, `clear` and `addChild` methods. Pi's stock factory can reuse an earlier custom Box, so function identity alone is insufficient. No visibility proof is cached and no native state is changed. Explicit native presentation, expansion, images/hidden guards and malformed fallback still render natively.

## Data and rendering boundaries

- Compact summaries format supplied arguments independently of third-party schemas. The exact `edit`/`write` path-only rule, field priorities, bounded grapheme/container previews, top-level secret masking and control sanitization are display-only; there is no generic payload suppression. Native expansion and saved/model data are not abbreviated or redacted.
- Bash consumes already-returned text and persisted status metadata. It never infers process status from text, reads output files or reconstructs upstream truncation. Its one approved semantic display exception removes an exact separated duplicate of its own metadata-derived final footer.
- Edit consumes persisted `details.patch`/`details.diff`, never input proposals or a file reread. It highlights old/new supplied source independently with Pi's public file-language resolver and highlighter before projecting context. It preserves multiline token state and hunk boundaries. OpenCode supplies the format reference, not an identical syntax engine or screenshot guarantee.
- Write uses compatible saved diff shapes without producer identification; additions-only become plain Created source, additions/context use Edited diff, any removals use Replaced diff, absent/no-change diff uses Wrote submitted content. Created includes existing empty files. Explicit truncation shows submitted content with a warning, not guessed complete changes or final post-format bytes. See the [write contract](write-card-spec.md).
- User cards call the original renderer at the frame's content width plus twice the native horizontal padding, remove only known geometric padding, and relocate OSC 133 zones. Markdown transformations, token styles, links and source text are retained. Native image-protocol rows and impossible tiny-width glyphs fall back at the real width.
- The frame owns geometry and restores enclosing panel paint after child ANSI background/full resets. It never truncates a caller's body or paints exterior margins.

Toolview does not replace tool definitions or execution, rewrite results/session entries, add model requests, change global themes, read files to prepare its views or style HTML exports/standalone user shell messages. Native host updates and edit preflight still execute unchanged; their work must not be attributed to Toolview file reads or suppressed to improve counters.

## Cache, separation and animation

Two independent instances of the same rendered-data LRU isolate **8 MiB ordinary views** from **128 MiB Bash/edit-diff/write frames**, each capped at 2048 entries. A weak component state points to one latest layout/signature/pool, never a width history. The recency lists contain rendered values/accounting, not owners, raw args/results or builder closures. User layouts always use the ordinary pool. Pool selection follows the materialized view, not the tool name.

Body retention excludes outside transcript separators. The adapter records parent/index edges, repairs stale positions lazily, and finds the previous visible sibling. It uses existing row counts or cheap classification: Bash does not format output for spacing; file-card measurement reads an exact retained layout or validates metadata without highlighting/painting/admitting another body. Native/unknown predecessors may still need rendering. Separator and executing-spinner composition can allocate row arrays; unchanged completed summaries without a separator return retained arrays directly.

The sole Toolview timer is an unreferenced 100 ms clock for attached, painted compact calls during actual execution. It tracks weak running-node references and attachment edges, not the whole transcript. Ticks replace only the leading glyph and request a frame without invalidating cached content. Argument streaming does not start it; final results, expansion, disappearance, off and restoration stop participation, and the last participant stops the timer. There is no idle cache-maintenance polling or host-frame throttling.

Cold layouts and actual width/theme changes prepare full required content by design. Warm cache hits avoid custom formatting/highlighting/wrapping, not all host work: Pi still traverses and assembles its transcript, unknown self renderers retain visibility checks, and native update/preflight/selection work remains. Finite byte/entry budgets can still cause eviction or oversized-entry rebuilds. Cache estimates bound retained custom data, not transient allocations, native caches or whole-process heap; no total-memory or O(1)-frame claim is made.

## Contracts and development

- [Tool summaries](tool-summary-spec.md): argument formatting, status, wrapping and compact input.
- [Bash cards](bash-card-spec.md): command/output/footer semantics and expansion.
- [Edit cards](edit-card-spec.md): metadata, syntax, diff format and lifecycle.
- [Write cards](write-card-spec.md): source classification, completeness and plain/diff fallback.
- [Shared frame](card-frame-spec.md): geometry, paint, user messages and click bounds.
- [Render cache](render-cache-spec.md): invalidation, ownership, pool controls and measurable work.
- [Testing](testing.md): reproducible checks, actual CLI/SDK controls and explicit coverage limits.

The supported/tested host is Pi 1.0.0, not an unconditional promise for future versions or arbitrary extensions replacing the same private hooks. Tests and the offline driver are development-only. Generated captures, measurements and review reports belong in gitignored `.test-artifacts/`, not in the maintained documentation.
