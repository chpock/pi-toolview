# Shared card frame specification

Status: accepted for the bash card. Other tool cards, native expanded results and user-message cards are future integrations, not changed by this task.

## Scope and architecture

One Toolview adapter owns live-host hooks, runtime lifecycle and mouse routing. The shared frame is a pure layout/painting module independent of tools, commands, results, expansion and host component classes. Callers supply already styled content rendered for its reported content width and painting callbacks. A bash presenter supplies its own content and expandability; future presenters can reuse the same frame without another extension or another set of hooks. There is no plugin registry, new tool execution, session format, global theme modification or external shared package.

## Reference and geometry

Source reference: OpenCode `907b3bc518fa48e90e8ec24dd327d13eee71c36c`, `packages/tui/src/routes/session/index.tsx`: transcript horizontal padding at 1178 and `BlockTool` at 1994–2044; `packages/tui/src/ui/border.ts` supplies `┃`. This is inspected source, not a claimed screenshot comparison. The user's later refinement deliberately reduces exterior and interior horizontal spacing to one column per side; it is not a claim of literal OpenCode spacing.

For a component width W >= 6:

- Leave one exterior column on each side, outside panel painting and click targets.
- The panel occupies W - 2 columns. Only its left border exists: a one-cell `┃`, including on its top/bottom padding rows. No top/right/bottom border is drawn.
- Inside the panel leave one column after the left border and one column on the right. Content starts at column 3, counting from zero in the component, and has width W - 5. Both internal columns belong to the painted, clickable panel; neither belongs to the content width.
- Add one panel padding row above and below the content. Paint the panel body, including internal padding, top/bottom content rows and the space after short content. The stripe cell and exterior columns keep terminal-default background. The stripe remains part of the logical panel/click bounds despite its separate paint.
- Transcript separation is owned by the adapter: one outside empty row when a visible preceding sibling exists; no duplicated separator, and no separator at width zero.
- Comments, command, output, hint and footer share the content origin. Do not copy OpenCode's additional title indentation, spinner, command/output truncation or content policy.

At width zero return no rows. At widths 1–5 keep at least one content column: allocate the remaining columns first to the border (up to one), then balanced internal padding (up to one per side, extra odd column on the left), then balanced exterior margins (up to one per side, extra odd column on the right). Never truncate commands to preserve decoration. Recompute geometry for every width. Callers wrap body text at the resulting content width; framing itself does not rewrap or silently clip body rows.

## Paint

Bash uses the active Pi theme at render time:

- Panel body (everything after the stripe): `toolPendingBg` for every execution state, including errors.
- Stripe background: terminal default for both ordinary and error states, not the panel color or a theme background token. Begin each frame row with an SGR background reset (`49`) so inherited background cannot leak into the stripe; render the stripe outside the body-background callback. Only its foreground changes on error.
- Ordinary border: `borderMuted` foreground.
- Final failed call (explicit user refinement): use `theme.fg("error", ...)` for the border foreground, exactly the same semantic role as the completion footer; do not use a background token as a foreground. Failure means final `isError=true` or a known nonzero persisted exit code, matching the bash footer. Partial snapshots do not signal final failure.
- No hover highlighting or hover state. Pointer motion, focus changes and moving between cards do not alter panel paint or request Toolview redraws. This is an intentional deviation from the OpenCode reference, accepted after unstable hover behavior.

The frame receives paint callbacks instead of selecting theme roles or inspecting execution state. The border callback styles only the stripe foreground; the panel callback receives only body/internal padding, never the stripe. The frame owns the leading terminal-default background reset. A future user-message presenter can supply different paint without changing the geometry implementation. Real Pi 1.0.0 verification must check that the failed stripe foreground equals the displayed error footer, ordinary border stays `borderMuted`, stripe background is default and panel body remains neutral.

## Pointer behavior and lifecycle

An expandable card means hidden output exists, or expanded available output can be collapsed. All panel cells, including its border, internal padding, command/comments, footer and top/bottom padding rows, are click targets for that card. Exterior margins and the outside transcript separator are not. Empty/nonexpandable cards are not interactive. Neither expandable nor nonexpandable cards have hover paint.

Toggle only on a normalized primary-button click and only when Pi has no active text selection. Leave press, drag, release, wheel and secondary-button handling to the host; do not capture input. Ctrl+O and regular-mode keyboard behavior remain native. The host generates clicks separately from selection drags.

Toolview does not observe raw terminal input, add input listeners, replace `handleViewportInput`, capture the actual renderer receiver with a probe, or keep pointer state. Native input processing and mouse/focus consumption are entirely Pi's responsibility. The sole adapter patches tool `render`/`handleMouse` and `Container.addChild`, plus UI component `updateArgs`/`updateResult`/`setExpanded`/`invalidate` solely to invalidate cached custom layout while retaining native behavior. Tool execution is not intercepted. See the [bounded render-cache contract](render-cache-spec.md). Mouse events already normalized by Pi reach the card's click handler; non-click events return without modifying the card or requesting render.

Widget factories expose Pi's stable TUI reference. Public method/child access through this reference is sufficient; no instance descriptor writes or private input-method compatibility checks are needed. Pi may replace its renderer through native TUI-mode settings while retaining transcript components and the stable reference. Existing prototype rendering/click hooks and normal child attachment tracking continue to work without receiver migration or input-hook rebinding. Off, failure, reload and shutdown restore only Toolview's owned tool/container hooks, respecting later owners. There is no hover-specific cleanup path.

## Acceptance gate

Test-first frame geometry and integration regressions must independently verify exact exterior margins, panel bounds, content origins, wide/narrow wrapping, unpainted margins, neutral panel body in all states, terminal-default stripe background in ordinary/error states including inherited-background and tiny-width cases, failed stripe/error-footer foreground equality, steady neutral paint under motion/transfer/focus, no Toolview motion redraws or native input-method changes, whole-panel clicks, nonexpandable/selection/drag/wheel guards, resize, native fullscreen/regular renderer replacement and cleanup. Reconstruct complete long commands from actual screen cells at multiple terminal widths in fullscreen and regular mode, preserving every character and checking both internal/exterior right-side columns; manually calling a component at the viewport width is not sufficient evidence of physical-screen width. Existing summaries, native opt-out/compact override, hidden/image safeguards and strict model/result/session equality stay unchanged. Run strict TypeScript, full units, fresh real-Pi CLI execution/replay with actual ANSI cell and mouse checks, packaging and independent fresh-file review. Installed AFT execution remains outside the safe test profile; representative metadata tests are not claimed as installed-AFT coverage.
