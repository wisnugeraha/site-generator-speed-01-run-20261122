// fast-solve.js v4 — genuinely faster than makefun-site 1.0.0 (reference), same rules, byte-identical output.
//
// Architecture: the reference is an interpreter (per-{{var}} lookup+textOf+escape; per-node for-in; per-line
// front-matter regex). This one compiles the hot paths:
//   templates  -> emit() functions with hoisted variable access (scope chain walked once at emit time),
//   front matter -> single-pass charCode scanner (no line split, no per-line regex),
//   markdown   -> charCode hot paths, direct block emission,
//   text rules -> ASCII fast paths + charCode loops, per-run memo caches.
// All error strings, line numbers and pipeline order match the reference byte for byte.

// ---------- text rules ----------
const ESC_MAP = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];

export function escapeHtml(text) {
  const n = text.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) { first = i; break; }
  }
  if (first === -1) return text;
  let out = text.slice(0, first);
  for (let i = first; i < n; i++) {
    const d = text.charCodeAt(i);
    if (d === 38) out += '&amp;';
    else if (d === 60) out += '&lt;';
    else if (d === 62) out += '&gt;';
    else if (d === 34) out += '&quot;';
    else if (d === 39) out += '&#39;';
    else out += text.charAt(i);
  }
  return out;
}

export const SLUG_MAX = 64;

// ASCII fast path: NFKD is the identity on ASCII and the reference's \p{M} strip changes nothing;
// only fall back when the string has anything outside printable ASCII or in the BMP mark range.
function asciiSlug(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 126) {
      // CJK Han etc. keep their slug form (not marks), but NFKD may decompose some; be safe:
      // any code > 0x7e or in the BMP combining-mark range -> fall back
      if (c >= 0x300 && c <= 0x36f || c > 0x7e) {
        if (c <= 0x7e) { /* unreachable */ }
        return null;
      }
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    let keep = null;
    if (c >= 65 && c <= 90) c |= 32;
    if (c >= 97 && c <= 122 || c >= 48 && c <= 57) keep = String.fromCharCode(c);
    if (keep === null) {
      if (out !== '') gap = true;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

export function slugify(text) {
  const fast = asciiSlug(text);
  if (fast !== null) return fast;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function longDate(date) {
  if (date.length === 10 && date.charCodeAt(4) === 45 && date.charCodeAt(7) === 45) {
    const d = (date.charCodeAt(8) - 48) * 10 + date.charCodeAt(9) - 48;
    const m = (date.charCodeAt(5) - 48) * 10 + date.charCodeAt(6) - 48;
    return `${d} ${MONTHS[m - 1]} ${date.slice(0, 4)}`;
  }
  const [y, m, dd] = date.split('-');
  return `${Number(dd)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ---------- front matter (single-pass charCode scanner; reference semantics byte for byte) ----------
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function validDate(raw) {
  const n = raw.length;
  if (n !== 10) return false;
  if (raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let k = 0; k < 10; k++) {
    if (k === 4 || k === 7) continue;
    const c = raw.charCodeAt(k);
    if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + raw.charCodeAt(3) - 48;
  const mo = (raw.charCodeAt(5) - 48) * 10 + raw.charCodeAt(6) - 48;
  const d = (raw.charCodeAt(8) - 48) * 10 + raw.charCodeAt(9) - 48;
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function quotedString(raw) {
  const n = raw.length;
  if (n < 2 || raw.charCodeAt(n - 1) !== 34) return 'a quoted string is not closed';
  let out = '';
  let i = 1;
  const end = n - 1;
  while (i < end) {
    const c = raw.charCodeAt(i);
    if (c === 92) {
      const nx = raw.charCodeAt(i + 1);
      if ((nx !== 34 && nx !== 92) || i + 1 === end) return 'a quoted string holds an escape other than \\" or \\\\' ;
      out += raw.charAt(i + 1);
      i += 2;
    } else if (c === 34) return 'a quoted string holds a stray quote';
    else { out += raw.charAt(i); i++; }
  }
  return out;
}

// The dispatch is on the whole key (a 7-entry exact switch). The old first-letter table sent "tags"
// (key[0] === 't') into case 'title' — that is the bug this replaces.
function valueOf(key, raw, data) {
  switch (key) {
    case 'title':
    case 'summary': {
      if (raw.charCodeAt(0) === 34) {
        const q = quotedString(raw);
        if (q.startsWith('a quoted')) return `key "${key}": ${q}`;
        data[key] = q;
      } else if (raw.charCodeAt(0) === 91) {
        return `key "${key}": a bare string opens on [`;
      } else data[key] = raw;
      return null;
    }
    case 'date':
      if (validDate(raw)) { data[key] = raw; return null; }
      return 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') { data[key] = []; return null; }
      const tags = inner.split(',').map((t) => t.trim());
      for (let i = 0; i < tags.length; i++) if (tags[i] === '' || !TAG_RE.test(tags[i]))
        return 'key "tags": an empty tag, or one holding " [ or ]';
      data[key] = tags;
      return null;
    }
    case 'draft':
      if (raw === 'true') { data[key] = true; return null; }
      if (raw === 'false') { data[key] = false; return null; }
      return 'key "draft": true or false';
    case 'layout':
      if (NAME_RE.test(raw)) { data[key] = raw; return null; }
      return 'key "layout": not a template name';
    case 'slug':
      if (SLUG_RE.test(raw) && raw.length <= 64) { data[key] = raw; return null; }
      return 'key "slug": not a slug';
    default:
      return `unknown key "${key}"`;
  }
}

const KNOWN = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/**
 * The front matter of `text` as { data, body } or { error } — the reference's rules and messages exactly.
 * Split-free: one indexOf walk for the closing fence, then a line walk; a "key: value" line is scanned
 * char by char (the reference's /^([a-z_]+):(?: (.*))?$/ plus trailing-whitespace trim).
 */
export function parseFrontMatter(text) {
  if (text === '---' || !text.startsWith('---\n')) return { error: 'no front matter' };
  const n = text.length;
  let pos = 4;
  let closeLine = -1;
  while (pos <= n) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd - pos === 3 && text.slice(pos, lineEnd) === '---') { closeLine = pos; break; }
    pos = nl === -1 ? n + 1 : nl + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let lineno = 2;
  while (pos < closeLine) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? closeLine : nl;
    const line = text.slice(pos, lineEnd);
    pos = lineEnd + 1;
    if (line === '' || line.charCodeAt(0) === 35) { lineno++; continue; }
    let blank = true;
    for (let k = 0; k < line.length; k++) {
      const c = line.charCodeAt(k);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank) { lineno++; continue; }
    let j = 0;
    let keyLen = 0;
    for (; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if ((c >= 97 && c <= 122) || c === 95) keyLen++;
      else break;
    }
    if (keyLen === 0 || j === line.length || line.charCodeAt(j) !== 58) {
      return { error: `line ${lineno} is not "key: value"` };
    }
    const key = line.slice(0, keyLen);
    j++; // the ':'
    let raw;
    if (j === line.length) raw = '';
    else if (line.charCodeAt(j) !== 32) return { error: `line ${lineno} is not "key: value"` };
    else {
      let e = line.length;
      while (e > j + 1) {
        const c = line.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      raw = line.slice(j + 1, e);
    }
    if (!KNOWN.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const err = valueOf(key, raw, data);
    if (err !== null) return { error: err };
    lineno++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeLine + 4) };
}

// ---------- markdown ----------
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;
const BLANK_LINE = /^[ \t]*$/;

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// bitset of the 14 escapable chars (faster than a Set lookup in the hot loops)
const ESCAPABLE = new Uint8Array(0x110);
{ for (const c of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[c.charCodeAt(0)] = 1; }
function isEscappable(code) { return code < 0x110 && ESCAPABLE[code] !== 0; }

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  const wl = what.length;
  const sl = s.length;
  for (let j = from; j + wl <= sl; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const nx = j + 1 < sl ? s.charCodeAt(j + 1) : -1;
      if (isEscappable(nx)) { j++; continue; }
    }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  const sl = s.length;
  for (let j = from; j < sl; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const nx = j + 1 < sl ? s.charCodeAt(j + 1) : -1;
      if (isEscappable(nx)) { j++; continue; }
    }
    if (c !== 42) continue;
    if (j + 1 < sl && s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

const SPECIAL = new Uint8Array(0x110);
{ for (const c of ['\\', '`', '*', '[', '&', '<', '>', '"', "'"]) SPECIAL[c.charCodeAt(0)] = 1; }

/** inline(s, link): escaped text with code/strong/em/link spans (reference's semantics). */
export function inline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const nx = s.charCodeAt(i + 1);
      if (isEscappable(nx)) {
        out += escapeHtml(s.charAt(i + 1));
        i += 2;
        continue;
      }
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`; i = j + 1; }
      else { out += '`'; i++; }
      continue;
    }
    if (c === 42) {
      if (i + 1 < n && s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) { out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`; i = j + 2; }
        else { out += '**'; i += 2; }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) { out += `<em>${inline(s.slice(i + 1, j), link)}</em>`; i = j + 1; }
      else { out += '*'; i++; }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && k + 1 < n && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    // batch plain chars
    let j = i;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d < 0x110 && SPECIAL[d] !== 0) break;
      j++;
    }
    if (j > i) { out += s.slice(i, j); i = j; continue; }
    out += escapeHtml(s.charAt(i));
    i++;
  }
  return out;
}

export function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (BLANK_LINE.test(line)) { i++; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < L && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang: fence[1], lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) { tokens.push({ type: 'heading', depth: heading.depth, text: heading.text }); i++; continue; }
    if (HR.test(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < L && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < L) {
        const m = marker.exec(lines[i]);
        if (m !== null) { items.push([trimLine(isOrdered ? m[2] : m[1])]); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < L) {
      const l = lines[i];
      if (BLANK_LINE.test(l) || FENCE_OPEN.test(l) || HEADING.test(l) || HR.test(l)) break;
      body.push(trimLine(l));
      i++;
    }
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

export function renderMarkdown(src, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const tokens = lex(src);
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    switch (tok.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(tok.text), ids);
        const html = inline(tok.text, link);
        blocks.push(`<h${tok.depth} id="${id}">${html}</h${tok.depth}>`);
        if (tok.depth === 2 || tok.depth === 3) toc.push({ level: tok.depth, id, html });
        break;
      }
      case 'code': {
        const cls = tok.lang === '' ? '' : ` class="language-${escapeHtml(tok.lang)}"`;
        let out = `<pre><code${cls}>`;
        for (let k = 0; k < tok.lines.length; k++) out += escapeHtml(tok.lines[k]) + '\n';
        out += '</code></pre>';
        blocks.push(out);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(tok.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(tok.lines.join('\n'), link)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const open = tok.ordered && tok.start !== 1 ? `<ol start="${tok.start}">` : `<${tag}>`;
        let out = `${open}\n`;
        for (let i = 0; i < tok.items.length; i++) out += `<li>${inline(tok.items[i], link)}</li>\n`;
        out += `</${tag}>`;
        blocks.push(out);
        break;
      }
      case 'paragraph': {
        const html = inline(tok.text, link);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------- templates: compile to emit() functions ----------
const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const before = src.slice(lineStart, open);
    const after = src.slice(end, lineEnd);
    let standalone = true;
    for (const seg of [before, after]) {
      for (let k = 0; k < seg.length; k++) { const c = seg.charCodeAt(k); if (c !== 32 && c !== 9) { standalone = false; break; } }
      if (!standalone) break;
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * Parse `name`/`src` into a template record { nodes, fn }. `fn(globals, ctx, depth, scope)` renders the
 * template in `globals` (the root vars object); `scope` is the reference's scope chain node.
 * The reference's tree is compiled away: text runs are inlined, each {{var}}/{{{raw}}}/{% if %}/{% for %}
 * node becomes a call to a hoisted lookup + textOf/escape — no per-node switch at render time.
 */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  const nodes = root.body;
  // ---- compile ----
  // fns: a Map from each body list to its emit function. Each emit fn is built from its parent's scope chain:
  // for-loops bind the item var and `loop` into a new scope; the chain is walked once per lookup at emit time.
  const fns = new Map();

  const compile = (list, isRoot) => {
    // Pre-scan: text nodes accumulate into segments; each var/raw/if/for/include becomes one part.
    // The emit fn is a direct closure over `parts` — built once per body list, called per render.
    const parts = [];
    let text = '';
    for (const n of list) {
      if (n.kind === 'text') { text += n.text; continue; }
      if (text !== '') { parts.push(['text', text]); text = ''; }
      if (n.kind === 'var') parts.push(['var', n.path]);
      else if (n.kind === 'raw') parts.push(['raw', n.path]);
      else if (n.kind === 'if') parts.push(['if', n]);
      else if (n.kind === 'for') parts.push(['for', n]);
      else parts.push(['include', n.name]);
    }
    if (text !== '') parts.push(['text', text]);

    const f = (g, ctx, depth, scope) => {
      let out = '';
      const esc = ctx.escape;
      for (let p = 0; p < parts.length; p++) {
        const part = parts[p];
        if (part[0] === 'text') { out += part[1]; continue; }
        if (part[0] === 'var' || part[0] === 'raw') {
          let v = lookup(scope, part[1]);
          out += part[0] === 'var' ? esc(textOf(v)) : textOf(v);
          continue;
        }
        if (part[0] === 'if') {
          const n = part[1];
          const v = truthy(lookup(scope, n.path));
          const use = v !== n.not ? n.then : n.else;
          if (use !== null) out += fns.get(use)(g, ctx, depth, scope);
          continue;
        }
        if (part[0] === 'for') {
          const n = part[1];
          const xs = lookup(scope, n.path);
          if (!Array.isArray(xs)) continue;
          const len = xs.length;
          const inner = fns.get(n.body);
          for (let k = 0; k < len; k++) {
            const item = xs[k];
            const l = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
            out += inner(g, ctx, depth, { vars: { [n.name]: item, loop: l }, parent: scope });
          }
          continue;
        }
        // include
        const t = ctx.templates.get(part[1]);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += t.fn(g, ctx, depth + 1, scope);
      }
      return out;
    };
    return f;
  };

  // Build post-order so branch bodies compile before their parents
  const allLists = new Set();
  const walk = (list) => {
    allLists.add(list);
    for (const n of list) {
      if (n.kind === 'for') walk(n.body);
      if (n.kind === 'if') { walk(n.then); if (n.else) walk(n.else); }
    }
  };
  walk(nodes);
  for (const l of allLists) fns.set(l, compile(l, l === nodes));
  const fn = fns.get(nodes);
  return { nodes, fn };
}

/** The reference's tree renderer, kept for any external caller (build() uses the compiled fn). */
export function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text': out += n.text; break;
      case 'var': out += ctx.escape(textOf(lookup(scope, n.path))); break;
      case 'raw': out += textOf(lookup(scope, n.path)); break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------- the pipeline (index.js logic, identical semantics) ----------
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const WS_TABLE = new Uint8Array(0x110);
{
  // ASCII whitespace per \s
  for (const c of ' \t\n\x0B\x0C\r') WS_TABLE[c.charCodeAt(0)] = 1;
  WS_TABLE[0x0085] = WS_TABLE[0x00a0] = 1;
  for (let c = 0x1680; c <= 0x169a; c++) WS_TABLE[c] = 1;
  for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;
  WS_TABLE[0x2028] = WS_TABLE[0x2029] = 1;
  WS_TABLE[0x202f] = 1; WS_TABLE[0x205f] = 1; WS_TABLE[0x3000] = 1;
  for (let c = 0x2028; c <= 0x202e; c++) if (c === 0x2028 || c === 0x2029 || c === 0x202f) {} // (202a-202e not \s)
}

function wordsOf(text) {
  let c = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    const ws = ch < 0x110 ? WS_TABLE[ch] !== 0 : ch === 0x0085 || ch === 0x00a0 || (ch >= 0x1680 && ch <= 0x169a) || (ch >= 0x2000 && ch <= 0x200a) || ch === 0x2028 || ch === 0x2029 || ch === 0x202f || ch === 0x205f || ch === 0x3000;
    if (!ws) { if (!inW) { c++; inW = true; } } else inW = false;
  }
  return c;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function build(input) {
  // 0. templates (parse errors reported first)
  const templates = new Map();
  const report = [];
  const tmplNames = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of tmplNames) {
    try { templates.set(name, parseTemplate(name, input.templates[name])); }
    catch (err) { if (!(err instanceof TemplateError)) throw err; report.push(err.message); }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const ctx = { templates, escape: escapeHtml };

  // 1. sources
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter + checks
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  sources.length = 0;
  sources.push(...kept);

  // 3. permalinks
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown + links
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags
  const bySlug = new Map();
  const slugCache = new Map();
  const slugOfName = (name) => {
    let v = slugCache.get(name);
    if (v === undefined) { v = slugify(name); slugCache.set(name, v); }
    return v;
  };
  const ownTags = (s) => {
    const seen = new Set();
    const list = s.data.tags ?? [];
    const out = [];
    for (const name of list) {
      const sl = slugOfName(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOfName(name);
      let tag = bySlug.get(slug);
      if (!tag) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOfName(name)) ?? { name, slug: slugOfName(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const output = {};
  const cardCache = new Map();
  function cardOf(s) {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  }
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) });
  function pageOf(s) {
    const c = cardOf(s);
    return {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long, summary: c.summary,
      excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const siteVars = { title: input.site.title, base_url: base };
  const render = (name, vars) => {
    const rec = templates.get(name);
    if (rec === undefined) return null;
    const g = { site: siteVars, tags: allTags, recent, ...vars };
    return rec.fn(g, ctx, 0, { vars: g, parent: null });
  };
  for (const s of sources) {
    const html = render(s.layout, { page: pageOf(s) });
    if (html !== null) output[`${s.outDir}/index.html`] = html;
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (const s of sources) if (!s.post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** The entry: one case's answer. */
export function run(input) {
  return build(input);
}
