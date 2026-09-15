export const palette = {
  accent: "#6965db",
  accentHover: "#5753c6",
  accentText: "#514ca8",
  accentSoft: "#eae9ff",
  accentBorder: "#c9c7f3",
  warning: "#c83f45",
  ink: "#484850",
  mutedInk: "#71717a",
  softInk: "#92929d",
  wallFill: "#dedee5",
} as const;

export const themeVariables = {
  "--accent": palette.accent,
  "--accent-hover": palette.accentHover,
  "--accent-text": palette.accentText,
  "--accent-soft": palette.accentSoft,
  "--accent-border": palette.accentBorder,
  "--warning": palette.warning,
};
