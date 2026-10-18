import { applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';

/* Minimal-diff edits for JSON / JSONC text.
 * Only the node that changes is touched: comments, key order, trailing commas, indentation and
 * line endings of everything else stay byte-for-byte as the user wrote them. */

const PARSE_OPTIONS = { allowTrailingComma: true };

export function detectFormatting(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
  return { eol, indent: indent.startsWith('\t') ? '\t' : indent };
}

function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))[0];
}

// pretty JSON in the file's own indent unit; continuation lines carry the indentation of the line they start on
function render(value, indent, eol, baseIndent) {
  return JSON.stringify(value, null, indent).split('\n').join(eol + baseIndent);
}

function endOfLine(text, from) {
  const newline = text.indexOf('\n', from);
  const end = newline < 0 ? text.length : newline;
  return text[end - 1] === '\r' ? end - 1 : end;
}

function splice(text, offset, length, content) {
  return text.slice(0, offset) + content + text.slice(offset + length);
}

// index of a trailing comma that follows `end` (skipping whitespace and comments), or -1
function trailingCommaAfter(text, end) {
  let i = end;
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text.startsWith('//', i)) {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline + 1;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? text.length : close + 2;
    } else {
      break;
    }
  }
  return text[i] === ',' ? i : -1;
}

function insertProperty(text, objectNode, key, value, indent, eol) {
  const keyText = JSON.stringify(key);
  const objectIndent = lineIndentAt(text, objectNode.offset);
  const properties = objectNode.children ?? [];

  if (properties.length === 0) {
    const entry = `${objectIndent}${indent}${keyText}: ${render(value, indent, eol, objectIndent + indent)}`;
    return splice(text, objectNode.offset, objectNode.length, `{${eol}${entry}${eol}${objectIndent}}`);
  }

  const first = properties[0];
  const last = properties[properties.length - 1];
  const sameLineAsBrace = !text.slice(objectNode.offset, first.offset).includes('\n');
  const propertyIndent = sameLineAsBrace ? objectIndent + indent : lineIndentAt(text, first.offset);
  const entry = `${eol}${propertyIndent}${keyText}: ${render(value, indent, eol, propertyIndent)}`;

  // A comment after the last property stays with that property: the new entry goes after the end of its line.
  const lastEnd = last.offset + last.length;
  const comma = trailingCommaAfter(text, lastEnd);
  const from = comma >= 0 ? comma + 1 : lastEnd;
  const lineEnd = endOfLine(text, from);
  const at = /^[ \t]*(\/\/.*|\/\*.*?\*\/[ \t]*)?$/.test(text.slice(from, lineEnd)) ? lineEnd : from;
  if (comma >= 0) return text.slice(0, at) + entry + ',' + text.slice(at);
  return `${text.slice(0, lastEnd)},${text.slice(lastEnd, at)}${entry}${text.slice(at)}`;
}

export function removeProperty(text, jsonPath) {
  return applyEdits(text, modify(text, jsonPath, undefined, {}));
}

// Sets the value at `jsonPath`, creating missing objects on the way. Throws when the text is not a JSON object.
export function setProperty(text, jsonPath, value) {
  if (value === undefined) return removeProperty(text, jsonPath);
  const root = parseTree(text, [], PARSE_OPTIONS);
  if (!root || root.type !== 'object') throw new Error('config root must be a JSON object');
  const { eol, indent } = detectFormatting(text);

  // deepest node of the path that already exists
  let depth = jsonPath.length;
  let node = null;
  for (; depth >= 0; depth -= 1) {
    node = depth === 0 ? root : findNodeAtLocation(root, jsonPath.slice(0, depth));
    if (node) break;
  }
  const rest = jsonPath.slice(depth);
  const nest = (keys, leaf) => keys.reduceRight((inner, key) => ({ [key]: inner }), leaf);

  if (rest.length === 0 || node.type !== 'object') {
    const replacement = rest.length === 0 ? value : nest(rest, value);
    return splice(text, node.offset, node.length, render(replacement, indent, eol, lineIndentAt(text, node.offset)));
  }
  return insertProperty(text, node, rest[0], nest(rest.slice(1), value), indent, eol);
}
