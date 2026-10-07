# Session footer

## Scope and ownership

Toolview installs one noninteractive footer component through public `ctx.ui.setFooter`. It replaces the stock cwd/branch row, usage/model row and separate extension-status row, not the editor or native activity indicator. Cwd/branch and model/provider/thinking are omitted here because the eligible stock input displays them. Footer installation therefore requires Toolview's recognized, still-owned stock editor. A foreign public factory (including one returning the exact stock class), subclass or overridden native presentation keeps the footer native too. Editor padding, autocomplete and temporary native selectors do not disable this input-ownership eligibility. Working/retry/compaction/future activity remains entirely Pi-owned in its native location.

There is one footer slot, not a stack of independent extension footers. The last public `setFooter` call wins. Pi calls our component's `dispose` when replacing it; that releases snapshots and records lost ownership. Off/shutdown restore stock only while Toolview still owns the slot, never erase a later foreign owner, and do not reconstruct an earlier foreign footer. A later loss of editor ownership suppresses our rows immediately; one coalesced microtask restores stock through the public API after normal measurement, only if we still own the footer and the editor remains ineligible. No render-time container mutation, polling or extra editor render is used. Explicit `/toolview on` may reclaim the slot only with an eligible editor; after returning from a foreign editor use that command or reload to reinstall it, not automatic takeover of a possibly foreign footer. For native startup/reload with a temporarily mounted selector, initial installation waits for the stock editor. A weak snapshot of the guarded public footer slot and its single previous component permits that one delayed install only while the same owner remains; a later replacement cancels it. This does not enable general automatic reclaim. Reload creates a fresh enabled runtime. Footer installation does not intercept another extension's `setStatus` or `setFooter` calls. Print/JSON/RPC modes remain inactive.

## Statistics and sources

The ordinary one-line order is:

```text
↑11M ↓1.5M 105k/272k (38.4%) (auto) R243M W12 CH98.2% $61.761 (sub)          mc: 104.5K (51%) · idle
```

The values illustrate independent fields, not one arithmetically consistent traffic trace. Both initial arrow counters remain visible as `↑0 ↓0`. Other fields follow stock visibility:

- Aggregate all raw `ctx.sessionManager.getEntries()` records, not the current branch or compaction projection. Include assistant and usage-bearing tool messages, standalone usage entries, compaction and branch-summary usage, including abandoned history. Do not sum cumulative partial streaming updates or rewrite saved data.
- R/W appear only for nonzero cumulative cache-read/write tokens. CH follows stock visibility: cumulative R/W must be positive and the last raw assistant record must have a positive prompt denominator. Compute `cacheRead / (input + cacheRead + cacheWrite) * 100` for that assistant record, not a cumulative ratio or probability of a request hit. A later cold request can validly show CH0; absent denominator omits CH rather than inventing zero. Side/tool/summary usage contributes to totals but does not replace the latest assistant CH.
- Cost uses three decimals and native visibility (nonzero total or subscription marker). `(sub)` follows the current provider's subscription-backed OAuth declaration/auth selection, including stock Pi's `kimi-coding` exception. It describes current authentication, not a subscription bill or proof that all historical usage used that authentication. Public registry/provider information supplies it; OAuth alone is insufficient.
- Take used count, maximum and percent together from `ctx.getContextUsage()`, including Pi's applicable routed limit/estimate. Do not reconstruct used tokens from a rounded percentage. Unknown used count is `?/272k`, without a percent. Undefined context usage omits the context block. Real estimates above 100% are not clamped.
- `(auto)` appears with available context only when `pi.getSettings().compaction?.enabled` is true (native default true).

Cumulative counters keep stock Pi compact formatting: integers below 1k, one decimal from 1k to below 10k, integer k up to 1M, one decimal M up to 10M and integer M thereafter. Context used/maximum have a distinct format: rounded integer k below 1000k; `X.XXM` from 1000k to below 10000k; `XX.XM` to below 100000k; integer M thereafter, retaining additional integer digits for larger values. Keep trailing decimal zeros. Normalize rounding carries before choosing a range: 999.5k becomes 1.00M, 9.996M becomes 10.0M, 99.96M becomes 100M. Examples: 104500 -> 105k, 1500000 -> 1.50M, 12000000 -> 12.0M, 1234000000 -> 1234M. Rounding affects presentation only; small known counts can round to 0k and remain distinct from unknown `?`.

## Colors

Use the current Pi theme. Unspecified numeric/annotation text is `muted`.

| Piece | Foreground |
| --- | --- |
| Arrow glyphs ↑/↓, R/W letters, $ glyph | `text` |
| Current used-context count, or unknown ? | `text` |
| `/`, `(`, `)` | `dim` |
| Cumulative counter numbers, context maximum, auto/sub text, cost digits | `muted` |
| Context percentage digits and % | Stock raw-percent rules: `error` above 90%, `warning` above 70%, otherwise `muted`; one decimal |
| Complete CH token | `success` at displayed rate >=95.0%, `error` below 80.0%, otherwise `warning` |
| Between-extension ` • ` | `dim` |

Round CH to its displayed one decimal before classification: 79.96 shows warning CH80.0%, 94.96 shows success CH95.0%. Context percentage deliberately retains stock raw-value thresholds instead. Producer colors/attributes inside statuses are not replaced with footer colors.

## Status fitting and overflow

Read one snapshot of public `footerData.getExtensionStatuses()` per render. One map entry is one opaque producer status, not necessarily one installed package. Sort stably by key using stock locale comparison; do not reorder for best fit, parse internal bullets or interpret extension-specific metrics. Normalize CR/LF/tab and repeated spaces and trim as the stock footer does. Skip zero-visible-width/empty entries. Close SGR/hyperlink state at each boundary so an unclosed producer style cannot leak into padding, our dim separator or the next status; preserve styling of its own visible glyphs.

When everything fits, statistics are left-aligned and statuses right-aligned on one row, with at least two blank columns between them. Join multiple statuses on that row by ` • `. If the next complete status cannot fit the remaining space, move it intact to a following full-width, right-aligned row; no leading/trailing separator is left at a break. If a status exceeds even an empty full-width row, truncate its tail with visible `…`, ANSI/column/grapheme-aware. Information loss in this case is explicitly accepted. Never internally wrap a status, truncate just to fill leftover space or emit an overwide row.

If left statistics themselves overflow, wrap between complete metric units in the stated order. Context used/max stays a unit; its parenthesized percent/auto are separate units; cost/sub stay together where feasible. A single metric wider than the entire terminal uses ANSI-aware hard wrapping rather than silently losing numeric data. Status packing begins beside the final statistical row, then continues below it. Width zero returns no rows; tiny widths still cannot exceed the available columns.

Additional rows consume transcript height and are subject to ordinary Pi fullscreen footer clipping (`minSize: 0`). Native separate-status containers also have `minSize: 0`: with four rows, the one-row transcript minimum plus three-row editor minimum can leave both status and footer invisible. Their objects/rendered content remain active, and normal height recovery reveals them again; do not promise physical activity visibility at every height. No allocated-height heuristics, private layout hooks, overlay or alternate notification mechanism is added. This is one base line, not a fixed height under every width/height constraint.

## Freshness and work

`src/footer.ts` aggregates supplied records and prepares themed rows; `src/index.ts` is the only live adapter. It caches a plain numeric/context snapshot by session ID, leaf, current model identity and semantic event generation. Session start/tree/compaction, model selection, completed messages/turns/tools/agent operations refresh that generation; leaf changes catch intervening appends. Get current auto/auth flags normally. Arbitrary unannounced mutation of existing persisted entries is not supported.

Retain one latest width/theme/data/status layout per component, outside both transcript LRU pools. Theme/width/status changes rebuild presentation without rescanning session history or rereading context. Ordinary warm and native Working frames must perform zero new usage aggregations, entry visits, history reads or context calculations. Final saved usage changes rebuild from native records. No timer, new Git source, model request or execution interception exists here. Stock footer already avoids hot history scans; this design preserves that property, not a claim of inherently lower CPU or constant-cost whole Pi frames.

## Verification

See [testing](testing.md). Require first-red SDK controls; actual native cumulative accounting parity (including side/tool/summary/abandoned usage); context/CH precision and threshold controls; dark/light glyph cells, producer attribute/link isolation; exact-fit/overflow and Unicode/tiny widths; whole-status transfer/truncation without dangling separators; live settings/status lifecycle; public off/on/later-owner/reload and initial/late foreign-editor disablement, exact-stock foreign factories, overridden stock guards, eligible on recovery, temporary-selector continuity and reload-box initial delay with unchanged-footer-owner protection; active first-footer collection; real regular/fullscreen CLI/native traffic/replay and observable warm/Working counters. Isolated supplied offline usage/status strings do not claim live provider billing or installed Magic Context/Powerline integration.
