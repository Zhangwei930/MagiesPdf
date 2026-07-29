/**
 * Keyboard shortcuts, as a pure mapping from a key press to an intent.
 *
 * The point of keeping this out of the components is that shortcuts are the
 * part of an app people learn by muscle memory, so they have to be exhaustive
 * and consistent — which is only checkable if the mapping can be tested without
 * a DOM. The component's job is to dispatch what comes back from here.
 */

export type ShortcutAction =
  | 'open'
  | 'save'
  | 'saveAs'
  | 'close'
  | 'undo'
  | 'redo'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'fitWidth'
  | 'fitPage'
  | 'nextPage'
  | 'prevPage'
  | 'firstPage'
  | 'lastPage'
  | 'palette'
  | 'dismiss';

/** The parts of a KeyboardEvent a shortcut is decided from. */
export interface KeyChord {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export type ShortcutPlatform = 'mac' | 'other';

/**
 * `typing` means focus is in a text field. Unmodified keys belong to the field
 * then — PageDown moves a caret, and ⌘Z undoes what was typed rather than the
 * document. Escape is the exception: it is how you get back out.
 */
export interface ShortcutContext {
  typing?: boolean;
}

/** ⌘ on macOS, Ctrl everywhere else — and never both. */
function hasPlatformModifier(chord: KeyChord, platform: ShortcutPlatform): boolean {
  return platform === 'mac'
    ? chord.metaKey && !chord.ctrlKey
    : chord.ctrlKey && !chord.metaKey;
}

export function matchShortcut(
  chord: KeyChord,
  platform: ShortcutPlatform,
  context: ShortcutContext = {},
): ShortcutAction | null {
  const key = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;

  if (key === 'Escape') return 'dismiss';

  if (hasPlatformModifier(chord, platform)) {
    if (chord.altKey) return null;

    switch (key) {
      case 'o':
        return 'open';
      case 's':
        return chord.shiftKey ? 'saveAs' : 'save';
      case 'w':
        return 'close';
      case 'k':
        return 'palette';
      // A text field owns its own undo stack while it has focus.
      case 'z':
        if (context.typing) return null;
        return chord.shiftKey ? 'redo' : 'undo';
      case 'y':
        return context.typing ? null : 'redo';
      case '0':
        return 'zoomReset';
      case '1':
        return 'fitWidth';
      case '2':
        return 'fitPage';
      default:
        break;
    }

    // `⌘+` needs shift on most layouts, so it arrives as `=` or `+` depending
    // on the keyboard; the numeric keypad reports something else again.
    if (key === '=' || key === '+' || chord.code === 'NumpadAdd') return 'zoomIn';
    if (key === '-' || key === '_' || chord.code === 'NumpadSubtract') return 'zoomOut';
    return null;
  }

  // Everything below is unmodified, so it belongs to a focused field first.
  if (context.typing || chord.metaKey || chord.ctrlKey || chord.altKey) return null;

  switch (key) {
    case 'PageDown':
      return 'nextPage';
    case 'PageUp':
      return 'prevPage';
    case 'Home':
      return 'firstPage';
    case 'End':
      return 'lastPage';
    default:
      return null;
  }
}

/** Whether the event's target is somewhere text is being entered. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function currentPlatform(): ShortcutPlatform {
  return navigator.platform.toLowerCase().includes('mac') ? 'mac' : 'other';
}
