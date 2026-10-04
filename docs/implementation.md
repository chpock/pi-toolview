# Initial implementation contract

## Goal and boundary

Pi Toolview changes how tool calls appear, not how tools execute. Most calls are compact summaries without card backgrounds. Neighboring single-row summaries have no blank rows between them; multiline summaries are separated from following tools. Ordinary text and cards remain separated. Rich output normally stays in Pi's original cards and renderers; bash has a separately specified terminal-style card.

This is an extension, not a Pi fork. Do not modify the installed host, override tool implementations, transform model-facing arguments/results, or change session serialization. Do not enable the extension in user settings or commit changes without permission.

## Rendering policy

- Collapsed text-only tools are compact by default, including third-party tools.
- `bash` follows the accepted [bash card specification](bash-card-spec.md); `powershell`, `write`, and `edit` retain their native rendering. This is a semantic choice, not an output-size threshold.
- Results containing images and components intentionally hidden by their renderer retain native behavior.
- Expanded ordinary tools delegate to their original renderer; bash retains its specified card unless explicitly opted out; Ctrl+O remains Pi's own shortcut. Fullscreen primary clicks expand completed compact calls. Stock mouse handling collapses expanded cards.
- Summaries show the exact tool name, useful arguments, and a visible pending/success/error marker. Failed calls also include a short error description when it fits. No full result is shown until expansion.
- The accepted [tool summary specification](tool-summary-spec.md) is normative for argument selection, ordering, values, masking, semantic colors, wrapping, indentation and adaptive separators. It supersedes the initial tool-specific heuristic and one-row truncation.
- Descriptions cannot inject terminal controls or arbitrary newlines. Renderer-controlled wrapping respects terminal column width, including wide graphemes. Continuations align with the tool name; completed calls expand from any content row, not separators.
- All compact summaries use the same argument rules without depending on third-party schemas. Status colors and native card/visibility safeguards remain unchanged.

## Controls

`/toolview on`, `/toolview off`, and `/toolview status` control this process only. `/toolview cache [clear|limit <MiB>]` provides on-demand diagnostics/control, with optional `--toolview-cache-mb` initial budget, following the [bounded render-cache contract](render-cache-spec.md). No custom configuration file or persistence is introduced in this initial implementation. CLI flags `--toolview-card <comma-separated-names>` and `--toolview-compact <comma-separated-names>` adjust the exact-name policy for third-party tools. Compact overrides win; image, hidden, and ordinary-tool expansion safeguards still apply. An explicit `--toolview-card bash` opts out of the custom bash card.

## Integration and compatibility

Use a temporary empty widget factory to obtain the live TUI. Validate that the host-supplied `Container` is shared. Observe the existing tree plus future `Container.addChild` attachments. Patch real tool component prototypes' `render` and `handleMouse`; cache invalidation also wraps UI component `updateArgs`, `updateResult`, `setExpanded` and `invalidate` while preserving native behavior. Retain original methods and restore owned hooks on disabling/shutdown/reload. Re-enabling must cover already-present and future tools without stacking hooks.

The adapter intentionally depends on private tool fields. Validate the inspected Pi 1.0.0 component contract before patching. If compatibility cannot be established, warn and retain native behavior. Do not claim support for future hosts or arbitrary other extensions that patch the same methods. Avoid importing private modules or bundling host-provided libraries.

## Verification gates

1. Write regression tests before implementation and observe a failing run.
2. Run strict TypeScript checking and unit/component tests, including mixed layouts, empty assistant components, pending/error results, images, hidden tools, narrow/wide text, clicks, restoration, and unsupported component shapes.
3. Automatically start the real bundled Pi CLI in isolated pseudo-terminals with an offline scripted provider. Execute actual built-in tools and a representative custom tool; do not replace built-in implementations in these scenarios. Separately opt-in deterministic AFT-shaped bash fixtures may cover metadata not exposed by the built-in API, and must not be described as actual AFT execution. Compare native controls, tool events, persisted history, and stock card rendering. Drive actual keyboard and mouse input, reload, disable/re-enable, resize, and theme changes in fullscreen and regular modes.
4. Exercise installed third-party extensions in a separate temporary agent/workspace without model requests or user configuration changes. Report exactly which integrations ran; do not equate an isolated fake custom tool with coverage of the user's full environment.
5. Perform independent fresh-file review against this contract; write findings and resolve real defects before completion. Record remaining compatibility limitations honestly.

## Minimal layout

The initial single-file runtime has been split along presentation boundaries for the accepted [shared card frame](card-frame-spec.md): `src/index.ts` owns the sole live-host adapter, ordinary summaries, normalized card clicks and extension lifecycle; `src/card-frame.ts` owns pure geometry, frame painting and panel hit bounds; `src/card-theme.ts` maps active theme colors to tool-panel paint; `src/bash-card.ts` renders bash content for the frame's allocated width; `src/render-cache.ts` bounds retained rendered-data accounting/recency without retaining components or raw tool state. The sole adapter owns weak cache state/invalidation and cached neighbor metadata. Hover was explicitly removed: no pointer-state module, raw input observer/listener, private `handleViewportInput` wrapper, receiver-capture probe or input-hook migration remains. Widget factories expose a stable reference proxy; public method/child access is enough for rendering, selection guards and lifecycle. Native mouse/focus handling is left to Pi, including after native fullscreen/regular mode replacement. Shared modules are independent of private host classes. Future other-tool, native-expanded and user-message presentations reuse the frame/paint/content boundaries without another extension or duplicate hooks; they are not restyled in this task. No dynamic plugin registry or external common package is introduced. Tests and their offline terminal driver are separate development artifacts. Host imports belong in wildcard peer dependencies; pinned development copies support type checking/tests and are not bundled. No compilation is required to load the TypeScript extension through Pi.
