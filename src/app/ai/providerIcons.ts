import cliAntigravity from '../assets/providers/cli-antigravity.svg?raw';
import cliClaude from '../assets/providers/cli-claude.svg?raw';
import cliCodex from '../assets/providers/cli-codex.svg?raw';
import cliCursor from '../assets/providers/cli-cursor.svg?raw';
import cliGemini from '../assets/providers/cli-gemini.svg?raw';
import cliGrok from '../assets/providers/cli-grok.svg?raw';
import cliKimi from '../assets/providers/cli-kimi.svg?raw';
import cliQoder from '../assets/providers/cli-qoder.svg?raw';
import deepseek from '../assets/providers/deepseek.svg?raw';
import lmstudio from '../assets/providers/lmstudio.svg?raw';
import mimo from '../assets/providers/mimo.svg?raw';
import moonshot from '../assets/providers/moonshot.svg?raw';
import nvidia from '../assets/providers/nvidia.svg?raw';
import ollama from '../assets/providers/ollama.svg?raw';
import openai from '../assets/providers/openai.svg?raw';
import openrouter from '../assets/providers/openrouter.svg?raw';
import qwen from '../assets/providers/qwen.svg?raw';
import siliconflow from '../assets/providers/siliconflow.svg?raw';
import volces from '../assets/providers/volces.svg?raw';
import xai from '../assets/providers/xai.svg?raw';
import zhipu from '../assets/providers/zhipu.svg?raw';

/**
 * Vendor and agent marks, inlined as SVG source.
 *
 * Inlined rather than loaded through `<img>` for two reasons: a monochrome mark
 * is drawn in `currentColor` and an `<img>` cannot inherit it, and a full-colour
 * one must not be tinted at all — both only work when the markup is part of the
 * document. Attribution and licensing are in
 * `src/app/assets/providers/NOTICE.md`.
 *
 * `mono` says which of the two a mark is. Brands whose logo is genuinely black —
 * OpenAI, Grok, Cursor, Ollama — ship no colour version, so those are painted
 * black on the same light tile the colour marks sit on. Nothing here changes
 * with the interface theme: a mark that inverts is not that brand's mark.
 */
export interface VendorIcon {
  svg: string;
  mono: boolean;
}

const ICONS: Record<string, VendorIcon> = {
  // Model vendors, keyed by `providerId`.
  deepseek: { svg: deepseek, mono: false },
  nvidia: { svg: nvidia, mono: false },
  qwen: { svg: qwen, mono: false },
  moonshot: { svg: moonshot, mono: false },
  zhipu: { svg: zhipu, mono: false },
  siliconflow: { svg: siliconflow, mono: false },
  volces: { svg: volces, mono: false },
  openrouter: { svg: openrouter, mono: false },
  mimo: { svg: mimo, mono: true },
  openai: { svg: openai, mono: true },
  xai: { svg: xai, mono: true },
  ollama: { svg: ollama, mono: true },
  lmstudio: { svg: lmstudio, mono: true },

  // Coding-agent CLIs, keyed by `cli:<agent id>`.
  'cli:claude': { svg: cliClaude, mono: false },
  'cli:gemini': { svg: cliGemini, mono: false },
  'cli:antigravity': { svg: cliAntigravity, mono: false },
  // The binary still calls itself `codex-cli`, but the product sits under
  // ChatGPT now, so it carries the ChatGPT mark.
  'cli:codex': { svg: cliCodex, mono: true },
  'cli:cursor': { svg: cliCursor, mono: true },
  'cli:kimi': { svg: cliKimi, mono: false },
  'cli:qoder': { svg: cliQoder, mono: false },
  'cli:grok': { svg: cliGrok, mono: true },
};

export function vendorIcon(id: string): VendorIcon | null {
  return ICONS[id] ?? null;
}
