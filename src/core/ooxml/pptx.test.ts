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
