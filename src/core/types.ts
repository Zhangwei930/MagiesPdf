/**
 * The shape every MagiesPdf tool is described in.
 *
 * A `ToolDescriptor` is the single source of truth: the card grid, the auto-generated
 * parameter form, the pipeline node palette and the REST routes are all derived from
 * this data. Adding a tool means adding one descriptor — nothing else has to be touched.
 */

/** Inline bilingual label. Kept inline (rather than i18n keys) so a tool stays self-contained. */
export interface LocalizedText {
  zh: string;
  en: string;
}

export const CATEGORY_IDS = ['organize', 'convert', 'security', 'edit', 'advanced'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface CategoryDescriptor {
  id: CategoryId;
  name: LocalizedText;
  description: LocalizedText;
  icon: string;
}

/* ------------------------------------------------------------------ params */

export interface ParamCommon {
  key: string;
  label: LocalizedText;
  help?: LocalizedText;
  /** Tucked behind the "advanced options" disclosure in the generated form. */
  advanced?: boolean;
  /** Show this param only while another param holds one of the given values. */
  visibleWhen?: { key: string; equals: unknown[] };
}

export interface TextParam extends ParamCommon {
  type: 'text';
  default: string;
  placeholder?: LocalizedText;
  multiline?: boolean;
  maxLength?: number;
  /** Empty string rejected during validation. */
  required?: boolean;
}

export interface PasswordParam extends ParamCommon {
  type: 'password';
  default: string;
  required?: boolean;
}

export interface NumberParam extends ParamCommon {
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  unit?: LocalizedText;
}

export interface BooleanParam extends ParamCommon {
  type: 'boolean';
  default: boolean;
}

export interface SelectOption {
  value: string;
  label: LocalizedText;
  help?: LocalizedText;
}

export interface SelectParam extends ParamCommon {
  type: 'select';
  default: string;
  options: SelectOption[];
}

export interface MultiSelectParam extends ParamCommon {
  type: 'multiselect';
  default: string[];
  options: SelectOption[];
  minSelected?: number;
}

/** Free-form page selection, e.g. `1-3,7,10-` or `odd`, validated against the real page count. */
export interface PageRangeParam extends ParamCommon {
  type: 'pageRange';
  default: string;
  required?: boolean;
}

export interface ColorParam extends ParamCommon {
  type: 'color';
  /** `#rrggbb`. */
  default: string;
}

/** A path the user picks from disk — resolved to bytes by the host before `run`. */
export interface FileParam extends ParamCommon {
  type: 'file';
  default: string;
  accept: string[];
  required?: boolean;
}

export type ParamSpec =
  | TextParam
  | PasswordParam
  | NumberParam
  | BooleanParam
  | SelectParam
  | MultiSelectParam
  | PageRangeParam
  | ColorParam
  | FileParam;

export type ParamValue = string | number | boolean | string[];
export type ParamValues = Record<string, ParamValue>;

/* ------------------------------------------------------------------- files */

export interface ToolInputFile {
  /** Original file name including extension, used to derive output names. */
  name: string;
  bytes: Uint8Array;
  mime: string;
}

export interface ToolOutputFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/* ----------------------------------------------------------------- runtime */

/**
 * Capabilities only the Electron main process can provide. Tools declaring
 * `runtime: 'main'` receive a real implementation; worker tools get `undefined`.
 */
export interface HostBridge {
  /** Render HTML to PDF via Chromium's own print pipeline. */
  htmlToPdf(html: string, options: HtmlToPdfOptions): Promise<Uint8Array>;
  /** Invoke the user-configured external document converter, if any. */
  externalConvert(input: ToolInputFile, targetExtension: string): Promise<ToolOutputFile>;
  /** Whether an external converter is configured and its executable exists. */
  hasExternalConverter(): boolean;
}

export interface HtmlToPdfOptions {
  pageSize: 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal' | 'Tabloid';
  landscape: boolean;
  /** Inches. */
  margins: { top: number; bottom: number; left: number; right: number };
  printBackground: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
}

export interface ToolContext {
  files: ToolInputFile[];
  params: ParamValues;
  signal: AbortSignal;
  /** `fraction` is 0..1; `message` surfaces in the job queue row. */
  report(fraction: number, message?: LocalizedText): void;
  /** Present only for `runtime: 'main'` tools. */
  host?: HostBridge;
}

export interface ToolResult {
  files: ToolOutputFile[];
  /** Optional structured payload for tools that report rather than transform (e.g. get-info). */
  data?: unknown;
  /** Short human-readable outcome, shown on the job row. */
  summary?: LocalizedText;
}

export interface ToolInputSpec {
  /** Accepted extensions, lowercase and dot-prefixed. */
  accept: string[];
  min: number;
  /** `null` means unbounded. */
  max: number | null;
  /** True when input order is meaningful and the UI should offer drag-to-reorder. */
  ordered?: boolean;
}

export type OutputKind =
  /** Exactly one output file. */
  | 'single'
  /** Many outputs; the UI offers "save all" and optional zipping. */
  | 'multiple'
  /** No file output — `data` carries the result (document info, comparison, …). */
  | 'report';

export interface ToolDescriptor {
  /** Stable dotted id, e.g. `organize.merge`. Also the REST route segment. */
  id: string;
  category: CategoryId;
  name: LocalizedText;
  description: LocalizedText;
  /** lucide-react icon name. */
  icon: string;
  /** Extra search terms for ⌘K, in both languages. */
  keywords: string[];
  input: ToolInputSpec;
  output: OutputKind;
  params: ParamSpec[];
  /**
   * `worker` tools run in the worker_thread pool and must stay pure.
   * `main` tools need `ctx.host` and therefore run on the Electron main thread.
   */
  runtime: 'worker' | 'main';
  /** Excluded from pipelines (e.g. report-only tools that produce no file to chain). */
  pipelineable?: boolean;
  run(ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A descriptor without its implementation.
 *
 * This is what the renderer works with. Keeping `run` out of the UI's reach is
 * not just tidiness: the engines behind it (MuPDF's 10 MB WASM binary, pdf-lib)
 * would otherwise be bundled into the renderer for code that only ever executes
 * in a worker thread. The catalogue crosses to the UI as data instead.
 */
export type ToolMeta = Omit<ToolDescriptor, 'run'>;

export function toToolMeta(tool: ToolDescriptor): ToolMeta {
  const { run: _run, ...meta } = tool;
  return meta;
}
