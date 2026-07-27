import { ToolRegistry } from '@core/registry.ts';
import type { ToolMeta } from '@core/types.ts';

/**
 * The renderer's view of the tool catalogue.
 *
 * Populated once at start-up from data the main process reads out of
 * `dist-electron/catalog.json`. Deliberately metadata-only: the UI can describe
 * and configure every tool, but has no way to execute one — that belongs to the
 * worker pool, and keeping it there is what stops the PDF engines from being
 * bundled into the renderer.
 */
export const uiRegistry = new ToolRegistry<ToolMeta>();

let loaded = false;

export function loadCatalog(tools: readonly ToolMeta[]): void {
  if (loaded) return;
  for (const tool of tools) uiRegistry.register(tool);
  loaded = true;
}

export function catalogLoaded(): boolean {
  return loaded;
}
