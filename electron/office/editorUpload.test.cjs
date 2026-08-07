const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { SAVE_TYPE, createUploadBuffer } = require('./editorUpload.cjs');

/**
 * Saving from the editor is an upload, not a download.
 *
 * `downloadAs('bin')` makes the engine POST its current document back in
 * chunks; the host reassembles them. Getting the boundaries wrong produces a
 * file that is silently truncated or has another save spliced into it, so the
 * assembly is a unit rather than something inlined in a request handler.
 */

describe('assembling an upload', () => {
  it('takes a document that arrives in one piece', () => {
    const buffer = createUploadBuffer();
    const done = buffer.accept({ savetype: SAVE_TYPE.CompleteAll }, Buffer.from('DOCY;all'));
    assert.equal(done?.toString(), 'DOCY;all');
  });

  it('joins the parts of one that arrives in several', () => {
    const buffer = createUploadBuffer();
    assert.equal(buffer.accept({ savetype: SAVE_TYPE.PartStart }, Buffer.from('DOCY;')), null);
    assert.equal(buffer.accept({ savetype: SAVE_TYPE.Part }, Buffer.from('mid')), null);

    const done = buffer.accept({ savetype: SAVE_TYPE.Complete }, Buffer.from('end'));
    assert.equal(done?.toString(), 'DOCY;midend');
  });

  /** A save that begins while another is arriving must not splice into it. */
  it('starts over when a new document begins', () => {
    const buffer = createUploadBuffer();
    buffer.accept({ savetype: SAVE_TYPE.PartStart }, Buffer.from('stale'));

    buffer.accept({ savetype: SAVE_TYPE.PartStart }, Buffer.from('fresh'));
    const done = buffer.accept({ savetype: SAVE_TYPE.Complete }, Buffer.from('!'));

    assert.equal(done?.toString(), 'fresh!');
  });

  it('is empty again once a document has been taken', () => {
    const buffer = createUploadBuffer();
    buffer.accept({ savetype: SAVE_TYPE.CompleteAll }, Buffer.from('one'));

    const second = buffer.accept({ savetype: SAVE_TYPE.CompleteAll }, Buffer.from('two'));
    assert.equal(second?.toString(), 'two', 'the first document must not be carried over');
  });

  /** An unknown savetype is not a reason to lose what has already arrived. */
  it('treats an unrecognised chunk as another part', () => {
    const buffer = createUploadBuffer();
    buffer.accept({ savetype: SAVE_TYPE.PartStart }, Buffer.from('a'));
    assert.equal(buffer.accept({ savetype: 99 }, Buffer.from('b')), null);
    assert.equal(buffer.accept({ savetype: SAVE_TYPE.Complete }, Buffer.from('c'))?.toString(), 'abc');
  });

  it('refuses to grow without bound', () => {
    const buffer = createUploadBuffer({ maxBytes: 8 });
    buffer.accept({ savetype: SAVE_TYPE.PartStart }, Buffer.alloc(6));
    assert.throws(() => buffer.accept({ savetype: SAVE_TYPE.Part }, Buffer.alloc(6)), /too large/i);
  });
});
