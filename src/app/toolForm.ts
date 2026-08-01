import { isParamVisible } from '@core/params.ts';
import type { ParamSpec, ParamValues } from '@core/types.ts';

/** Keeps routine tool pages short while leaving every setting reachable. */
export function partitionToolParams(
  params: readonly ParamSpec[],
  values: ParamValues,
): { primary: ParamSpec[]; more: ParamSpec[] } {
  const visible = params.filter((param) => isParamVisible(param, values));
  const common = visible.filter((param) => !param.advanced);
  return {
    primary: common.slice(0, 2),
    more: [...common.slice(2), ...visible.filter((param) => param.advanced)],
  };
}

export type PageRangePreset = 'all' | 'odd' | 'even' | 'custom';

export function pageRangePreset(value: unknown): PageRangePreset {
  return value === 'all' || value === 'odd' || value === 'even' ? value : 'custom';
}
