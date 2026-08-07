'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { blocksFromMarkdown, slidesFromMarkdown } = require('./markdownDocument.cjs');

describe('slidesFromMarkdown', () => {
  it('turns an outline into a cover, sections and content slides', () => {
    const slides = slidesFromMarkdown([
      '# 2026 Q1 复盘',
      '数据截至 3 月 31 日',
      '',
      '# 一、收入',
      '',
      '## 同比增长 12%',
      '- 华东贡献 42%',
      '- 续约率 91%',
    ].join('\n'));

    assert.deepEqual(slides.map((slide) => slide.layout), ['title', 'section', 'bullets']);
    assert.equal(slides[0].title, '2026 Q1 复盘');
    // Loose text under the cover heading is its subtitle, not a bullet.
    assert.equal(slides[0].subtitle, '数据截至 3 月 31 日');
    assert.deepEqual(slides[2].body, ['华东贡献 42%', '续约率 91%']);
  });

  it('reads a numbered list as a process rather than another bullet list', () => {
    const [slide] = slidesFromMarkdown('## 下季度动作\n1. 复盘定价\n2. 扩华南团队');
    assert.equal(slide.layout, 'steps');
    assert.deepEqual(slide.body, ['复盘定价', '扩华南团队']);
  });

  it('builds chart and kpi slides from fenced data', () => {
    const slides = slidesFromMarkdown([
      '## 分区域收入',
      '```chart',
      '{"type":"column","categories":["华东","华南"],"series":[{"name":"收入","values":[124,86]}]}',
      '```',
      '',
      '## 关键指标',
      '```kpi',
      '+12% | 收入同比',
      '91% | 续约率',
      '```',
    ].join('\n'));

    const chart = slides.find((slide) => slide.layout === 'chart');
    assert.equal(chart.title, '分区域收入');
    assert.equal(chart.chart_type, 'column');
    assert.deepEqual(chart.categories, ['华东', '华南']);
    assert.deepEqual(chart.series[0].values, [124, 86]);

    const kpi = slides.find((slide) => slide.layout === 'kpi');
    assert.deepEqual(kpi.kpis, [
      { value: '+12%', label: '收入同比' },
      { value: '91%', label: '续约率' },
    ]);
  });

  it('makes quote and image slides, and honours an explicit break', () => {
    const slides = slidesFromMarkdown([
      '## 声音',
      '> 增长来自续约',
      '> 销售负责人',
      '---',
      '## 趋势',
      '![季度趋势](charts/trend.png)',
    ].join('\n'));

    const quote = slides.find((slide) => slide.layout === 'quote');
    assert.equal(quote.title, '增长来自续约');
    assert.deepEqual(quote.body, ['销售负责人']);

    const picture = slides.find((slide) => slide.layout === 'image');
    assert.equal(picture.image_path, 'charts/trend.png');
    assert.equal(picture.title, '趋势');
  });

  it('drops inline marks and never throws on odd input', () => {
    const [slide] = slidesFromMarkdown('## **收入** `Q1`\n- 增长 **12%**');
    assert.equal(slide.title, '收入 Q1');
    assert.deepEqual(slide.body, ['增长 12%']);
    assert.deepEqual(slidesFromMarkdown(''), []);
    assert.deepEqual(slidesFromMarkdown('```chart\nnot json\n```'), []);
  });
});

describe('blocksFromMarkdown', () => {
  it('maps headings onto the real paragraph styles', () => {
    // List items carry the level they were written at; everything else has
    // no level to carry.
    const shape = (blocks) => blocks.map(({ style, text }) => ({ style, text }));
    const blocks = blocksFromMarkdown([
      '# 季度报告',
      '本季度收入增长 12%。',
      '## 一、收入',
      '### 华东',
      '- 贡献 42%',
      '1. 复盘定价',
      '> 增长来自续约',
    ].join('\n'));

    assert.deepEqual(shape(blocks), [
      { style: 'title', text: '季度报告' },
      { style: 'body', text: '本季度收入增长 12%。' },
      { style: 'heading2', text: '一、收入' },
      { style: 'heading3', text: '华东' },
      { style: 'bullet', text: '贡献 42%' },
      { style: 'number', text: '复盘定价' },
      { style: 'quote', text: '增长来自续约' },
    ]);
  });

  it('keeps a nested outline nested', () => {
    // An outline flattened to one level is not the outline the author wrote.
    // Sub-points become peers of the points they belong to, which is the one
    // thing a reader takes from the indentation.
    const blocks = blocksFromMarkdown([
      '- 增长',
      '  - 企业版',
      '  - 渠道',
      '    - 华东',
      '- 成本',
    ].join('\n'));
    assert.deepEqual(blocks.map((block) => [block.style, block.level ?? 0, block.text]), [
      ['bullet', 0, '增长'],
      ['bullet', 1, '企业版'],
      ['bullet', 1, '渠道'],
      ['bullet', 2, '华东'],
      ['bullet', 0, '成本'],
    ]);
  });

  it('reads nesting from the shape of the indentation, not a fixed width', () => {
    // Two spaces and four spaces are both ordinary Markdown, and a model will
    // use either. Counting spaces would make one of them wrong.
    const wide = blocksFromMarkdown(['1. 一', '    1. 一之一', '2. 二'].join('\n'));
    assert.deepEqual(wide.map((block) => [block.style, block.level ?? 0]), [
      ['number', 0], ['number', 1], ['number', 0],
    ]);
    // Coming back out lands on the level it left, not on a new one.
    const back = blocksFromMarkdown(['- a', '   - b', '- c', '   - d'].join('\n'));
    assert.deepEqual(back.map((block) => block.level ?? 0), [0, 1, 0, 1]);
  });

  it('treats a second top-level heading as a heading, not a second title', () => {
    const blocks = blocksFromMarkdown('# One\n# Two');
    assert.deepEqual(blocks.map((block) => block.style), ['title', 'heading1']);
  });

  it('returns nothing for nothing', () => {
    assert.deepEqual(blocksFromMarkdown(''), []);
    assert.deepEqual(blocksFromMarkdown('---\n\n'), []);
  });
});
