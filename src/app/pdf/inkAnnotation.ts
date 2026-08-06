import type { Point } from './geometry.ts';

export interface InkAnnotation {
  id: string;
  pageNumber: number;
  points: Point[];
  color: string;
  strokeWidth: number;
}
