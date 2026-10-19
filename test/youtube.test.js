const test = require('node:test');
const assert = require('node:assert');
const { parseId } = require('../js/youtube.js');

test('parses common YouTube link formats', () => {
  const id = 'dQw4w9WgXcQ';
  for (const link of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc123&t=10`,
    `youtu.be/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `  ${id}  `,
  ]) {
    assert.strictEqual(parseId(link), id, link);
  }
});

test('rejects non-YouTube or malformed links', () => {
  for (const bad of ['', 'hello', 'https://vimeo.com/123456', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@channel']) {
    assert.strictEqual(parseId(bad), null, bad);
  }
});
