# Render cache and UI performance

Status: accepted performance refinement. Execution, model content, session data, native hidden/image guards and normalized input remain unchanged. This supplements the summary, Bash and shared-frame specifications.

## Work per frame

Pi requests whole-document layout for arbitrary UI updates, including its working animation. Toolview must not rebuild unchanged custom content in those frames. Cache custom summary/Bash body rows and Bash geometry/expandability separately from transcript separation. Neighbor separation uses cached content metadata; an eligible Bash card's existence/multiline classification never requires formatting its output. Record child positions on attachment/initial traversal, with an O(1) position check and lazy repair after structural changes, instead of a fresh sibling index search per rendered call.

Each component retains at most its latest custom layout width/state. Width changes rebuild that layout once, not on every frame. Preserve safe actual-width bounds and click coordinates rather than returning old wider rows. No width-history cache, cache-maintenance polling, debounce or suppression of host frames/streaming. The sole bounded, execution-only animation clock is specified below. Native self-render visibility continues to be checked at the actual width; native child render caches remain the authority and are not bypassed to infer visibility.

## Execution spinner

Use one adapter-owned 100 ms interval (at most ten animation render requests per second, independent of the number of running tools), created only when an attached, visible compact call is rendered after actual execution has started. Argument streaming, completed/history calls, zero-width or native-zero-row calls, expanded/native/image tools, and default Bash cards start no clock. There is no idle/background housekeeping interval. The timer is unreferenced so it cannot keep the process alive.

Keep only weak references to the small set of running painted calls. Tick checks inspect that set and its recorded ancestor attachment edges, not the full transcript. Hidden/ineligible or detached calls are removed on render/tick; final results and expansion remove them immediately through native UI-update wrappers. Stop and clear the interval when the last call leaves the set. Off, failure, shutdown and reload also stop it and clear animation state. Renderer replacement is recognized using the stable reference's public children, without receiver probing or private input hooks.

Compose the current first-row glyph outside the retained logical layout. Cached rows keep fixed prefix-offset metadata only, never a frame, node, timer or callback. Advancing a frame calls ordinary `requestRender()` once, without globally invalidating native/custom content. With retained layouts, ticks rebuild no argument formatting, wrapping or neighbor metadata. Cache zero/admission-skip limitations remain unchanged. Starting execution changes only the leading glyph and does not itself discard the cached logical summary; the native `markExecutionStarted()` UI method still executes unchanged. Partial updates retain the clock; final failures retain normal error color after animation ends.

Verify one shared interval for parallel execution, exact tick/render/build counts, no idle redraws, immediate result/expansion/restore stops, hidden/image/native/zero-width guards, detached subtrees and stable-reference renderer replacement. Actual SDK/CLI controls must prove moving physical screen glyphs, cached work, native partial/full information, cancellation/off/on/reload, raw traffic/session identity and collection of the first installer under an active animation adapter.

## Invalidation and ownership

Use weak component keys for state; the bounded recency list may retain only rendered data/accounting, never a component, parent tree, argument/result object or closure capturing those objects. Invalidate custom layout when Pi updates args/results, sets expansion or invalidates the component; mutation inside a reused argument/result object is supported through those existing host methods. Retain native method execution and restore only Toolview-owned wrappers on off/failure/shutdown/reload. State/width/theme-identity guards also cover direct field replacement, status/expansion changes, and Bash command/description/workdir/context changes. Arbitrary silent mutation of nested JSON without a host update/invalidate is outside the renderer contract.

The cache is runtime-local. Clearing replaces its weak state map and empties recency/accounting; off/failure/shutdown do the same. There are no finalizers, GC polling, subscriptions or retained old roots. Collected component keys cannot be kept alive by the recency list. Orphan rendered values may occupy the bounded LRU until ordinary eviction or explicit clear; this is deliberate bounded cache retention, not unbounded node/session retention.

## Memory bounds and controls

Default retained-layout budget: **8 MiB**, maximum **2048 entries**, one latest custom body per component. Estimated bytes charge fixed entry/row overhead plus two bytes per retained string code unit (including ANSI), conservatively also allowing for row-array references. These are extension cache accounting estimates, not exact V8 heap allocation. Do not retain duplicate raw output, original args/results or a multi-width history in the cache. Evict least-recently-used data on admission or limit reduction; an entry larger than the entire budget is not retained. Entry eviction clears its rendered value even if a live weak-key state still points at its accounting record. Limit zero disables retention; no promise of cache-hit performance in that explicit mode. No unbounded counter logs or per-frame memory sampling.

Optional commands, with no persistent settings writes:

- `/toolview cache`: show retained estimated bytes, budget, entries, hits/misses/builds/evictions/admission skips, and current process heap usage explicitly labeled **whole Pi process**, not Toolview attribution. This snapshot samples process memory only on demand.
- `/toolview cache clear`: release cache data and state; subsequent frames rebuild on demand.
- `/toolview cache limit <MiB>`: set runtime budget in the inclusive range 0–64 MiB; lowering the limit evicts immediately. No runtime restart or host settings modification.
- `--toolview-cache-mb <MiB>`: optional initial limit in the same range; default 8. Invalid values are rejected/warned, not silently converted to an unbounded budget.

Keep `/toolview on|off|status`, policy flags and non-TUI behavior. Memory control does not cap model/tool data or claim to free host-owned/native rendering memory. Cache clear does not itself recursively invalidate native tool contents.

## Output preview

Collapsed Bash wrapping stops as soon as an eleventh visual output row proves overflow; it does not build all hidden visual rows. Use the first ten rows, then remove their trailing whitespace-only rows before the overflow hint without searching hidden rows for replacements. Preserve interior preview blanks and all expanded interior blanks, grapheme/tab/control safety and the expansion hint. The Bash spec's exact separated terminal duplicate exit-footer removal precedes wrapping/overflow and does not infer status or rewrite raw data. Expanded output is built only on demand and cached subject to the same budget. Oversized uncached layouts and changing large results can still require transient work/memory; the budget bounds retained extension cache, not total Pi heap or pathological raw tool data. Favor bounded preview work over exact hidden row counts: do not compute or display such a count.

## Verification

Test-first counters must prove unchanged frames do no custom body builds, updating one tool rebuilds only that tool (including reused mutable objects), cached neighbor checks do not rebuild earlier Bash output, and resize/theme/expansion/invalidate cause only necessary work. Test budget/entry limits, eviction clearing values, zero/admission skips, limit reduction/clear, weak ownership structure, restore/later owners, shutdown/reload and native renderer-mode replacement. Use actual SDK and real CLI captured traffic, native/off/replay controls and physical width/click/color checks; never replace strict body/model/session equality with approximate performance assertions. Optional diagnostic snapshots must have finite monotonic counters and accurately labeled estimated cache versus whole-process memory. Record observable work counts, not timing-only claims. Independent fresh-file review and compiler/full regression gates are required; no commits without user authorization.
