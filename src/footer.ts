import type { ContextUsage, SessionEntry, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export interface FooterUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate?: number;
}
export interface FooterData {
  usage: FooterUsage;
  context?: ContextUsage;
  auto: boolean;
  subscription: boolean;
}
interface FooterTheme { fg(color: ThemeColor, text: string): string }
const counters = { aggregations: 0, entries: 0, layouts: 0 };
/** Numeric test observations only; never retains a session/component. */
export const footerDiagnostics = () => ({ ...counters });

/** Match native cumulative accounting, including abandoned branches and side usage. */
export function footerUsage(entries: readonly SessionEntry[]): FooterUsage {
  counters.aggregations++;
  const total: FooterUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of entries) {
    counters.entries++;
    let usage;
    if (entry.type === "usage") usage = entry.usage;
    else if (entry.type === "message" && entry.message.role === "assistant") {
      usage = entry.message.usage;
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      total.cacheHitRate = prompt > 0 ? usage.cacheRead / prompt * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult") usage = entry.message.usage;
    else if (entry.type === "compaction" || entry.type === "branch_summary") usage = entry.usage;
    if (!usage) continue;
    total.input += usage.input; total.output += usage.output;
    total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite; total.cost += usage.cost.total;
  }
  return total;
}

/** Stock Pi compact format for cumulative counters, independent of context format. */
function tokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return (count / 1000).toFixed(1) + "k";
  if (count < 1000000) return Math.round(count / 1000) + "k";
  if (count < 10000000) return (count / 1000000).toFixed(1) + "M";
  return Math.round(count / 1000000) + "M";
}
export function contextTokens(count: number): string {
  const thousands = Math.round(count / 1000);
  if (thousands < 1000) return thousands + "k";
  // Normalize rounding carries before selecting precision (9.995M -> 10.0M).
  const value = count / 1000000;
  const millions = value < 100 ? Number(value.toPrecision(3)) : Math.round(value);
  return millions.toFixed(millions < 10 ? 2 : millions < 100 ? 1 : 0) + "M";
}
function metrics(data: FooterData, theme: FooterTheme): string[] {
  const f = (role: ThemeColor, value: string) => theme.fg(role, value);
  const punctuation = (value: string) => f("dim", value);
  const parens = (value: string, role: ThemeColor = "muted") => punctuation("(") + f(role, value) + punctuation(")");
  const u = data.usage;
  const parts = [f("text", "↑") + f("muted", tokens(u.input)), f("text", "↓") + f("muted", tokens(u.output))];
  if (data.context) {
    const c = data.context;
    parts.push(f("text", c.tokens === null ? "?" : contextTokens(c.tokens)) + punctuation("/") + f("muted", contextTokens(c.contextWindow)));
    if (c.percent !== null) parts.push(parens(c.percent.toFixed(1) + "%", c.percent > 90 ? "error" : c.percent > 70 ? "warning" : "muted"));
    if (data.auto) parts.push(parens("auto"));
  }
  if (u.cacheRead) parts.push(f("text", "R") + f("muted", tokens(u.cacheRead)));
  if (u.cacheWrite) parts.push(f("text", "W") + f("muted", tokens(u.cacheWrite)));
  if ((u.cacheRead > 0 || u.cacheWrite > 0) && u.cacheHitRate !== undefined) {
    const displayed = u.cacheHitRate.toFixed(1), rate = Number(displayed);
    parts.push(f(rate >= 95 ? "success" : rate < 80 ? "error" : "warning", "CH" + displayed + "%"));
  }
  if (u.cost || data.subscription) parts.push(f("text", "$") + f("muted", u.cost.toFixed(3)) + (data.subscription ? " " + parens("sub") : ""));
  return parts;
}
const RESET = "\x1b[0m";
const CLOSE_LINK = "\x1b]8;;\x1b\\";
const isolated = (text: string) => RESET + text + CLOSE_LINK + RESET;

/** Pure width fitting: preserve producer ANSI, never parse extension-specific values. */
export function renderFooter(width: number, data: FooterData, statuses: readonly (readonly [string, string])[], theme: FooterTheme): string[] {
  if (width < 1) return [];
  counters.layouts++;
  const left: string[] = [];
  let row = "", columns = 0;
  for (const metric of metrics(data, theme)) {
    const size = visibleWidth(metric);
    if (columns && columns + 1 + size > width) { left.push(row); row = ""; columns = 0; }
    if (size > width) {
      const wrapped = wrapTextWithAnsi(metric, width);
      left.push(...wrapped.slice(0, -1)); row = wrapped.at(-1) ?? ""; columns = visibleWidth(row);
    } else { row += (columns ? " " : "") + metric; columns += (columns ? 1 : 0) + size; }
  }
  if (row) left.push(row);
  const last = left.pop() ?? "";
  let leftRow = last, leftWidth = visibleWidth(last), right = "", rightWidth = 0;
  const flush = () => {
    if (right) left.push(leftRow + " ".repeat(Math.max(0, width - leftWidth - rightWidth)) + right);
    else if (leftRow) left.push(leftRow);
    leftRow = ""; leftWidth = 0; right = ""; rightWidth = 0;
  };
  for (const [, value] of [...statuses].sort(([a], [b]) => a.localeCompare(b))) {
    const clean = value.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
    const size = visibleWidth(clean);
    if (!size) continue;
    const required = rightWidth + (right ? 3 : 0) + size;
    if (leftWidth + (leftWidth ? 2 : 0) + required > width) flush();
    const fitted = size > width ? truncateToWidth(clean, width, theme.fg("dim", "…")) : clean;
    const fittedWidth = visibleWidth(fitted);
    right += (right ? isolated(theme.fg("dim", " • ")) : "") + isolated(fitted);
    rightWidth += (rightWidth ? 3 : 0) + fittedWidth;
  }
  flush();
  return left;
}

/** One latest transient layout per live footer, not a transcript/body cache pool. */
export class FooterView implements Component {
  private rows?: string[];
  private width = -1;
  private data?: FooterData;
  private theme?: FooterTheme;
  private statuses: readonly (readonly [string, string])[] = [];
  private readonly read: () => FooterData;
  private readonly readStatuses: () => ReadonlyMap<string, string>;
  private readonly readTheme: () => FooterTheme;
  private readonly isActive: () => boolean;
  constructor(read: () => FooterData, readStatuses: () => ReadonlyMap<string, string>, readTheme: () => FooterTheme, isActive: () => boolean = () => true) {
    this.read = read; this.readStatuses = readStatuses; this.readTheme = readTheme; this.isActive = isActive;
  }
  render(width: number): string[] {
    if (width < 1 || !this.isActive()) return [];
    const data = this.read(), theme = this.readTheme(), statuses = [...this.readStatuses()];
    if (this.rows && this.width === width && this.data === data && this.theme === theme &&
      this.statuses.length === statuses.length && this.statuses.every(([key, value], i) => key === statuses[i]?.[0] && value === statuses[i]?.[1])) return this.rows;
    this.width = width; this.data = data; this.theme = theme; this.statuses = statuses;
    return this.rows = renderFooter(width, data, statuses, theme);
  }
  invalidate(): void { this.rows = undefined; }
  clear(): void { this.rows = undefined; this.data = undefined; this.theme = undefined; this.statuses = []; }
}
