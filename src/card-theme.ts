import type { ThemeBg, ThemeColor, ThemeStyle, ThemeToken } from "@earendil-works/pi-coding-agent";
import type { Color } from "@earendil-works/pi-tui";
import type { CardPaint } from "./card-frame.ts";

export interface CardTheme {
  fg(color: ThemeColor, text: string): string;
  bg?(color: ThemeBg, text: string): string;
  style?(text: string, options: ThemeStyle): string;
  readonly colors?: Readonly<Partial<Record<ThemeToken, Color>>>;
}

/** Presentation roles for tool panels; the generic frame never chooses colors. */
export function toolCardPaint(theme: CardTheme, error: boolean): CardPaint {
  return {
    panel(text) {
      return theme.bg ? theme.bg("toolPendingBg", text) : text;
    },
    border(text) {
      return theme.fg(error ? "error" : "borderMuted", text);
    },
  };
}
