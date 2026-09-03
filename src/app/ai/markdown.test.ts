import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { renderAssistantMarkdown } from './markdown.ts';

describe('renderAssistantMarkdown', () => {
  it('renders the markdown an answer is actually made of', () => {
    const html = renderAssistantMarkdown('## Title\n\n- one\n- two\n\n**bold** and `code`');
    assert.match(html, /<h2>Title<\/h2>/);
    assert.match(html, /<li>one<\/li>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
  });

  it('escapes a block of raw HTML instead of adopting it', () => {
    const html = renderAssistantMarkdown('<iframe src="http://127.0.0.1:9/x"></iframe>');
    assert.doesNotMatch(html, /<iframe/);
    assert.match(html, /&lt;iframe/);
  });

  it('escapes inline HTML, leaving an event handler as text that cannot be an attribute', () => {
    const html = renderAssistantMarkdown('see <img src=x onerror="steal()"> here');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
    // The handler survives as the words the model wrote; what it cannot do is
    // close the quote it would need to become an attribute.
    assert.match(html, /onerror=&quot;steal\(\)&quot;/);
  });

  it('escapes a <style> block, which needs no script to repaint the pane', () => {
    const html = renderAssistantMarkdown('<style>body{display:none}</style>');
    assert.doesNotMatch(html, /<style/);
    assert.match(html, /&lt;style/);
  });

  it('keeps an http link and marks it to open outside the window', () => {
    const html = renderAssistantMarkdown('[docs](https://example.com/a)');
    assert.match(html, /<a href="https:\/\/example\.com\/a"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
  });

  it('drops the href of a link the shell must never be handed', () => {
    for (const href of ['javascript:steal()', 'file:///etc/passwd', 'smb://host/share']) {
      const html = renderAssistantMarkdown(`[click](${href})`);
      assert.doesNotMatch(html, /<a /);
      assert.match(html, /click/);
    }
  });

  it('keeps a mailto link, which the shell may open', () => {
    const html = renderAssistantMarkdown('[write](mailto:someone@example.com)');
    assert.match(html, /<a href="mailto:someone@example\.com"/);
  });

  it('drops an image the page could not load anyway, keeping its alt text', () => {
    const html = renderAssistantMarkdown('![a map](file:///secret.png)');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /a map/);
  });

  it('keeps a data-uri image, which the page policy already allows', () => {
    const html = renderAssistantMarkdown('![dot](data:image/png;base64,iVBORw0KGgo=)');
    assert.match(html, /<img src="data:image\/png;base64,iVBORw0KGgo="/);
  });

  it('renders nothing for nothing', () => {
    assert.equal(renderAssistantMarkdown(''), '');
  });

  it('escapes the HTML a fenced code block is showing the user', () => {
    const html = renderAssistantMarkdown('```html\n<img src=x onerror=1>\n```');
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  });
});
