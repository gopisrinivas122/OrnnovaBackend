const fs = require('fs');
const path = require('path');

function pdfTitleToken(title) {
  const text = String(title);
  const needsUnicode = Array.from(text).some((char) => char.codePointAt(0) > 255);
  if (!needsUnicode) {
    const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    return `(${escaped})`;
  }

  const bytes = [0xFE, 0xFF];
  Array.from(text).forEach((char) => {
    const codePoint = char.codePointAt(0);
    if (codePoint > 0xFFFF) {
      const value = codePoint - 0x10000;
      const high = 0xD800 + (value >> 10);
      const low = 0xDC00 + (value & 0x3FF);
      bytes.push((high >> 8) & 0xFF, high & 0xFF, (low >> 8) & 0xFF, low & 0xFF);
      return;
    }
    bytes.push((codePoint >> 8) & 0xFF, codePoint & 0xFF);
  });
  return `<${Buffer.from(bytes).toString('hex').toUpperCase()}>`;
}

function readDict(text) {
  const start = text.indexOf('<<');
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < text.length - 1; index += 1) {
    if (text[index] === '<' && text[index + 1] === '<') {
      depth += 1;
      index += 1;
      continue;
    }
    if (text[index] === '>' && text[index + 1] === '>') {
      depth -= 1;
      index += 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function matchValue(dict, pattern) {
  const match = pattern.exec(dict || '');
  return match ? match[1] : null;
}

function parseSectionAt(buffer, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= buffer.length) return null;
  const text = buffer.slice(offset, Math.min(buffer.length, offset + 30000)).toString('latin1');
  let dictSource = text;
  if (text.startsWith('xref')) {
    const trailerAt = text.indexOf('trailer');
    if (trailerAt < 0) return null;
    dictSource = text.slice(trailerAt + 'trailer'.length);
  } else {
    const objectHeader = text.match(/^\d+\s+\d+\s+obj\s*/);
    if (!objectHeader) return null;
    dictSource = text.slice(objectHeader[0].length);
  }

  const dict = readDict(dictSource);
  if (!dict) return null;
  return {
    dict,
    root: matchValue(dict, /\/Root\s+(\d+\s+\d+\s+R)/),
    size: Number(matchValue(dict, /\/Size\s+(\d+)/)),
    prev: matchValue(dict, /\/Prev\s+(\d+)/),
    info: matchValue(dict, /\/Info\s+(\d+\s+\d+\s+R)/),
    id: matchValue(dict, /\/ID\s*(\[[\s\S]*?\])/),
    encrypted: /\/Encrypt\b/.test(dict),
  };
}

function lastStartXref(buffer) {
  const marker = Buffer.from('startxref');
  const index = buffer.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = buffer.slice(index + marker.length, index + marker.length + 40).toString('latin1');
  const match = tail.match(/\s*(\d+)/);
  if (!match) return null;
  return Number(match[1]);
}

function resolveTrailer(buffer) {
  let offset = lastStartXref(buffer);
  const latestOffset = offset;
  let root = null;
  let size = null;
  let id = null;
  let info = null;
  let encrypted = false;

  for (let guard = 0; offset != null && guard < 20; guard += 1) {
    const parsed = parseSectionAt(buffer, offset);
    if (!parsed) break;
    if (parsed.encrypted) encrypted = true;
    if (!root && parsed.root) root = parsed.root;
    if (!size && Number.isInteger(parsed.size)) size = parsed.size;
    if (!id && parsed.id) id = parsed.id;
    if (!info && parsed.info) info = parsed.info;
    if (root && size && info) break;
    offset = parsed.prev == null ? null : Number(parsed.prev);
  }

  if (!root || !Number.isInteger(size) || encrypted) return null;
  return { root, size, id, info, prev: latestOffset };
}

function readPlainInfoDict(buffer, reference) {
  const match = String(reference || '').match(/^(\d+)\s+(\d+)\s+R$/);
  if (!match) return null;
  const header = Buffer.from(`${match[1]} ${match[2]} obj`);
  let from = 0;
  while (from < buffer.length) {
    const index = buffer.indexOf(header, from);
    if (index < 0) return null;
    const after = buffer.slice(index + header.length, index + header.length + 8000).toString('latin1');
    const trimmed = after.trimStart();
    if (trimmed.startsWith('<<')) {
      const dict = readDict(trimmed);
      if (!dict) return null;
      const remainder = trimmed.slice(dict.length).trimStart();
      if (remainder.startsWith('stream')) return null;
      return dict;
    }
    from = index + header.length;
  }
  return null;
}

function skipPdfValue(text, start) {
  let index = start;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (text[index] === '(') {
    index += 1;
    let depth = 1;
    while (index < text.length && depth > 0) {
      if (text[index] === '\\') {
        index += 2;
        continue;
      }
      if (text[index] === '(') depth += 1;
      else if (text[index] === ')') depth -= 1;
      index += 1;
    }
    return index;
  }
  if (text[index] === '<') {
    if (text[index + 1] === '<') {
      const nested = readDict(text.slice(index));
      return nested ? index + nested.length : text.length;
    }
    const end = text.indexOf('>', index);
    return end < 0 ? text.length : end + 1;
  }
  if (text[index] === '[') {
    const end = text.indexOf(']', index);
    return end < 0 ? text.length : end + 1;
  }
  while (index < text.length && !/[\s/>]/.test(text[index])) index += 1;
  return index;
}

function dictWithTitle(existingDict, titleToken) {
  const inner = existingDict
    ? existingDict.replace(/^<</, '').replace(/>>\s*$/, '')
    : '';
  let result = '';
  let index = 0;
  while (index < inner.length) {
    const found = inner.indexOf('/Title', index);
    if (found < 0) {
      result += inner.slice(index);
      break;
    }
    const boundary = inner[found + 6];
    if (boundary && /[A-Za-z0-9]/.test(boundary)) {
      result += inner.slice(index, found + 6);
      index = found + 6;
      continue;
    }
    result += inner.slice(index, found);
    index = skipPdfValue(inner, found + 6);
  }
  return `<< ${result.trim()} /Title ${titleToken} >>`;
}

function buildPdfTitleIncrement(original, title) {
  if (!Buffer.isBuffer(original) || original.length < 8) return null;
  if (!original.slice(0, 5).equals(Buffer.from('%PDF-'))) return null;
  const trailer = resolveTrailer(original);
  if (!trailer) return null;

  const existingInfo = trailer.info ? readPlainInfoDict(original, trailer.info) : null;
  const infoDictionary = dictWithTitle(existingInfo, pdfTitleToken(title));
  const objectNumber = trailer.size;
  const prefix = original[original.length - 1] === 0x0A
    ? original
    : Buffer.concat([original, Buffer.from('\n')]);
  const objectOffset = prefix.length;
  const objectText = `${objectNumber} 0 obj\n${infoDictionary}\nendobj\n`;
  const xrefOffset = objectOffset + Buffer.byteLength(objectText);
  const xrefEntry = `${String(objectOffset).padStart(10, '0')} 00000 n \n`;
  if (Buffer.byteLength(xrefEntry) !== 20) return null;

  const idEntry = trailer.id ? ` /ID ${trailer.id}` : '';
  const suffix = `${objectText}xref\n${objectNumber} 1\n${xrefEntry}trailer\n<< /Size ${objectNumber + 1} /Root ${trailer.root} /Prev ${trailer.prev} /Info ${objectNumber} 0 R${idEntry} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([prefix, Buffer.from(suffix)]);
}

function stampUploadedPdfTitle(absolutePath, title) {
  if (!absolutePath || path.extname(absolutePath).toLowerCase() !== '.pdf') return false;
  if (!title) return false;

  let original;
  try {
    original = fs.readFileSync(absolutePath);
  } catch (error) {
    return false;
  }

  const updated = buildPdfTitleIncrement(original, title);
  if (!updated) return false;

  const tempPath = `${absolutePath}.${process.pid}.title`;
  try {
    fs.writeFileSync(tempPath, updated);
    fs.renameSync(tempPath, absolutePath);
    return true;
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch (unlinkError) {
      // The original upload remains in place when the title update cannot be saved.
    }
    return false;
  }
}

module.exports = {
  pdfTitleToken,
  buildPdfTitleIncrement,
  stampUploadedPdfTitle,
};
