const OFFICE_EXTENSIONS = new Set([
  '.doc',
  '.docx',
  '.odt',
  '.rtf',
  '.xls',
  '.xlsx',
  '.ods',
  '.ppt',
  '.pptx',
  '.odp',
]);

function extensionOf(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > separator ? path.slice(dot).toLowerCase() : '';
}

export function partitionDocumentPaths(paths: readonly string[]): {
  pdf: string[];
  office: string[];
  unsupported: string[];
} {
  const result = { pdf: [] as string[], office: [] as string[], unsupported: [] as string[] };
  for (const path of paths) {
    const extension = extensionOf(path);
    if (extension === '.pdf') result.pdf.push(path);
    else if (OFFICE_EXTENSIONS.has(extension)) result.office.push(path);
    else result.unsupported.push(path);
  }
  return result;
}

/**
 * ONLYOFFICE uiTheme for the embedded editor.
 *
 * Always white/light for now: dark chrome + dark document canvas made body
 * text unreadable (black on black). Magies shell theme is independent.
 */
export function officeUiThemeFor(
  _theme: 'system' | 'light' | 'dark',
  _darkMode: boolean,
): 'theme-system' | 'theme-white' | 'theme-night' {
  return 'theme-white';
}
