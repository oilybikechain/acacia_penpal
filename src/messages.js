function* textChunks(text, start = 0) {
  while (start < text.length) {
    let end = Math.min(start + 3800, text.length);
    // Keep UTF-16 surrogate pairs together when a boundary falls inside an emoji.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield { text: text.slice(start, end), end };
    start = end;
  }
}

module.exports = { textChunks };
