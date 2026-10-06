# Decision review: Tree-sitter versus Shiki

## Inherited decisions
- Research and technology selection only; no implementation, dependency changes, or new cache policy.
- Priorities: richer syntax across languages, efficient growing source, measured resources, and practical Node deployment—not resemblance to OpenCode.
- Growing Bash command source matters. Arbitrary command output is not automatically Bash.
- Preserve exact source, native lifecycle/data contracts, and existing rendered-cache ownership.

## Diagnosis

**The proposed selection of Shiki with Oniguruma is defensible. No blocking issue remains in the final research synthesis.**

I freshly inspected the final harness, coverage report, proposed report, and recorded data. Independently checked:
- 48 final measurement records on Node 22.19.0;
- matching source hashes across timing configurations;
- recorded full/incremental equality and zero-work unchanged-source controls;
- nine-sample role equality between the two runtimes within each family;
- final memory records and diagnostic Python/Rust output.

These checks validate the recorded evidence and interpretation; I did not rerun benchmarks.

## Three material findings / limits

### 1. Neither technology guarantees richer ordinary-name classification

`check-shiki-onig.json` confirms Python `result` and `fallback` have only general source scopes; the current theme also leaves the expression’s other ordinary names plain. Conversely, `check-tree-wasm.json` and the distributed Rust highlights query leave ordinary Rust receiver/argument names plain where Shiki emits variable scopes.

The final report correctly acknowledges both limitations. **Shiki’s Python gap remains a real tradeoff, not an approved deviation or a problem already solved by theme changes.** Tree-sitter’s structural parser does not automatically supply comprehensive highlighting queries.

Full/incremental equality proves consistency with each adapter’s full output, not independent grammatical correctness.

### 2. Performance supports the proposed weighting—not a universal winner

Final recorded medians:

| Workload | Tree-sitter WASM | Shiki Oniguruma |
|---|---:|---:|
| Complete real TypeScript snapshot | **14.61 ms** | 68.32 ms |
| Growing Bash, 32 updates | 18.99 ms | **11.93 ms** |
| Growing TS function, 32 updates | 81.76 ms | **24.84 ms** |

These are meaningful same-input comparisons. However:
- Tree’s range adapter deliberately invalidates the enclosing top-level construct (`engine.mjs:100–114`).
- Shiki’s middle-edit adapter retokenizes the suffix without convergence detection (`engine.mjs:67–72`).
- Tree’s adapter lacks locals/injections and uses a research overlap policy.
- Both recreate complete ANSI output on each measured update.

The report appropriately limits its claims to these adapters. It must retain Tree’s substantial full-source advantage. The earlier Bash no-op edit and repeated getter costs are corrected in v2.

### 3. Memory evidence supports process-footprint claims, not retained-engine prices

The refreshed stress-process RSS deltas—approximately **365 MiB Tree WASM versus 150 MiB Oniguruma**—are correctly labeled history-dependent process footprints.

Phase profiles establish substantial Tree capture/projection allocations before ANSI validation. They do not establish an inherent parser leak. Conversely, Shiki’s live JS heap is not uniformly smaller: before large workloads, twenty active sessions add approximately **53 MiB above warm heap for Oniguruma versus 26 MiB for Tree WASM**. These figures still exclude relevant native/WASM memory.

The final report avoids conflating RSS, live heap, and linear memory. Preserve that distinction in the user-facing answer.

## Drift / contradiction check

Revising the historical Tree-sitter recommendation is justified by new equal-input evidence and the previously underweighted integration burden. Revising “incrementality is unimportant” is also required by the user’s growing-source requirement.

Do not turn this revision into either “WASM is always efficient” or “Shiki resolves sparse highlighting everywhere.” Neither follows.

## Recommendation

**Select Shiki as the preferred technology, with Oniguruma as the preferred default engine.**

Its integrated language dependencies/embeddings, documented 242 canonical IDs, favorable measured append behavior, and lower measured stress-process footprint justify that choice. Oniguruma’s advantage on actual TypeScript and growing Bash/function inputs supports preferring it over Shiki’s JS engine.

This is a weighted recommendation, not implementation acceptance. Explicitly retain the Python limitation and Tree WASM’s full-source/local-edit strengths. Do not invent a grammar workaround or hypothetical native binding to make either candidate win.

## Risks

Coverage counts do not certify every language’s quality. Production theme mapping, state ownership, large-input responsiveness, hostile inputs, actual CLI/replay, and physical terminal behavior remain unverified. The single benign long-line control is not a cancellation or worst-case guarantee.

## Need from main agent

None to finalize the research recommendation. Language-specific quality obligations must be settled before implementation acceptance.

## Suggested execution prompt

No implementation handoff is warranted or authorized.