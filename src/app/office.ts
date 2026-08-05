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
 * ONLYOFFICE uiTheme id matching Magies appearance settings.
 *
 * theme-system follows the OS (same as Magies "跟随系统"). Forced light/dark
 * map to the engine's white/night skins so the editor chrome is not a black
 * pane when the shell is light.
 */
export function officeUiThemeFor(
  theme: 'system' | 'light' | 'dark',
  darkMode: boolean,
): 'theme-system' | 'theme-white' | 'theme-night' {
  if (theme === 'system') return 'theme-system';
  return darkMode || theme === 'dark' ? 'theme-night' : 'theme-white';
}
