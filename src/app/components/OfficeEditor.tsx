import { useEffect, useRef } from 'react';
import type { DocumentState } from '../documents.ts';

interface OfficeEditorProps {
  document: DocumentState;
  /** Called when the engine reports the document has unsaved changes. */
  onModifiedChange(modified: boolean): void;
  /** Bumped when the shell wants this document saved; the engine is asked. */
  saveRequestedAt: number;
  /**
   * What the engine's file menu asks the host for. The engine only asks —
   * what a new document, a picker or another name mean belongs to the shell.
   */
  onRequest(what: 'createNew' | 'open' | 'saveAs'): void;
}

/**
 * The embedded Office editor.
 *
 * This is a frame onto an engine running in the main process, not a component
 * that renders a document. Everything inside the frame — layout, typing, undo,
 * the ribbon — belongs to the engine; what happens here is limited to pointing
 * the frame at the right session and listening for what the engine reports back.
 *
 * The frame is deliberately not remounted when the tab is hidden. Reloading it
 * would throw away the document's edit history along with the page it is
 * showing, so the shell keeps every open editor alive and only changes which
 * one is visible.
 */
export function OfficeEditor({ document: doc, onModifiedChange, onRequest, saveRequestedAt }: OfficeEditorProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = doc.editor;

  useEffect(() => {
    if (!session) return undefined;

    /**
     * The engine talks to its host by posting messages out of the frame. Only
     * messages from this frame are believed: anything else on the window is
     * some other page's business.
     */
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { magies?: string; modified?: boolean } | null;
      if (!data) return;

      if (data.magies === 'modified') {
        onModifiedChange(Boolean(data.modified));
        return;
      }
      if (data.magies === 'requestCreateNew') onRequest('createNew');
      else if (data.magies === 'requestOpen') onRequest('open');
      else if (data.magies === 'requestSaveAs') onRequest('saveAs');
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session, onModifiedChange, onRequest]);

  useEffect(() => {
    if (!saveRequestedAt) return;
    // The engine will post the document to the main process itself; nothing
    // comes back through here.
    frame.current?.contentWindow?.postMessage({ magies: 'save' }, '*');
  }, [saveRequestedAt]);

  if (!session) return null;

  return (
    <iframe
      ref={frame}
      // Keyed by session so switching between two open documents swaps frames
      // rather than navigating one, which would discard the other's state.
      key={session.sessionId}
      src={session.url}
      title={doc.name}
      className="h-full w-full border-0"
      // The engine is local and needs its own scripts, workers and fonts; it is
      // served from loopback by the main process, not from the network.
      sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
    />
  );
}
