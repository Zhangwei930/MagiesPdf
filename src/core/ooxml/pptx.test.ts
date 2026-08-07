import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractPptxSlideTexts,
  extractTextFromSlideXml,
  slidesToPptx,
} from './pptx.ts';
import { zipRead } from './zip.ts';

describe('extractTextFromSlideXml', () => {
  it('joins a:t runs', () => {
    const xml = '<a:t>Hello</a:t><a:t> </a:t><a:t>World</a:t>';
    assert.equal(extractTextFromSlideXml(xml), 'Hello World');
  });

  it('decodes XML entities', () => {
    assert.equal(extractTextFromSlideXml('<a:t>A&amp;B</a:t>'), 'A&B');
  });
});

describe('slidesToPptx + extractPptxSlideTexts', () => {
  it('round-trips slide text through a minimal package', () => {
    const bytes = slidesToPptx([
      { title: 'Intro', body: ['Line one', 'Line two'] },
      { title: 'Next', body: ['Body'] },
    ]);

    assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4b]);
    const files = zipRead(bytes);
    assert.ok(files.has('ppt/slides/slide1.xml'));
    assert.ok(files.has('ppt/slides/slide2.xml'));

    const texts = extractPptxSlideTexts(bytes);
    assert.equal(texts.length, 2);
    assert.ok(texts[0]?.includes('Intro'));
    assert.ok(texts[0]?.includes('Line one'));
    assert.ok(texts[1]?.includes('Next'));
  });
});

describe('the theme a presentation needs to be openable', () => {
  const parts = () => zipRead(slidesToPptx([{ title: 'A', body: ['b'] }]));
  const text = (name: string) => new TextDecoder().decode(parts().get(name)!);

  /**
   * A presentation without a theme is not merely plain — editors refuse to open
   * it. The slide master resolves its colours, fonts and formats through the
   * theme, and with nothing there the load fails rather than falling back.
   */
  it('includes a theme part', () => {
    assert.ok(parts().has('ppt/theme/theme1.xml'), 'no theme in the package');
  });

  it('declares the theme so the package is valid', () => {
    assert.match(text('[Content_Types].xml'), /theme\+xml/);
  });

  it('has the slide master point at it', () => {
    const rels = text('ppt/slideMasters/_rels/slideMaster1.xml.rels');
    assert.match(rels, /theme/);
    assert.match(rels, /theme1\.xml/);
  });

  /** The colour scheme is what the master's placeholders actually reference. */
  it('gives the theme a colour and font scheme', () => {
    const theme = text('ppt/theme/theme1.xml');
    assert.match(theme, /<a:clrScheme/);
    assert.match(theme, /<a:fontScheme/);
    assert.match(theme, /<a:fmtScheme/);
  });
});
