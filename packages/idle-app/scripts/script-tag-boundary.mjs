function isHtmlWhitespace(character) {
  return character === ' '
    || character === '\t'
    || character === '\n'
    || character === '\r'
    || character === '\f';
}

function openingTagEnd(html, start) {
  let quote = null;
  for (let cursor = start; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return cursor + 1;
  }
  return null;
}

function openingTagMetadata(html, start, end) {
  const metadata = { hasSource: false, isModule: false };
  let cursor = start + '<script'.length;
  while (cursor < end - 1) {
    while (cursor < end - 1 && (isHtmlWhitespace(html[cursor]) || html[cursor] === '/')) cursor += 1;
    const nameStart = cursor;
    while (
      cursor < end - 1
      && !isHtmlWhitespace(html[cursor])
      && html[cursor] !== '='
      && html[cursor] !== '>'
      && html[cursor] !== '/'
    ) cursor += 1;
    if (cursor === nameStart) {
      cursor += 1;
      continue;
    }
    const name = html.slice(nameStart, cursor).toLowerCase();

    while (cursor < end - 1 && isHtmlWhitespace(html[cursor])) cursor += 1;
    if (html[cursor] !== '=') continue;
    cursor += 1;
    while (cursor < end - 1 && isHtmlWhitespace(html[cursor])) cursor += 1;
    const quote = html[cursor] === '"' || html[cursor] === "'" ? html[cursor] : null;
    const valueStart = quote ? cursor + 1 : cursor;
    if (quote) {
      cursor += 1;
      while (cursor < end - 1 && html[cursor] !== quote) cursor += 1;
    } else {
      while (cursor < end - 1 && !isHtmlWhitespace(html[cursor]) && html[cursor] !== '>') cursor += 1;
    }
    const value = html.slice(valueStart, cursor);
    if (name === 'src' && value.length > 0) metadata.hasSource = true;
    if (name === 'type' && value.toLowerCase() === 'module') metadata.isModule = true;
    if (quote && html[cursor] === quote) cursor += 1;
  }
  return metadata;
}

function closingTagEnd(lowerHtml, start) {
  let cursor = start + '</script'.length;
  if (cursor >= lowerHtml.length || (!isHtmlWhitespace(lowerHtml[cursor]) && lowerHtml[cursor] !== '>')) {
    return null;
  }
  while (cursor < lowerHtml.length && isHtmlWhitespace(lowerHtml[cursor])) cursor += 1;
  return lowerHtml[cursor] === '>' ? cursor + 1 : null;
}

export function inspectScriptTags(html) {
  const lowerHtml = html.toLowerCase();
  const tags = [];
  let cursor = 0;

  while (cursor < html.length) {
    const start = lowerHtml.indexOf('<script', cursor);
    if (start === -1) break;
    const nameBoundary = lowerHtml[start + '<script'.length];
    if (nameBoundary !== '>' && nameBoundary !== '/' && !isHtmlWhitespace(nameBoundary)) {
      cursor = start + '<script'.length;
      continue;
    }

    const openEnd = openingTagEnd(html, start);
    if (openEnd === null) return { valid: false, tags };
    let closeStart = lowerHtml.indexOf('</script', openEnd);
    let closeEnd = null;
    while (closeStart !== -1) {
      closeEnd = closingTagEnd(lowerHtml, closeStart);
      if (closeEnd !== null) break;
      closeStart = lowerHtml.indexOf('</script', closeStart + 1);
    }
    if (closeStart === -1 || closeEnd === null) return { valid: false, tags };

    tags.push(openingTagMetadata(html, start, openEnd));
    cursor = closeEnd;
  }

  return { valid: true, tags };
}
