# Shared card frame specification

Status: accepted for Bash and user-message cards. Other tool cards and native expanded results are unchanged.

## Scope and architecture

One Toolview adapter owns live-host hooks, runtime lifecycle and mouse routing. The shared frame is a pure layout/painting module independent of tools, commands, results, expansion and host component classes. Callers supply already styled content rendered for its reported content width and painting callbacks. Bash and user-message presenters supply their own content and paint; only Bash supplies expandability. Both use the same frame and sole host adapter, without another extension or another set of container/input hooks. There is no plugin registry, new tool execution, session format, global theme modification or external shared package.

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

The frame receives paint callbacks instead of selecting theme roles or inspecting execution state. The border callback styles only the stripe foreground; the panel callback receives only body/internal padding, never the stripe. The frame owns the leading terminal-default background reset. The user-message presenter supplies its own paint without changing the geometry implementation. Real Pi 1.0.0 verification must check that the failed stripe foreground equals the displayed error footer, ordinary border stays `borderMuted`, stripe background is default and panel body remains neutral.

## Pointer behavior and lifecycle

An expandable card means hidden output exists, or expanded available output can be collapsed. All panel cells, including its border, internal padding, command/comments, footer and top/bottom padding rows, are click targets for that card. Exterior margins and the outside transcript separator are not. Empty/nonexpandable cards are not interactive. Neither expandable nor nonexpandable cards have hover paint.

Toggle only on a normalized primary-button click and only when Pi has no active text selection. Leave press, drag, release, wheel and secondary-button handling to the host; do not capture input. Ctrl+O and regular-mode keyboard behavior remain native. The host generates clicks separately from selection drags.

Toolview does not observe raw terminal input, add input listeners, replace `handleViewportInput`, capture the actual renderer receiver with a probe, or keep pointer state. Native input processing and mouse/focus consumption are entirely Pi's responsibility. The sole adapter patches tool `render`/`handleMouse`, user-message `render`, and `Container.addChild`, plus tool UI `updateArgs`/`updateResult`/`setExpanded`/`invalidate` and user UI `rebuild`/`setOutputPad`/`invalidate` solely to invalidate cached custom layout while retaining native behavior. Tool execution is not intercepted. See the [bounded render-cache contract](render-cache-spec.md). Mouse events already normalized by Pi reach the card's click handler; non-click events return without modifying the card or requesting render.

Widget factories expose Pi's stable TUI reference. Public method/child access through this reference is sufficient; no instance descriptor writes or private input-method compatibility checks are needed. Pi may replace its renderer through native TUI-mode settings while retaining transcript components and the stable reference. Existing prototype rendering/click hooks and normal child attachment tracking continue to work without receiver migration or input-hook rebinding. Off, failure, reload and shutdown restore only Toolview's owned tool/user/container hooks, respecting later owners. There is no hover-specific cleanup path.

## User-message cards

Ordinary native `UserMessageComponent` instances use the same geometry and terminal-default stripe/exterior background as Bash. Use `customMessageLabel` for the stripe foreground and `userMessageBg` for the panel. Retain native `userMessageText` and semantic Markdown foregrounds/attributes inside; do not recolor syntax or links uniformly. No Bash command prefix, title, footer, truncation, expansion, spinner or hover behavior applies to user cards. Custom/skill/branch/compaction/assistant messages and separate image attachments remain native.

The sole adapter identifies and validates the current user-component contract, without importing private classes. The native component has one public-host `Markdown` child, numeric horizontal padding and one vertical padding row per edge. Ask its original renderer for content width plus twice its native horizontal padding: native Markdown and its registered transformers then receive exactly the frame's content width. Remove only those known geometric padding rows/columns with ANSI-aware column slicing, not whitespace trimming or source re-parsing. Keep full Markdown output, literal escapes, ordered-list numbering, syntax highlighting, links, Unicode and interior empty rows. Do not mutate the component, its children, text, native padding or Markdown options to render a card.

Move the native OSC 133 start and end/final zones to the new top/bottom padding rows, preserving their order and keeping transcript separators outside them. Empty native output stays empty; width zero paints nothing. Reuse an already supplied native blank separator; otherwise add one outside row after a visible predecessor. Cached predecessor metadata avoids recursive user-card rendering.

Native Kitty/iTerm2 image-protocol rows and native wide glyphs that cannot fit the tiny frame content allocation delegate to the original renderer at the real width, without clipping or disabling other Toolview presentations. This preserves upstream rendering, including upstream tiny-width limitations; actual graphical-terminal display is not an emulated acceptance claim.

User cards add no mouse handler, input interception, clock or stateful pointer paint. Native selection/copy and tool keyboard expansion remain native. Restore user rendering/invalidation descriptors only while still owned by Toolview. Persistent wrappers are created in a prototype-only scope, never the first user's installer scope. Layout strings join the existing bounded cache; no user, parent, Markdown component or callback enters the LRU. See the [cache contract](render-cache-spec.md).

Acceptance requires actual-SDK native Markdown comparison, tiny/zero/empty cases, native padding rebuild/invalidation, weak first-installer collection, compatibility failure/later-owner restoration and exact work counters. Real CLI controls compare full native body text and every painted glyph's foreground/attributes at equal content widths, all frame background/margin/stripe cells in dark/light, actual selection/copied text, Ctrl+O, 24/60/100-column resize, off/on/reload, fullscreen/regular replay, exact user/model/session bytes and unchanged Bash/summary behavior. Protocol fallback is a component guard test, not graphical-terminal coverage.

## Acceptance gate

Test-first frame geometry and integration regressions must independently verify exact exterior margins, panel bounds, content origins, wide/narrow wrapping, unpainted margins, neutral panel body in all states, terminal-default stripe background in ordinary/error states including inherited-background and tiny-width cases, failed stripe/error-footer foreground equality, steady neutral paint under motion/transfer/focus, no Toolview motion redraws or native input-method changes, whole-panel clicks, nonexpandable/selection/drag/wheel guards, resize, native fullscreen/regular renderer replacement and cleanup. Reconstruct complete long commands from actual screen cells at multiple terminal widths in fullscreen and regular mode, preserving every character and checking both internal/exterior right-side columns; manually calling a component at the viewport width is not sufficient evidence of physical-screen width. Existing summaries, native opt-out/compact override, hidden/image safeguards and strict model/result/session equality stay unchanged. Run strict TypeScript, full units, fresh real-Pi CLI execution/replay with actual ANSI cell and mouse checks, packaging and independent fresh-file review. Installed AFT execution remains outside the safe test profile; representative metadata tests are not claimed as installed-AFT coverage.
