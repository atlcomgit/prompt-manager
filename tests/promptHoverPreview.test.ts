import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPromptHoverPosition, isSamePromptHoverTarget, isCurrentPromptHoverResponse, hasPromptHoverAnchorMoved,
} from '../src/utils/promptHoverPreview.js';
import { renderPromptHoverMarkdown } from '../src/webview/sidebar/promptHoverMarkdown.js';

/** Все части identity участвуют в выборе ответа; совпадение имени само по себе недостаточно. */
test('hover identity includes folder UUID and archive scope', () => {
  const target = { id: 'same', promptUuid: 'uuid', archived: false };
  assert.equal(isSamePromptHoverTarget(target, { ...target }), true);
  for (const patch of [{ id: 'renamed' }, { promptUuid: 'new' }, { archived: true }]) {
    assert.equal(isSamePromptHoverTarget(target, { ...target, ...patch }), false);
  }
});

/** Поздние ответы закрытого запроса, другого наведения или старой папки не принимаются. */
test('hover responses require a live request and matching identity', () => {
  const active = { requestId: 'current', target: { id: 'task', promptUuid: 'uuid', archived: false } };
  assert.equal(isCurrentPromptHoverResponse(active, active), true);
  assert.equal(isCurrentPromptHoverResponse(null, active), false);
  assert.equal(isCurrentPromptHoverResponse(active, { ...active, requestId: 'older' }), false);
  assert.equal(isCurrentPromptHoverResponse(active, {
    ...active, target: { ...active.target, promptUuid: 'replaced' },
  }), false);
});

/** Отложенный scroll после focus не равен новому перемещению строки. */
test('queued focus scroll keeps preview while actual anchor movement closes it', () => {
  const captured = { left: 0, top: 400, bottom: 450 };
  assert.equal(hasPromptHoverAnchorMoved(captured, { ...captured }), false);
  assert.equal(hasPromptHoverAnchorMoved(captured, { ...captured, top: 380, bottom: 430 }), true);
  assert.equal(hasPromptHoverAnchorMoved(captured, { ...captured, left: 8 }), true);
});

/** Верх, низ, узкая и низкая панель не выводят карточку за viewport. */
test('hover placement stays inside narrow and short viewports', () => {
  for (const [width, height] of [[300, 600], [180, 150], [900, 800]]) {
    for (const top of [0, height / 2, height - 20]) {
      const p = getPromptHoverPosition({ left: width - 40, top, bottom: top + 20 }, width, height, 300);
      assert.ok(p.left >= 0 && p.left + p.width <= width);
      assert.ok(p.top >= 0 && p.top + Math.min(300, p.maxHeight) <= height);
      assert.ok(p.maxHeight > 0);
    }
  }
  const above = getPromptHoverPosition({ left: 0, top: 550, bottom: 580 }, 300, 600, 200);
  assert.ok(above.top + 200 < 550);
});

/** Пользовательский Markdown форматируется полностью и не создаёт загрузок, переходов и исполняемого HTML. */
test('hover Markdown renders full content without executable HTML links or images', () => {
  const content = '# Заголовок\n\n- список\n\n```ts\nconst x = 1;\n```\n\n'
    + '<script>alert(1)</script>\n\n[Ссылка](https://example.test) ![Картинка](https://example.test/image.png)\n\n'
    + '[Опасно](javascript:alert(1))\n\n' + 'длинный текст '.repeat(5000) + 'КОНЕЦ';
  const html = renderPromptHoverMarkdown(content);
  assert.match(html, /<h1>Заголовок<\/h1>/);
  assert.match(html, /<li>список<\/li>/);
  assert.match(html, /<pre><code class="language-ts">/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /КОНЕЦ/);
  assert.doesNotMatch(html, /<script|<img|<a\b|\shref=|\ssrc=/);
});
