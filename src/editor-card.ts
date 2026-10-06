import { CURSOR_MARKER, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { cardGeometry, frameRows } from "./card-frame.ts";
import type { CardTheme } from "./card-theme.ts";

// Internal row sentinels returned only during native projection, never painted.
// Native Editor text/menu rows occupy at least one column and cannot equal these.
export const EDITOR_TOP = "\0";
export const EDITOR_BOTTOM = "\0\0";
export interface EditorProjection { rows: string[]; top: string; bottom: string }
export interface EditorLayout { rows: string[]; framed: boolean; nativeWidth: number; offsetX: number }

/** Reframe native editing output, not draft source or private editing state. */
export function renderEditorCard(width: number, padding: number, theme: CardTheme,
  renderNative: (width: number, borderWidth?: number) => EditorProjection): EditorLayout {
  const geometry = cardGeometry(width);
  const fallback = (): EditorLayout => ({ rows: renderNative(width).rows, framed: false, nativeWidth: width, offsetX: 0 });
  if (!geometry.width) return { rows: [], framed: false, nativeWidth: 0, offsetX: 0 };
  if (geometry.contentWidth < 2 || !Number.isSafeInteger(padding) || padding < 0 || padding > geometry.width) return fallback();
  // Native zero-padding layout reserves a cursor column; padded layout allows
  // the end cursor into its first right-padding column. Both wrap at contentWidth.
  const nativeWidth = geometry.contentWidth + (padding ? 2 * padding : 1);
  const budget = geometry.contentWidth + geometry.paddingRight;
  const projected = renderNative(nativeWidth, budget);
  const bottom = projected.rows.indexOf(EDITOR_BOTTOM);
  if (projected.rows[0] !== EDITOR_TOP || bottom < 2 || projected.rows.lastIndexOf(EDITOR_BOTTOM) !== bottom)
    throw new Error("Native editor border/row contract is incompatible");
  const nativeBody = projected.rows.slice(1, bottom);
  // Column slicing can stop before the native inverse-cursor reset at the
  // right edge. Close row attributes before painting padding/exterior cells.
  const body = nativeBody.map(row => sliceByColumn(row, padding, budget) + "\x1b[0m");
  const plain = (row: string) => stripVTControlCharacters(row.replaceAll(CURSOR_MARKER, ""));
  if (body.some(row => visibleWidth(row) > budget || visibleWidth(plain(row).trimEnd()) > geometry.contentWidth) ||
    body.join("").split(CURSOR_MARKER).length !== nativeBody.join("").split(CURSOR_MARKER).length)
    return fallback();
  // Borrow only the internal right padding for a native full-line end cursor.
  const frame = { ...geometry, contentWidth: budget, paddingRight: 0 };
  const paint = {
    border: (text: string) => theme.fg("customMessageLabel", text),
    panel: (text: string) => {
      const foreground = theme.fg("userMessageText", text);
      return theme.bg ? theme.bg("userMessageBg", foreground) : foreground;
    },
  };
  const rows = frameRows(frame, [projected.top + "\x1b[0m", ...body, projected.bottom + "\x1b[0m"], paint).slice(1, -1);
  // Keep autocomplete below (not inside) the panel, with unchanged native rows,
  // selection styles and y coordinates. Its text shares the editor content origin.
  const menu = projected.rows.slice(bottom + 1).map(row => {
    const text = sliceByColumn(row, padding, budget) + "\x1b[0m";
    return " ".repeat(geometry.contentX) + text;
  });
  return { rows: [...rows, ...menu], framed: true, nativeWidth, offsetX: geometry.contentX - padding };
}
