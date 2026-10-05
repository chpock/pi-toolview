import { visibleWidth } from "@earendil-works/pi-tui";

/** Tool- and host-independent geometry. Exterior space is never painted. */
export interface CardGeometry {
  width: number;
  marginLeft: number;
  marginRight: number;
  borderWidth: number;
  paddingLeft: number;
  paddingRight: number;
  panelX: number;
  panelWidth: number;
  contentX: number;
  contentWidth: number;
  contentY: number;
}
export interface CardPaint {
  panel(text: string): string;
  border(text: string): string;
}

export function cardGeometry(width: number): CardGeometry {
  width = Math.max(0, Math.floor(width));
  let spare = Math.max(0, width - 1);
  const borderWidth = Math.min(1, spare); spare -= borderWidth;
  const padding = Math.min(2, spare); spare -= padding;
  const paddingLeft = Math.ceil(padding / 2), paddingRight = Math.floor(padding / 2);
  const marginLeft = Math.min(1, Math.floor(spare / 2));
  const marginRight = Math.min(1, spare - marginLeft);
  return {
    width, marginLeft, marginRight, borderWidth, paddingLeft, paddingRight,
    panelX: marginLeft, panelWidth: width - marginLeft - marginRight,
    contentX: marginLeft + borderWidth + paddingLeft,
    contentWidth: width - marginLeft - marginRight - borderWidth - paddingLeft - paddingRight,
    contentY: 1,
  };
}

/** The caller renders its content at contentWidth; framing does not truncate it. */
export function frameRows(geometry: CardGeometry, body: readonly string[], paint: CardPaint): string[] {
  if (!geometry.width) return [];
  return ["", ...body, ""].map((row) => {
    const size = visibleWidth(row);
    if (size > geometry.contentWidth) throw new RangeError("Card content exceeds its allocated width");
    const border = geometry.borderWidth ? paint.border("┃") : "";
    const panel = " ".repeat(geometry.paddingLeft) + row +
      " ".repeat(geometry.contentWidth - size + geometry.paddingRight);
    // Child background/full resets are not a stack: reopen the panel after each one.
    // Keep the reset itself (including its foreground effects) and all child colors.
    const painted = panel.split(/(?<=\x1b\[(?:0|49)m)/u).map((part) => paint.panel(part)).join("");
    // Reset inherited background before the stripe; only the body receives panel paint.
    return "\x1b[49m" + " ".repeat(geometry.marginLeft) + border + painted + " ".repeat(geometry.marginRight);
  });
}

/** Coordinates are component-local; callers remove any outside transcript separator. */
export function insidePanel(geometry: CardGeometry, height: number, x: number, y: number): boolean {
  return geometry.width > 0 && x >= geometry.panelX && x < geometry.panelX + geometry.panelWidth && y >= 0 && y < height;
}
