# Syntax highlighting research and decision

**Date:** 2026-10-06. **Status:** expanded head-to-head research and fresh advisory review complete. **Implementation:** not started or authorized by this report.

## Recommended decision

**Select Shiki as the shared highlighting technology, with Oniguruma as the preferred engine.** Use structured tokens, not an editor/diff framework. Growing source is a first-class use case, including future Bash command highlighting; arbitrary command output is not automatically Bash source.

The authoritative decision is now [Tree-sitter versus Shiki](tree-sitter-vs-shiki.md), supported by [versioned coverage research](head-to-head-coverage.md), [48 final fresh-process measurement records](probes/head-to-head/results.jsonl), [reproducible probes and controls](probes/head-to-head/) and a [fresh Oracle review](head-to-head-review.md).

### Why the initial recommendation changed

The initial Tree-sitter/WASM preference below was based on OpenCode alignment and a richer Python example, without same-input Tree/Shiki performance or isolated memory evidence. It is superseded, not retroactively treated as measured proof.

The new Node 22.19 study compares both Tree runtimes and both Shiki engines on identical full/growing/middle-edit source, normalized spans and shared ANSI output. Shiki offers integrated 242-ID coverage and embeddings, effective public line-state continuation and lower measured stress-process RSS. Oniguruma beats Shiki JS on the real TypeScript snapshot and growing Bash/function workloads. Tree WASM is clearly faster on complete sources and several local edits; that advantage remains explicit. Both have ordinary-name grammar/query gaps, notably Shiki Python and bundled Tree Rust. No universal quality or memory winner is claimed.

This selects a technology, not an implementation. All production lifecycle, ownership, physical CLI/replay and language-specific quality gates remain open. The older sections below preserve the initial broad investigation and architecture/gate hypotheses; they are not authority for a new parser/cache policy.

## Reports

| Report | Contents |
|---|---|
| [Final head-to-head decision](tree-sitter-vs-shiki.md) | Full/streamed/local-edit timing, phase memory, quality limits and final recommendation |
| [Head-to-head coverage](head-to-head-coverage.md) | 21 pinned grammar/query entries, embeddings and deployment qualifications |
| [Head-to-head advisory review](head-to-head-review.md) | Fresh verification of final data and weighted decision |
| [Current implementation](current-implementation.md) | Actual file-card/SDK pipeline and root causes, with physical foreground controls |
| [OpenCode/OpenTUI](opencode.md) | Pinned implementation, capture/theme/worker model, language/Node/licensing limitations |
| [Shiki/Pierre/Hunk](shiki-pierre-hunk.md) | Actual dependency chain, token APIs, engines, themes, scope gaps and deployment |
| [Other engines and agents](alternatives.md) | Lezer, modern highlight.js/lowlight, Prism, syntect, Codex, delta/bat, Gemini CLI and Aider |
| [Experiments](experiments.md) | Reproduction, exact versions, raw quality/timing observations and limitations |
| [Independent evidence review](evidence-review.md) | Fresh source audit, validated claims and remaining implementation gates |

These are research records, not replacements for the maintained specifications in `docs/`. Code, specifications and dependency manifests were not changed by this research. Existing uncommitted work was preserved; an unrelated concurrent manifest change was observed and left untouched. No commits/staging were performed.

## Root-cause summary

There are four distinct issues:

- **Sparse grammar output:** no token for many ordinary variables, user types, member calls/properties and operators in the installed highlighter. Theme rules cannot create missing tokens.
- **Restricted language resolution:** examples `.vue`, `.svelte`, `.mts`, `.cts`, `.bashrc`, `CMakeLists.txt` do not resolve; broader grammars alone do not fix that. Dockerfile/Makefile do resolve.
- **Presentation compression:** Pi assigns comments/operators/punctuation and ordinary output the same muted color. Nested token foreground resets also return to terminal default, not the enclosing ordinary foreground. That is separate from classification quality.
- **Incomplete source:** old/new streams are correctly independent, but separated hunks are currently concatenated for highlighting. Missing historical context cannot be reconstructed by a parser.

Seven native/card examples compared **419 actual source-cell foregrounds**, all equal. The examples do not support blaming diff tint/layout for dropped colors. This control is not a full end-to-end, Unicode or all-width result.

## Comparison at a glance

| Option | Main advantage | Main reason not to take it unchanged |
|---|---|---|
| **Standalone Tree-sitter/WASM — initial candidate** | Structural name/call/type queries, closest OpenCode match, same parser family can cover Bash | Must supply compatible pinned grammars/queries, overlap/injection handling, startup/lifecycle and ANSI adaptation |
| **Lezer — strongest pure-JS alternative** | Rich common-language roles, ordered span callbacks, no native/WASM runtime; good local TS/Python controls | Smaller official catalog; no official Bash parser identified; adding another tokenizer increases maintenance |
| **Shiki — selected in the expanded study** | Broad maintained bundle, editor-style scopes/themes, direct tokens, useful shell/embedded support | Ordinary Python names remain a gap in tested grammar; initialization and uncached work are not free |
| **Modern highlight.js/lowlight** | Easy JS integration and broader/denser than Pi's old 10.x in tested TS | Still sparse ordinary Python/object/argument names; modern multi-class decoding required; duplicate host engine |
| **Prism** | Broad catalogue and nested token API without HTML | Not all identifiers/types classified; removed TS rules; v1 maintenance restrictions |
| **syntect** | Mature Rust terminal ecosystem: Codex/delta/bat | Unvalidated Node bridge/native/WASM/subprocess boundary; no demonstrated benefit justifying it here |
| **OpenTUI/Pierre/Hunk as dependencies** | Full diff/UI infrastructure already exists | Imports unrelated renderers, runtime/data models and ownership; wrong boundary for tokenization alone |

Language totals are not comparable quality scores. Tree-sitter coverage depends on selected grammars **and** queries; TextMate coverage also depends on scope mapping and embeddings. None resolves cross-file symbols/types like an LSP semantic-token service.

## Historical initial architecture hypotheses

One shared syntax module/service, not a renderer framework or a pluggable-engine platform:

```text
saved/source command text + explicit language or filename
  → deterministic language resolver
  → selected grammar/query on each available contiguous source segment
  → normalized source spans and syntax categories
  → active Pi theme + exact-source terminal styling
  → existing grapheme wrapping, diff tint and frame
```

- Keep file-card metadata validation, lifecycle routing, layout, native expansion, frame and rendered caches where they are.
- Separate source classification from terminal foreground/background composition. Resolve overlapping captures deterministically; preserve finer categories until theme mapping. Use ordinary foreground explicitly for uncaptured gaps rather than letting inner SGR resets leak terminal default.
- Old/new source is independent. Highlight all **available contiguous** context before projecting visible context; reset at genuine unavailable intervals without claiming unknown enclosing state was recovered.
- Resolve common extensions/basenames/aliases explicitly. Bash arguments use an explicit shell language; prompts/descriptions/output are not part of that source.
- Ship deterministic local runtime/grammar/query assets with provenance/notices; no render-time network downloads, mutable URLs or reads of edited files.
- Initialize/load outside synchronous render callbacks, deduplicate requests and define ready/failure states. If asynchronous work can finish after invalidation/off/reload, validate its state before applying it; do not retain owners through completion closures.
- Parse one-shot source, turn it into spans/rows, dispose transient trees. Keep existing rendered-only cache ownership. Do not add a retained AST/source-token cache, width history or global source registry speculatively.
- Worker offloading is a responsiveness decision to make from representative uncached-work measurements. It does not inherently reduce total CPU. Do not copy OpenCode/Hunk's whole worker/cache architecture merely because it exists.

Current Pi foreground roles will remain the baseline palette. This means some correctly classified punctuation/comments may still intentionally look muted. If stronger visual differentiation is wanted, approve a separate **local** palette/style policy; do not silently replace the user's global Pi theme.

## Acceptance gates before implementation can be accepted

1. **Language quality corpus:** TS/TSX/JS, Python, Rust, JSON, HTML/CSS embeddings and Bash command/heredoc/substitution controls. Assert specific variable/function/type/property roles and evaluate actual terminal appearance, not just "some colored cells". Include unknown filenames and malformed/partial source.
2. **Context boundaries:** multiline comments/templates opened in supplied hidden context; unavailable openers/closers; disjoint hunks; old/new independence; patch/numbered metadata and full supplied write source. Document irrecoverable context rather than guessing historical files.
3. **Terminal contract:** exact source text, tabs, Unicode/graphemes/wide glyphs, runtime source-offset normalization, narrow/split widths, ANSI reset handling, token foreground and existing background/frame geometry.
4. **Runtime/deployment:** actual **Node 22.19.0** and supported host, packaged WASM/query compatibility, complete selected asset notices, offline behavior, language readiness, load failures and disposal/off/reload races. Local probes ran Node 26.7.0 only.
5. **Performance/ownership:** count tokenization calls, not only timings. Unchanged retained layout → **zero**; one updated tool → only its source; no idle timers. Measure cold load, uncached real-sized diffs, main-thread blocking, long input, retained engine/grammar memory and transient peaks separately. Asset/parser memory is not covered by existing rendered-LRU budgets.
6. **Real CLI/native/replay:** physical foreground/background controls in both themes, expansion/off/on/reload, widths, actual saved diffs, same-session replay, strict native model-context/call/result/session equality.
7. **Fresh independent implementation review:** source/contracts/controls, with findings written before acceptance. Research review does not substitute for implementation review.

These are implementation gates, not checks claimed to have passed. The current research includes native/card diagnostic controls and isolated candidate token/span experiments, **not** a production candidate ANSI adapter, minimum-Node proof or real candidate CLI replay.

## Historical initial evidence review

Three bounded research lanes covered distinct external seams; one fresh evidence auditor checked their claims, this synthesis and selected local probes against actual sources. The [written audit](evidence-review.md) found **no material factual correction or evidence blocker** to the weighted recommendation. It explicitly did not establish universal superiority or accept a production implementation. Local artifact links in the published audit were made repository-relative; findings were not changed.

Verification of the research artifacts: all four probe scripts passed `node --check`; recorded native/card foreground comparison covered 419 cells; both Shiki engines reconstructed all seven samples exactly and their seven token/color/scope outputs matched; Tree-sitter and Lezer controls verified Python name classification. Local Markdown file links and stored JSONL counters were also checked. No production regression suite or candidate real CLI replay was run. AFT's health inspection had incomplete cached metrics and was not used as comprehensive validation.

No semantic-check success is inferred from source-check output marked `unclear`; manually inspected authoritative passages and actual recorded probes remain the evidence. Minimum-runtime, full terminal integration, representative performance/ownership and replay gates remain open for a separately authorized implementation.
