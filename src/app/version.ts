/**
 * App semver for the renderer.
 *
 * Injected at build time from package.json via vite `define` — do not hardcode
 * elsewhere. Electron main/preload read the same field via `app.getVersion()` /
 * `require('../package.json').version`.
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : '1.0.1';
