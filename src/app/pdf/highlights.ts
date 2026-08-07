import type { Rect } from './geometry.ts';

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink';

export interface TextHighlight {
  id: string;
  pageNumber: number;
  rects: Rect[];
  color: HighlightColor;
}

export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#fef08a',
  green: '#bbf7d0',
  blue: '#bfdbfe',
  pink: '#fbcfe8',
};
