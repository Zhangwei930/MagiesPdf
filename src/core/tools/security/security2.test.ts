import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeTool } from '../../execute.ts';
import { openDocument, saveDocument } from '../../pdf/document.ts';
import { allPageText, asInput, samplePdf } from '../../testing/fixtures.ts';
import { flattenTool } from './flatten.ts';
import { editMetadataTool, removeMetadataTool } from './metadata.ts';
import {
  countEmbeddedFiles,
  countExternalLinks,
  countJavaScript,
  sanitizeTool,
} from './sanitize.ts';

/** Decorates a clean fixture with active content in every PDF action location we support. */
async function nastyPdf(): Promise<Uint8Array> {
  const doc = openDocument(await samplePdf({ pages: 1, label: () => 'BODY' }));
  try {
    const rootObj = doc.getTrailer().get('Root');

    // Auto-run JavaScript on open.
    const jsAction = doc.newDictionary();
    jsAction.put('S', doc.newName('JavaScript'));
    jsAction.put('JS', doc.newString('app.alert("boo")'));
    rootObj.put('OpenAction', doc.addObject(jsAction));

    const additionalAction = (source: string) => {
      const action = doc.newDictionary();
      action.put('S', doc.newName('JavaScript'));
      action.put('JS', doc.newString(source));
      return doc.addObject(action);
    };

    const rootActions = doc.newDictionary();
    rootActions.put('WC', additionalAction('app.alert("catalog")'));
    rootObj.put('AA', rootActions);

    // A named JavaScript tree entry.
    const namedJs = doc.newDictionary();
    namedJs.put('S', doc.newName('JavaScript'));
    namedJs.put('JS', doc.newString('console.println("hi")'));
    const jsNames = doc.newArray();
    jsNames.push('script1');
    jsNames.push(doc.addObject(namedJs));
    const jsTree = doc.newDictionary();
    jsTree.put('Names', jsNames);

    // An embedded file.
    const payload = doc.addStream('secret payload', {});
    const embedded = doc.newDictionary();
    embedded.put('F', payload);
    const filespec = doc.newDictionary();
    filespec.put('Type', doc.newName('Filespec'));
    filespec.put('F', 'payload.txt');
    filespec.put('EF', embedded);
    const filespecRef = doc.addObject(filespec);
    const efNames = doc.newArray();
    efNames.push('payload.txt');
    efNames.push(filespecRef);
    const efTree = doc.newDictionary();
    efTree.put('Names', efNames);

    const namesDict = doc.newDictionary();
    namesDict.put('JavaScript', jsTree);
    namesDict.put('EmbeddedFiles', efTree);
    rootObj.put('Names', namesDict);
    const associatedFiles = doc.newArray();
    associatedFiles.push(filespecRef);
    rootObj.put('AF', associatedFiles);

    // One external link and one internal-style link annotation.
    const uriAction = doc.newDictionary();
    uriAction.put('S', doc.newName('URI'));
    uriAction.put('URI', 'https://example.com');
    const externalLink = doc.newDictionary();
    externalLink.put('Type', doc.newName('Annot'));
    externalLink.put('Subtype', doc.newName('Link'));
    externalLink.put('Rect', doc.newArray());
    externalLink.put('A', uriAction);

    const internalLink = doc.newDictionary();
    internalLink.put('Type', doc.newName('Annot'));
    internalLink.put('Subtype', doc.newName('Link'));
    internalLink.put('Rect', doc.newArray());
    const annotationActions = doc.newDictionary();
    annotationActions.put('E', additionalAction('app.alert("annotation")'));
    internalLink.put('AA', annotationActions);

    const annots = doc.newArray();
    annots.push(doc.addObject(externalLink));
    annots.push(doc.addObject(internalLink));
    const pageObj = doc.loadPage(0).getObject();
    pageObj.put('Annots', annots);
    const pageActions = doc.newDictionary();
    pageActions.put('O', additionalAction('app.alert("page")'));
    pageObj.put('AA', pageActions);

    const field = doc.newDictionary();
    field.put('FT', doc.newName('Tx'));
    field.put('T', 'unsafe-field');
    const fieldActions = doc.newDictionary();
    fieldActions.put('K', additionalAction('app.alert("field")'));
    field.put('AA', fieldActions);
    const fields = doc.newArray();
    fields.push(doc.addObject(field));
    const acroForm = doc.newDictionary();
    acroForm.put('Fields', fields);
    rootObj.put('AcroForm', acroForm);

    const outlineAction = doc.newDictionary();
    outlineAction.put('S', doc.newName('URI'));
    outlineAction.put('URI', 'https://example.com/outline');
    const outlineItem = doc.newDictionary();
    outlineItem.put('Title', 'external');
    outlineItem.put('A', outlineAction);
    const outlines = doc.newDictionary();
    outlines.put('First', doc.addObject(outlineItem));
    rootObj.put('Outlines', outlines);

    return saveDocument(doc);
  } finally {
    doc.destroy();
  }
}

/** A one-field form with a value, built with pdf-lib. */
async function formPdf(): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('BODY', { x: 48, y: 700, size: 30, font });
  const field = doc.getForm().createTextField('applicant.name');
  field.setText('Zhang Wei');
  field.addToPage(page, { x: 48, y: 500, width: 220, height: 24 });
  return doc.save();
}

function meta(bytes: Uint8Array, key: string): string | undefined {
  const doc = openDocument(bytes);
  try {
    return doc.getMetaData(key);
  } finally {
    doc.destroy();
  }
}

describe('security.edit-metadata', () => {
  it('updates only the filled fields in update mode', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'report.pdf');
    const result = await executeTool(editMetadataTool, {
      files: [input],
      params: { title: 'New Title' },
    });

    assert.equal(meta(result.files[0]!.bytes, 'info:Title'), 'New Title');
    // Producer was set by the fixture and must survive update mode.
    assert.equal(meta(result.files[0]!.bytes, 'info:Producer'), 'MagiesPdf tests');
  });

  it('clears unfilled fields in replace mode', async () => {
    const input = asInput(await samplePdf({ pages: 1 }), 'report.pdf');
    const result = await executeTool(editMetadataTool, {
      files: [input],
      params: { mode: 'replace', author: 'Only Author' },
    });

    assert.equal(meta(result.files[0]!.bytes, 'info:Author'), 'Only Author');
    assert.equal(meta(result.files[0]!.bytes, 'info:Title') ?? '', '');
    assert.equal(meta(result.files[0]!.bytes, 'info:Producer') ?? '', '');
  });
});

describe('security.remove-metadata', () => {
  it('wipes the Info dictionary entirely', async () => {
    const input = asInput(await samplePdf({ pages: 2 }), 'report.pdf');
    assert.equal(meta(input.bytes, 'info:Title'), 'MagiesPdf fixture');

    const result = await executeTool(removeMetadataTool, { files: [input], params: {} });

    for (const key of ['info:Title', 'info:Producer', 'info:CreationDate']) {
      assert.equal(meta(result.files[0]!.bytes, key) ?? '', '', `${key} survived`);
    }
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['Page 1', 'Page 2']);
  });

  it('drops the XMP metadata stream', async () => {
    // Give the fixture an XMP stream first.
    const doc = openDocument(await samplePdf({ pages: 1 }));
    let withXmp: Uint8Array;
    try {
      const xmp = doc.addStream('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', {});
      doc.getTrailer().get('Root').put('Metadata', xmp);
      withXmp = saveDocument(doc);
    } finally {
      doc.destroy();
    }

    const result = await executeTool(removeMetadataTool, {
      files: [asInput(withXmp, 'x.pdf')],
      params: {},
    });

    const cleaned = openDocument(result.files[0]!.bytes);
    try {
      const metadata = cleaned.getTrailer().get('Root').get('Metadata');
      assert.ok(!metadata || metadata.isNull(), 'XMP stream survived');
    } finally {
      cleaned.destroy();
    }
  });
});

describe('sanitize detectors', () => {
  it('count the planted nasties on the fixture', async () => {
    const doc = openDocument(await nastyPdf());
    try {
      assert.equal(countJavaScript(doc), 6, 'javascript');
      assert.equal(countEmbeddedFiles(doc), 1, 'embedded');
      assert.equal(countExternalLinks(doc), 2, 'links');
    } finally {
      doc.destroy();
    }
  });

  it('report zero on a clean document', async () => {
    const doc = openDocument(await samplePdf({ pages: 1 }));
    try {
      assert.equal(countJavaScript(doc), 0);
      assert.equal(countEmbeddedFiles(doc), 0);
      assert.equal(countExternalLinks(doc), 0);
    } finally {
      doc.destroy();
    }
  });
});

describe('security.sanitize', () => {
  it('strips everything by default and keeps the body', async () => {
    const result = await executeTool(sanitizeTool, {
      files: [asInput(await nastyPdf(), 'nasty.pdf')],
      params: {},
    });

    const cleaned = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(countJavaScript(cleaned), 0, 'javascript survived');
      assert.equal(countEmbeddedFiles(cleaned), 0, 'embedded file survived');
      assert.equal(countExternalLinks(cleaned), 0, 'external link survived');
      const rootObj = cleaned.getTrailer().get('Root');
      const openAction = rootObj.get('OpenAction');
      assert.ok(!openAction || openAction.isNull(), 'OpenAction survived');
      assert.ok(rootObj.get('AA').isNull(), 'catalog additional actions survived');
      assert.ok(rootObj.get('AF').isNull(), 'associated files survived');
      assert.ok(cleaned.loadPage(0).getObject().get('AA').isNull(), 'page actions survived');
      const internal = cleaned.loadPage(0).getObject().get('Annots').get(0);
      assert.ok(internal.get('AA').isNull(), 'annotation actions survived');
      const formField = rootObj.get('AcroForm', 'Fields', 0);
      assert.ok(formField.get('AA').isNull(), 'form-field actions survived');
      const outline = rootObj.get('Outlines', 'First');
      assert.ok(outline.get('A').isNull(), 'outline external action survived');
    } finally {
      cleaned.destroy();
    }
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['BODY']);
  });

  it('keeps internal links while removing external ones', async () => {
    const result = await executeTool(sanitizeTool, {
      files: [asInput(await nastyPdf(), 'nasty.pdf')],
      params: { strip: ['externalLinks'] },
    });

    const cleaned = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(countExternalLinks(cleaned), 0);
      // The plain link annotation without an action must survive.
      const annots = cleaned.loadPage(0).getObject().get('Annots');
      assert.equal(annots.length, 1, 'internal link was removed too');
    } finally {
      cleaned.destroy();
    }
  });

  it('leaves scripts alone when only embedded files are stripped', async () => {
    const result = await executeTool(sanitizeTool, {
      files: [asInput(await nastyPdf(), 'nasty.pdf')],
      params: { strip: ['embeddedFiles'] },
    });

    const cleaned = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(countEmbeddedFiles(cleaned), 0);
      assert.ok(countJavaScript(cleaned) > 0, 'scripts should have been kept');
    } finally {
      cleaned.destroy();
    }
  });

  it('reports the removal counts in the summary', async () => {
    const result = await executeTool(sanitizeTool, {
      files: [asInput(await nastyPdf(), 'nasty.pdf')],
      params: {},
    });
    assert.match(result.summary?.zh ?? '', /6 处脚本/);
    assert.match(result.summary?.zh ?? '', /1 个内嵌文件/);
  });
});

describe('security.flatten', () => {
  it('bakes the filled value into page content and removes the field', async () => {
    const input = asInput(await formPdf(), 'form.pdf');
    const result = await executeTool(flattenTool, { files: [input], params: {} });

    const text = allPageText(result.files[0]!.bytes)[0] ?? '';
    assert.ok(text.includes('Zhang Wei'), `value lost: ${text}`);
    assert.ok(text.includes('BODY'));

    const flat = openDocument(result.files[0]!.bytes);
    try {
      assert.equal(flat.loadPage(0).getWidgets().length, 0, 'widget survived');
    } finally {
      flat.destroy();
    }
  });

  it('reports the field count', async () => {
    const result = await executeTool(flattenTool, {
      files: [asInput(await formPdf(), 'form.pdf')],
      params: {},
    });
    assert.match(result.summary?.zh ?? '', /1 个表单域/);
  });

  it('passes a form-free document through gracefully', async () => {
    const result = await executeTool(flattenTool, {
      files: [asInput(await samplePdf({ pages: 1, label: () => 'X' }), 'x.pdf')],
      params: {},
    });
    assert.deepEqual(allPageText(result.files[0]!.bytes), ['X']);
    assert.match(result.summary?.zh ?? '', /没有表单域/);
  });
});
