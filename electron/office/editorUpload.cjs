/**
 * Reassembling a document the engine sends back.
 *
 * Saving from the editor is an upload. Asking the engine to produce its
 * current document makes it POST that document to the host in chunks, tagged
 * with where in the sequence each one falls. Getting those boundaries wrong
 * gives a file that is quietly truncated, or one save spliced into another —
 * both of which look like a successful save until the document is reopened.
 */

/** The engine's own sequence markers. */
const SAVE_TYPE = Object.freeze({
  PartStart: 0,
  Part: 1,
  Complete: 2,
  CompleteAll: 3,
});

/** A document arriving from an editor is one document; this is a generous cap. */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

function createUploadBuffer({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  let parts = [];
  let held = 0;

  return {
    /**
     * Takes one chunk. Returns the whole document once it is complete, and
     * null while there is more to come.
     */
    accept(command, chunk) {
      const savetype = command?.savetype;
      // A new document beginning discards whatever came before: the previous
      // save either finished or was abandoned, and mixing them silently
      // produces a corrupt file.
      if (savetype === SAVE_TYPE.PartStart || savetype === SAVE_TYPE.CompleteAll) {
        parts = [];
        held = 0;
      }

      held += chunk.length;
      if (held > maxBytes) {
        parts = [];
        held = 0;
        throw new Error('The document sent back by the editor is too large');
      }
      parts.push(chunk);

      if (savetype !== SAVE_TYPE.Complete && savetype !== SAVE_TYPE.CompleteAll) return null;

      const document = Buffer.concat(parts);
      parts = [];
      held = 0;
      return document;
    },
  };
}

module.exports = { SAVE_TYPE, createUploadBuffer };
