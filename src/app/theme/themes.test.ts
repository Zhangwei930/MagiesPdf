import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  THEME_TOKEN_NAMES,
  UI_THEMES,
  resolveTheme,
  themeById,
  themeVariables,
  themesFor,
} from './themes.ts';

describe('theme registry', () => {
  it('gives every theme a unique id, a mode and both names', () => {
    const ids = new Set(UI_THEMES.map((theme) => theme.id));
    assert.equal(ids.size, UI_THEMES.length);
    for (const theme of UI_THEMES) {
      assert.ok(['light', 'dark'].includes(theme.mode), `${theme.id}: mode`);
      assert.ok(theme.name.zh && theme.name.en, `${theme.id}: name`);
    }
  });

  it('ships several of each mode, which is the point of the picker', () => {
    assert.ok(themesFor('light').length >= 4);
    assert.ok(themesFor('dark').length >= 4);
  });

  it('defines every token in every theme, so none can fall back to another palette', () => {
    for (const theme of UI_THEMES) {
      for (const token of THEME_TOKEN_NAMES) {
        assert.ok(theme.tokens[token], `${theme.id} is missing ${token}`);
      }
    }
  });

  it('names defaults that exist and match their mode', () => {
    assert.equal(themeById(DEFAULT_LIGHT_THEME_ID)?.mode, 'light');
    assert.equal(themeById(DEFAULT_DARK_THEME_ID)?.mode, 'dark');
  });

  it('resolves an unknown id to nothing', () => {
    assert.equal(themeById('nope'), null);
    assert.equal(themeById(''), null);
  });
});

describe('resolveTheme', () => {
  const choice = { light: DEFAULT_LIGHT_THEME_ID, dark: DEFAULT_DARK_THEME_ID };

  it('follows the system preference in system mode', () => {
    assert.equal(resolveTheme('system', true, choice).mode, 'dark');
    assert.equal(resolveTheme('system', false, choice).mode, 'light');
  });

  it('ignores the system preference once a mode is chosen', () => {
    assert.equal(resolveTheme('dark', false, choice).mode, 'dark');
    assert.equal(resolveTheme('light', true, choice).mode, 'light');
  });

  it('uses the theme picked for that mode', () => {
    const warm = themesFor('light').find((theme) => theme.id !== DEFAULT_LIGHT_THEME_ID);
    assert.ok(warm);
    assert.equal(resolveTheme('light', false, { light: warm.id, dark: choice.dark }).id, warm.id);
  });

  it('falls back to the default when the stored id is unknown or the wrong mode', () => {
    assert.equal(resolveTheme('light', false, { light: 'gone', dark: choice.dark }).id, DEFAULT_LIGHT_THEME_ID);
    // A dark id stored under the light slot must not paint a dark palette.
    assert.equal(
      resolveTheme('light', false, { light: DEFAULT_DARK_THEME_ID, dark: choice.dark }).id,
      DEFAULT_LIGHT_THEME_ID,
    );
  });
});

describe('themeVariables', () => {
  it('turns a theme into the custom properties the stylesheet reads', () => {
    const variables = themeVariables(themeById(DEFAULT_LIGHT_THEME_ID)!);
    assert.equal(Object.keys(variables).length, THEME_TOKEN_NAMES.length);
    for (const name of Object.keys(variables)) {
      assert.match(name, /^--/, `${name} must be a custom property`);
    }
    assert.ok(variables['--surface-app']);
  });
});
