const characters = (...codes) => String.fromCharCode(...codes);

const upstreamProduct = characters(104, 97, 112, 112, 121);
const upstreamProductTitle = `${upstreamProduct[0].toUpperCase()}${upstreamProduct.slice(1)}`;
const retiredMarkers = [
  characters(115, 108, 111, 112, 117, 115),
  characters(104, 97, 110, 100, 121, 45, 115, 101, 114, 118, 101, 114),
];

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const adjacentIdentifierCharacter = /[A-Za-z0-9_-]/;

function addExactRanges(source, literal, ranges) {
  let offset = 0;
  while (offset <= source.length - literal.length) {
    const index = source.indexOf(literal, offset);
    if (index === -1) break;

    const end = index + literal.length;
    const before = index > 0 ? source[index - 1] : '';
    const after = end < source.length ? source[end] : '';
    if (!adjacentIdentifierCharacter.test(before) && !adjacentIdentifierCharacter.test(after)) {
      ranges.push({ start: index, end });
    }
    offset = index + 1;
  }
}

function addPatternRanges(source, pattern, ranges) {
  for (const match of source.matchAll(pattern)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
}

function reviewedRanges(source) {
  const ranges = [];
  const approvedLiterals = [
    `X-${upstreamProductTitle}-Client`,
    `${upstreamProduct}Client`,
    `__${upstreamProduct.toUpperCase()}_CONFIG__`,
    `${upstreamProductTitle} EnCoder`,
    `${upstreamProductTitle} Blobs`,
    `(?:${upstreamProduct}|idle|sessions)`,
  ];

  for (const literal of approvedLiterals) addExactRanges(source, literal, ranges);

  const optionalQuote = '(?:\\\\?["\'])?';
  const propertyBoundary = '(?:^|[,{;])\\s*';
  const numericValue = '\\s*:\\s*\\d+';
  const product = escapeRegExp(upstreamProduct);

  addPatternRanges(
    source,
    new RegExp(
      `${propertyBoundary}${optionalQuote}${product}(?:-(?:outline|sharp))?${optionalQuote}${numericValue}`,
      'gm',
    ),
    ranges,
  );
  addPatternRanges(
    source,
    new RegExp(
      `${propertyBoundary}${optionalQuote}(?:emoticon|robot)-${product}(?:-outline)?${optionalQuote}${numericValue}`,
      'gm',
    ),
    ranges,
  );

  return ranges;
}

export function findUnexpectedUpstreamMarkers(source) {
  const ranges = reviewedRanges(source);
  const markers = [upstreamProduct, ...retiredMarkers];
  const findings = [];

  for (const marker of markers) {
    const normalizedSource = source.toLowerCase();
    const normalizedMarker = marker.toLowerCase();
    let offset = 0;

    while (offset <= normalizedSource.length - normalizedMarker.length) {
      const index = normalizedSource.indexOf(normalizedMarker, offset);
      if (index === -1) break;
      const end = index + marker.length;
      if (!ranges.some(range => range.start <= index && end <= range.end)) {
        findings.push({ index, length: marker.length });
      }
      offset = index + 1;
    }
  }

  return findings.sort((left, right) => left.index - right.index);
}
