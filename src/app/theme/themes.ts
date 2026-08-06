/**
 * Interface themes.
 *
 * `index.css` declares the same tokens for the two built-in palettes; a theme
 * here overrides them at runtime on `:root`. Every theme must define every
 * token — a partial theme would inherit the rest from whichever palette the
 * stylesheet happens to be showing, which is how a light theme ends up with
 * dark text on dark panels.
 *
 * Values are oklch to match the stylesheet: it is perceptually even, so a whole
 * palette can be retinted by moving the hue and nothing goes muddy.
 *
 * Pure, so the registry can be tested without a DOM.
 */

export type ThemeMode = 'light' | 'dark';

export const THEME_TOKEN_NAMES = [
  'surface-app',
  'surface-panel',
  'surface-raised',
  'surface-sunken',
  'surface-hover',
  'border-subtle',
  'border-strong',
  'text-primary',
  'text-secondary',
  'text-muted',
  'accent',
  'accent-hover',
  'accent-soft',
] as const;

export type ThemeToken = (typeof THEME_TOKEN_NAMES)[number];

export interface ThemePreset {
  id: string;
  name: { zh: string; en: string };
  mode: ThemeMode;
  tokens: Record<ThemeToken, string>;
}

/**
 * Builds a palette from a neutral hue and an accent, so a new theme is a few
 * numbers rather than thirteen hand-picked colours that drift apart.
 */
function lightTheme(
  id: string,
  name: { zh: string; en: string },
  { hue, chroma = 0.006, accent, accentHue }: {
    hue: number;
    chroma?: number;
    accent: string;
    accentHue: number;
  },
): ThemePreset {
  return {
    id,
    name,
    mode: 'light',
    tokens: {
      'surface-app': `oklch(0.98 ${chroma} ${hue})`,
      'surface-panel': `oklch(1 0 0)`,
      'surface-raised': `oklch(0.995 ${chroma * 0.4} ${hue})`,
      'surface-sunken': `oklch(0.955 ${chroma} ${hue})`,
      'surface-hover': `oklch(0.965 ${chroma * 1.2} ${accentHue})`,
      'border-subtle': `oklch(0.9 ${chroma} ${hue})`,
      'border-strong': `oklch(0.82 ${chroma * 1.6} ${hue})`,
      'text-primary': `oklch(0.2 0.012 ${hue})`,
      'text-secondary': `oklch(0.42 0.012 ${hue})`,
      'text-muted': `oklch(0.52 0.01 ${hue})`,
      accent,
      'accent-hover': accent.replace(/oklch\(([\d.]+)/, (_match, lightness) =>
        `oklch(${Math.max(0.3, Number(lightness) - 0.08)}`),
      'accent-soft': `oklch(0.95 0.03 ${accentHue})`,
    },
  };
}

function darkTheme(
  id: string,
  name: { zh: string; en: string },
  { hue, chroma = 0.012, accent, accentHue }: {
    hue: number;
    chroma?: number;
    accent: string;
    accentHue: number;
  },
): ThemePreset {
  return {
    id,
    name,
    mode: 'dark',
    tokens: {
      'surface-app': `oklch(0.19 ${chroma} ${hue})`,
      'surface-panel': `oklch(0.235 ${chroma * 1.2} ${hue})`,
      'surface-raised': `oklch(0.27 ${chroma * 1.25} ${hue})`,
      'surface-sunken': `oklch(0.165 ${chroma} ${hue})`,
      'surface-hover': `oklch(0.3 ${chroma * 1.5} ${accentHue})`,
      'border-subtle': `oklch(0.32 ${chroma * 1.2} ${hue})`,
      'border-strong': `oklch(0.42 ${chroma * 1.5} ${hue})`,
      'text-primary': `oklch(0.95 0.005 ${hue})`,
      'text-secondary': `oklch(0.74 0.01 ${hue})`,
      'text-muted': `oklch(0.58 0.012 ${hue})`,
      accent,
      'accent-hover': accent.replace(/oklch\(([\d.]+)/, (_match, lightness) =>
        `oklch(${Math.min(0.9, Number(lightness) + 0.09)}`),
      'accent-soft': `oklch(0.32 0.06 ${accentHue})`,
    },
  };
}

/** The two palettes the stylesheet itself declares; also the fallbacks. */
const INDIGO_LIGHT = lightTheme('indigo-light', { zh: '默认', en: 'Default' }, {
  hue: 265, accent: 'oklch(0.54 0.19 275)', accentHue: 275,
});
const INDIGO_DARK = darkTheme('indigo-dark', { zh: '默认', en: 'Default' }, {
  hue: 265, accent: 'oklch(0.71 0.15 275)', accentHue: 275,
});

export const UI_THEMES: ThemePreset[] = [
  INDIGO_LIGHT,
  lightTheme('paper-light', { zh: '暖纸', en: 'Paper' }, {
    hue: 75, chroma: 0.012, accent: 'oklch(0.55 0.16 45)', accentHue: 55,
  }),
  lightTheme('forest-light', { zh: '青竹', en: 'Forest' }, {
    hue: 155, accent: 'oklch(0.5 0.13 160)', accentHue: 160,
  }),
  lightTheme('ocean-light', { zh: '海蓝', en: 'Ocean' }, {
    hue: 240, accent: 'oklch(0.53 0.16 245)', accentHue: 245,
  }),
  lightTheme('rose-light', { zh: '绯红', en: 'Rose' }, {
    hue: 15, accent: 'oklch(0.55 0.18 15)', accentHue: 15,
  }),
  lightTheme('graphite-light', { zh: '石墨', en: 'Graphite' }, {
    hue: 265, chroma: 0.002, accent: 'oklch(0.42 0.02 265)', accentHue: 265,
  }),

  INDIGO_DARK,
  darkTheme('midnight-dark', { zh: '午夜', en: 'Midnight' }, {
    hue: 250, chroma: 0.02, accent: 'oklch(0.7 0.15 250)', accentHue: 250,
  }),
  darkTheme('forest-dark', { zh: '青竹', en: 'Forest' }, {
    hue: 155, accent: 'oklch(0.72 0.14 160)', accentHue: 160,
  }),
  darkTheme('amber-dark', { zh: '琥珀', en: 'Amber' }, {
    hue: 60, chroma: 0.01, accent: 'oklch(0.78 0.14 70)', accentHue: 70,
  }),
  darkTheme('rose-dark', { zh: '绯红', en: 'Rose' }, {
    hue: 15, accent: 'oklch(0.7 0.16 15)', accentHue: 15,
  }),
  darkTheme('carbon-dark', { zh: '纯黑', en: 'Carbon' }, {
    hue: 265, chroma: 0.002, accent: 'oklch(0.75 0.05 265)', accentHue: 265,
  }),
];

export const DEFAULT_LIGHT_THEME_ID = INDIGO_LIGHT.id;
export const DEFAULT_DARK_THEME_ID = INDIGO_DARK.id;

export function themeById(id: string): ThemePreset | null {
  if (!id) return null;
  return UI_THEMES.find((theme) => theme.id === id) ?? null;
}

export function themesFor(mode: ThemeMode): ThemePreset[] {
  return UI_THEMES.filter((theme) => theme.mode === mode);
}

/**
 * The theme to paint: the mode decides light or dark, the stored choice decides
 * which palette of that mode. A stored id of the wrong mode is ignored rather
 * than honoured — that is how a dark palette leaks into light mode.
 */
export function resolveTheme(
  theme: 'system' | 'light' | 'dark',
  prefersDark: boolean,
  choice: { light: string; dark: string },
): ThemePreset {
  const mode: ThemeMode = theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
  const wanted = themeById(mode === 'dark' ? choice.dark : choice.light);
  if (wanted && wanted.mode === mode) return wanted;

  return mode === 'dark' ? INDIGO_DARK : INDIGO_LIGHT;
}

/** The custom properties to write on `:root` for a theme. */
export function themeVariables(theme: ThemePreset): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const token of THEME_TOKEN_NAMES) {
    variables[`--${token}`] = theme.tokens[token];
  }
  return variables;
}
