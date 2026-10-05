import { isAbsolute, relative } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { colorToRgb, rgbColor, stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Color } from "@earendil-works/pi-tui";
import { cardGeometry, frameRows } from "./card-frame.ts";
import { toolCardPaint, type CardTheme } from "./card-theme.ts";

interface EditPresentation {
  args: Record<string, unknown>;
  isPartial: boolean;
  result?: { isError?: boolean; details?: unknown };
}
type DiffLine = { kind: " " | "+" | "-"; text: string; old?: number; next?: number; styled?: string; hunk?: number } | { kind: "gap" };
export type CodeHighlight = (code: string, path: string) => string[];

// Display-only maximum on each side of a change; metadata may supply fewer rows.
const DIFF_CONTEXT_LINES = 3;

/** Display-only cleaning. Preserve code whitespace; no file reads or proposal diffing. */
function clean(value: string): string {
  return stripVTControlCharacters(stripTerminalSequences(value)).replace(/\p{Bidi_Control}/gu, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\u200e\u200f\u2060-\u206f]/gu, "");
}
export function editPath(args: Record<string, unknown>): string | undefined {
  const path = args.path ?? args.file_path ?? args.filePath;
  return typeof path === "string" && path.length ? path : undefined;
}
function tabText(text: string): string {
  text = clean(text);
  if (!text.includes("\t")) return text;
  let column = 0, output = "";
  for (const { segment } of segments.segment(text)) {
    const value = segment === "\t" ? " ".repeat(4 - column % 4) : segment;
    output += value; column += visibleWidth(value);
  }
  return output;
}
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const validNumber = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Stream source rows; validation-only callers need no temporary array of the whole diff. */
function* sourceRows(diff: string, trimFinalNewline = false): Generator<string> {
  const text = diff.replace(/\r\n?/gu, "\n");
  const length = text.length - (trimFinalNewline && text.endsWith("\n") ? 1 : 0);
  let start = 0;
  do {
    const newline = text.indexOf("\n", start), end = newline < 0 ? length : Math.min(newline, length);
    yield text.slice(start, end); start = end + 1;
  } while (start <= length);
}

/** Pi/AFT number context in the old file; OpenCode's unified view numbers context in the new file. */
function numberedDiff(diff: string, content = true): DiffLine[] | undefined {
  if (!diff) return [];
  const result: DiffLine[] = [];
  let delta = 0;
  for (const row of sourceRows(diff)) {
    if (/^ +\.\.\.$/u.test(row)) { if (content) result.push({ kind: "gap" }); continue; }
    const match = /^([ +\-]) *(\d+) (.*)$/u.exec(row);
    if (!match) return undefined;
    const kind = match[1] as " " | "+" | "-", number = Number(match[2]);
    if (!validNumber(number) || number < 1 || (kind === " " && (!validNumber(number + delta) || number + delta < 1))) return undefined;
    if (content) result.push({ kind, text: tabText(match[3]!), old: kind !== "+" ? number : undefined,
      next: kind === " " ? number + delta : kind === "+" ? number : undefined });
    if (kind === "+") delta++;
    if (kind === "-") delta--;
  }
  return result;
}

/** Accept single-file unified patches only, and validate hunk counts before painting any edits. */
function unifiedDiff(diff: string, content = true): DiffLine[] | undefined {
  if (!diff) return [];
  const result: DiffLine[] = [];
  let old = 0, next = 0, oldRemaining = 0, newRemaining = 0, hunks = 0;
  for (const row of sourceRows(diff, true)) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(row);
    if (header) {
      if (oldRemaining || newRemaining) return undefined;
      old = Number(header[1]); next = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1); newRemaining = Number(header[4] ?? 1);
      if (![old, next, oldRemaining, newRemaining].every(validNumber) ||
        (oldRemaining > 0 && (old < 1 || !validNumber(old + oldRemaining - 1))) ||
        (newRemaining > 0 && (next < 1 || !validNumber(next + newRemaining - 1)))) return undefined;
      hunks++; continue;
    }
    if (row === "\\ No newline at end of file") continue;
    if (!hunks) continue; // File headers are not display content.
    const kind = row[0];
    if (kind !== " " && kind !== "+" && kind !== "-") return undefined;
    if (kind !== "+" && --oldRemaining < 0) return undefined;
    if (kind !== "-" && --newRemaining < 0) return undefined;
    if (content) result.push({ kind, text: tabText(row.slice(1)), old: kind !== "+" ? old : undefined, next: kind !== "-" ? next : undefined, hunk: hunks });
    if (kind !== "+") old++;
    if (kind !== "-") next++;
  }
  return hunks && !oldRemaining && !newRemaining ? result : undefined;
}

/** Validation-only calls collect no source rows and do no cleaning, segmentation or highlighting. */
function editDiff(node: EditPresentation, content = true): DiffLine[] | "inline" | undefined {
  // Reject stale/proposed source before even looking at diff metadata on final errors.
  if (!node.isPartial && node.result?.isError === true) return "inline";
  const details = node.result?.details as { diff?: unknown; patch?: unknown } | undefined;
  if (details?.diff === undefined && details?.patch === undefined) return "inline";
  return typeof details?.patch === "string" ? unifiedDiff(details.patch, content) : typeof details?.diff === "string" ?
    /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/mu.test(details.diff) ? unifiedDiff(details.diff, content) : numberedDiff(details.diff, content) : undefined;
}
function heading(path: string, cwd: string | undefined): string {
  const local = cwd && isAbsolute(path) ? relative(cwd, path) : path;
  return `← Edited ${clean(local || path).replace(/\s+/gu, " ").trim()}`;
}

/** Class/height needed for spacing or rejected clicks, not a rendered layout or a second cache. */
export function measureEditCard(node: EditPresentation, cwd: string | undefined, width: number) {
  const path = editPath(node.args);
  if (!path) return undefined;
  if (!width) return { framed: false, height: 0 };
  const diff = editDiff(node, false);
  if (!diff) return undefined;
  // A frame always has padding plus a title: only height > 1 matters to transcript spacing.
  if (diff !== "inline") return { framed: true, height: 3 };
  const inset = Math.min(cardGeometry(width).contentX, Math.max(0, width - 1));
  return { framed: false, height: chunks(heading(path, cwd), width - inset).length };
}

/** Project available context without changing source positions or joining separate hunks. */
function contextRows(lines: DiffLine[]): DiffLine[] {
  const rows: DiffLine[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind !== " ") { rows.push(line); index++; continue; }
    const start = index;
    while (index < lines.length) {
      const context = lines[index]!;
      if (context.kind !== " " || context.hunk !== line.hunk) break;
      index++;
    }
    const changed = (neighbor: DiffLine | undefined) => neighbor && (neighbor.kind === "+" || neighbor.kind === "-") && neighbor.hunk === line.hunk;
    const before = changed(lines[start - 1]), after = changed(lines[index]);
    const count = index - start;
    const head = before ? Math.min(DIFF_CONTEXT_LINES, count) : 0;
    const tail = after ? Math.max(head, count - DIFF_CONTEXT_LINES) : count;
    for (let row = start; row < start + head; row++) rows.push(lines[row]!);
    if (before && after && tail > head) rows.push({ kind: "gap" });
    for (let row = start + tail; row < index; row++) rows.push(lines[row]!);
  }
  let first = 0, last = rows.length;
  while (first < last && rows[first]!.kind === "gap") first++;
  while (last > first && rows[last - 1]!.kind === "gap") last--;
  return rows.slice(first, last);
}

/** Word-preferred grapheme wrapping, retaining every space and keeping ANSI out of layout. */
type Chunk = { text: string; length: number; size: number };
function chunks(text: string, width: number): Chunk[] {
  const units = Array.from(segments.segment(text), ({ segment }) => ({ text: segment, width: visibleWidth(segment) }));
  const rows: Chunk[] = [];
  let index = 0;
  do {
    let end = index, size = 0, boundary = index, boundarySize = 0;
    while (end < units.length) {
      const unit = units[end]!, columns = Math.min(unit.width, width);
      if (size + columns > width) break;
      size += columns; end++;
      if (/\s/u.test(unit.text) && end > index + 1) { boundary = end; boundarySize = size; }
    }
    if (end < units.length && boundary > index && boundarySize > 0) { end = boundary; size = boundarySize; }
    const parts: string[] = [];
    let length = 0;
    for (let part = index; part < end; part++) {
      const unit = units[part]!;
      parts.push(unit.width > width ? "�" : unit.text); length += unit.text.length;
    }
    rows.push({ text: parts.join(""), length, size });
    index = end;
  } while (index < units.length);
  return rows;
}
/** Partition ANSI text monotonically at plain UTF-16 boundaries, then carry only active SGR state.
 * No repeated column scans or historical prefix copies. Pi's public no-wrap path preserves spaces.
 */
function styledChunks(text: string, rows: Chunk[]): string[] {
  if (rows.length === 1) return [text];
  const codes = text.matchAll(/\x1b\[[\d;:]*m/gu);
  let code = codes.next().value, position = 0;
  const fragments = rows.map((row) => {
    const parts: string[] = [];
    let remaining = row.length;
    while (remaining > 0 || code?.index === position) {
      if (code?.index === position) {
        parts.push(code[0]); position += code[0].length; code = codes.next().value;
      } else {
        const length = Math.min(remaining, (code?.index ?? text.length) - position);
        if (length <= 0) break;
        parts.push(text.slice(position, position + length)); position += length; remaining -= length;
      }
    }
    return parts.join("");
  });
  return wrapTextWithAnsi(fragments.join("\n"), Number.MAX_SAFE_INTEGER);
}
function highlight(lines: DiffLine[], path: string, paint: CardTheme, highlighter?: CodeHighlight) {
  // Highlight before/after separately so removed strings/comments cannot color new code.
  for (const side of ["old", "next"] as const) {
    const source = lines.filter((line): line is Extract<DiffLine, { text: string }> => line.kind !== "gap" && line[side] !== undefined);
    if (!source.length) continue;
    const highlighted = highlighter?.(source.map((line) => line.text).join("\n"), path);
    // Restore multiline token ANSI state before styling individual rows. This public helper
    // only splits/carries styles here: the unlimited width avoids its ANSI/space wrap path.
    const styled = highlighted ? wrapTextWithAnsi(highlighted.join("\n"), Number.MAX_SAFE_INTEGER) : undefined;
    source.forEach((line, index) => {
      if (side === "next" || line.kind === "-") {
        const row = styled?.[index];
        line.styled = paint.fg("toolOutput", row !== undefined && stripVTControlCharacters(row) === line.text ? row : line.text);
      }
    });
  }
}
type DiffTints = Partial<Record<"toolDiffAdded" | "toolDiffRemoved", { code: Color; gutter: Color }>>;
function diffTints(theme: CardTheme): DiffTints {
  const tints: DiffTints = {};
  if (!theme.colors?.toolPendingBg || !theme.style) return tints;
  const base = colorToRgb(theme.colors.toolPendingBg);
  for (const role of ["toolDiffAdded", "toolDiffRemoved"] as const) {
    const color = theme.colors[role];
    if (!color) continue;
    const overlay = colorToRgb(color);
    const blend = (alpha: number) => {
      // Opacity-weighted Multiply in sRGB; round only after blending, never brighten the panel.
      const channel = (key: "r" | "g" | "b") => Math.round(base[key] * (1 - alpha + alpha * overlay[key] / 255));
      return rgbColor(channel("r"), channel("g"), channel("b"));
    };
    tints[role] = { code: blend(0.16), gutter: blend(0.26) };
  }
  return tints;
}
function cell(line: DiffLine | undefined, side: "old" | "next", width: number, digits: number, theme: CardTheme, tints: DiffTints): string[] {
  if (!line) return [" ".repeat(width)];
  if (line.kind === "gap") return [theme.fg("dim", "…") + " ".repeat(width - 1)];
  const gutterWidth = digits + 4 < width ? digits + 4 : 0;
  const contentWidth = width - gutterWidth;
  const role = line.kind === "+" ? "toolDiffAdded" : line.kind === "-" ? "toolDiffRemoved" : undefined;
  const tint = (text: string, part: "gutter" | "code") => {
    const bg = role ? tints[role]?.[part] : undefined;
    return bg && theme.style ? theme.style(text, { bg }) : text;
  };
  const wrapped = chunks(line.text, contentWidth), styled = styledChunks(line.styled ?? line.text, wrapped);
  return wrapped.map((chunk, index) => {
    const number = index === 0 ? String(line[side] ?? "").padStart(digits) : " ".repeat(digits);
    const sign = index === 0 && role ? theme.fg(role, ` ${line.kind}`) : "  ";
    const gutter = gutterWidth ? tint(theme.fg("dim", " " + number) + sign + " ", "gutter") : "";
    const fragment = styled[index] ?? "";
    const code = stripVTControlCharacters(fragment) === chunk.text ? fragment : theme.fg("toolOutput", chunk.text);
    return gutter + tint(code + " ".repeat(contentWidth - chunk.size), "code");
  });
}
function* diffRows(lines: DiffLine[], width: number, split: boolean, theme: CardTheme): Generator<string> {
  const tints = diffTints(theme);
  const digits = String(lines.reduce((max, line) => line.kind === "gap" ? max : Math.max(max, line.old ?? 0, line.next ?? 0), 1)).length;
  if (!split) {
    for (const line of lines) yield* cell(line, line.kind === "-" ? "old" : "next", width, digits, theme, tints);
    return;
  }
  const leftWidth = Math.floor(width / 2), rightWidth = width - leftWidth;
  function* pair(left?: DiffLine, right?: DiffLine) {
    const before = cell(left, "old", leftWidth, digits, theme, tints), after = cell(right, "next", rightWidth, digits, theme, tints);
    for (let index = 0; index < Math.max(before.length, after.length); index++)
      yield (before[index] ?? " ".repeat(leftWidth)) + (after[index] ?? " ".repeat(rightWidth));
  }
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (line.kind === " " || line.kind === "gap") { yield* pair(line, line); index++; continue; }
    const removes: DiffLine[] = [], adds: DiffLine[] = [];
    while (index < lines.length) {
      const changed = lines[index]!;
      if (changed.kind === "gap" || changed.kind === " " || changed.hunk !== line.hunk) break;
      index++;
      (changed.kind === "-" ? removes : adds).push(changed);
    }
    for (let part = 0; part < Math.max(removes.length, adds.length); part++) yield* pair(removes[part], adds[part]);
  }
}

/** OpenCode Edit content policy inside Toolview's accepted shared frame. Undefined means native fallback. */
export function renderEditCard(node: EditPresentation, cwd: string | undefined, width: number, theme: CardTheme, highlighter?: CodeHighlight) {
  const geometry = cardGeometry(width), available = geometry.contentWidth;
  const path = editPath(node.args);
  if (!path) return undefined;
  if (!width) return { rows: [] as string[], framed: false, native: false };
  const title = heading(path, cwd);
  const error = !node.isPartial && node.result?.isError === true;
  const details = node.result?.details as { diff?: unknown; patch?: unknown; diagnostics?: unknown } | undefined;
  const diff = editDiff(node);
  if (diff === "inline") {
    const inset = Math.min(geometry.contentX, Math.max(0, width - 1));
    return { rows: chunks(title, width - inset).map((row) => " ".repeat(inset) + theme.fg(error ? "error" : "muted", row.text)),
      framed: false, native: false };
  }
  if (!diff) return undefined;
  highlight(diff, path, theme, highlighter);
  // Highlight all supplied source first: hidden context can open a multiline token.
  const visible = contextRows(diff);
  const body = chunks(title, available).map((row) => theme.fg("muted", row.text));
  if (visible.length) {
    body.push("");
    // Only mixed edits benefit from two panes; classify the entire parsed diff, not each hunk.
    const split = width > 120 && diff.some(line => line.kind === "+") && diff.some(line => line.kind === "-");
    for (const row of diffRows(visible, available, split, theme)) body.push(row);
  }
  // AFT supplies flattened display positions, not OpenCode's zero-based LSP range map.
  if (Array.isArray(details?.diagnostics)) {
    const diagnostics = details.diagnostics.filter((value) => value && typeof value === "object" && value.severity === "error" && typeof value.message === "string");
    if (diagnostics.length) body.push("");
    for (const diagnostic of diagnostics) {
      const location = Number.isSafeInteger(diagnostic.line) && diagnostic.line > 0 ? ` [${diagnostic.line}]` : "";
      for (const row of chunks(`Error${location}: ${clean(diagnostic.message).replace(/\s+/gu, " ")}`, available)) body.push(theme.fg("error", row.text));
    }
  }
  return { rows: frameRows(geometry, body, toolCardPaint(theme, false)), framed: true, native: false };
}
