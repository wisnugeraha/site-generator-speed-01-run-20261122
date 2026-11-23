// fast-solve.js — faster drop-in for makefun-site 1.0.0 (agent's own code; same rules, byte-identical output).

// ---------- text rules ----------
// escapeHtml: fast path (no specials → return as-is, zero allocation); charCode loop for the rest.
export function escapeHtml(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
    i++;
  }
  if (i === n) return text;
  let out = text.slice(0, i);
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 38) out += '&amp;';
    else if (c === 60) out += '&lt;';
    else if (c === 62) out += '&gt;';
    else if (c === 34) out += '&quot;';
    else if (c === 39) out += '&#39;';
    else out += String.fromCharCode(c);
    i++;
  }
  return out;
}

export const SLUG_MAX = 64;

export function slugify(text) {
  // Fast path: pure [A-Za-z0-9 ] ASCII needs no NFKD, no unicode scan.
  const n0 = text.length;
  let asciiClean = true;
  for (let i = 0; i < n0; i++) {
    const c = text.charCodeAt(i);
    if (c > 127 || (c < 48 && c !== 32) || (c > 57 && c < 65) || (c > 90 && c < 97) || c > 122) { asciiClean = false; break; }
  }
  if (!asciiClean) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    return out === '' ? 'untitled' : out;
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < n0; i++) {
    const c = text.charCodeAt(i);
    if (c === 32) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : text[i];
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  const t = out.replace(/-+$/, '');
  return t === '' ? 'untitled' : t;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const LD_CACHE = new Map();
export function longDate(date) {
  let v = LD_CACHE.get(date);
  if (v === undefined) {
    const [y, m, d] = date.split('-');
    v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    LD_CACHE.set(date, v);
  }
  return v;
}

const BLANK_LINE = /^[ \t]*$/;
// ---------- front matter (line-oriented, single-pass indexOf; matches makefun-site 1.0.0 byte for byte) ----------
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A YYYY-MM-DD real day, 1970-01-01 to 2099-12-31, checked without a regex. */
function validDate(raw) {
  const n = raw.length;
  if (n !== 10) return false;
  for (let k = 0; k < n; k++) {
    const c = raw.charCodeAt(k);
    if (k === 4 || k === 7) { if (c !== 45) return false; }
    else if (c < 48 || c > 57) return false;
  }
  const y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + raw.charCodeAt(3) - 48;
  const mo = (raw.charCodeAt(5) - 48) * 10 + raw.charCodeAt(6) - 48;
  const d = (raw.charCodeAt(8) - 48) * 10 + raw.charCodeAt(9) - 48;
  return y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
}

/** One line's { key, raw }, or null when it is not a "key: value" line. Blank and # lines are pre-filtered. */
function lineOf(line) {
  const n = line.length;
  let j = 0;
  let key = '';
  while (j < n) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) { key += line[j]; j++; }
    else break;
  }
  if (j === 0 || j >= n || line.charCodeAt(j) !== 58) return null;
  if (j + 1 === n) return { key, raw: '' };
  if (line.charCodeAt(j + 1) !== 32) return null;
  let raw = line.slice(j + 2);
  // trailing spaces and tabs dropped, exactly as the reference's replace(/[ \t]+$/, '')
  let end = raw.length;
  while (end > 0) {
    const c = raw.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  raw = raw.slice(0, end);
  return { key, raw };
}

/** A quoted string value of raw (raw[0] === '"'): its text, or a reason string (vendor's exact error text). */
function quotedString(raw) {
  let out = '';
  let i = 1;
  const n = raw.length;
  if (n < 2 || raw.charCodeAt(n - 1) !== 34) return 'a quoted string is not closed';
  const end = n - 1;
  while (i < end) {
    const c = raw.charCodeAt(i);
    if (c === 92) {
      const nx = raw.charCodeAt(i + 1);
      if ((nx !== 34 && nx !== 92) || i + 1 === end) return 'a quoted string holds an escape other than \\" or \\\\';
      out += raw[i + 1];
      i += 2;
    } else if (c === 34) return 'a quoted string holds a stray quote';
    else out += raw[i], i++;
  }
  return out;
}

/** One key's value, or the reference's exact error string. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      if (raw.charCodeAt(0) === 34) {
        const q = quotedString(raw);
        if (typeof q === 'string' && q.startsWith('a quoted')) return `key "${key}": ${q}`;
        return q;
      }
      if (raw.charCodeAt(0) === 91) return 'key "' + key + '": a bare string opens on [';
      return raw;
    }
    case 'date': {
      const v = validDate(raw);
      return v ? raw : 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)';
    }
    case 'tags': {
      const n = raw.length;
      if (n < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(n - 1) !== 93) return 'key "tags": not a list [a, b]';
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return [];
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        tags[i] = t;
        if (t === '' || !TAG_RE.test(t)) return 'key "tags": an empty tag, or one holding " [ or ]';
      }
      return tags;
    }
    case 'draft': return raw === 'true' ? true : raw === 'false' ? false : 'key "draft": true or false';
    case 'layout': return NAME_RE.test(raw) ? raw : 'key "layout": not a template name';
    case 'slug': return SLUG_RE.test(raw) && raw.length <= 64 ? raw : 'key "slug": not a slug';
    default: return null; // unreachable: the caller checks the key first
  }
}

const KNOWN = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/**
 * The front matter of `text` as { data, body } or { error } — the reference's rules and messages exactly.
 * Vendor semantics: split on "\n"; line 0 must be exactly "---"; the first later exact "---" closes;
 * between: blank (spaces/tabs only), a "#" comment, or "key: value"; anything else is the line error,
 * numbered from 1 at the opening fence. An unclosed/stray/bad-escape quoted string is one error.
 */
export function parseFrontMatter(text) {
  if (text === '---' || !text.startsWith('---\n')) return { error: 'no front matter' };
  const n = text.length;
  let pos = 4;
  let closePos = -1;
  let closeLine = -1;
  while (pos <= n) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? n : nl;
    if (lineEnd - pos === 3 && text.slice(pos, lineEnd) === '---') { closePos = lineEnd; closeLine = pos; break; }
    pos = nl === -1 ? n + 1 : nl + 1;
  }
  if (closePos === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let lineno = 2;
  while (pos < closeLine) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? closePos : nl;
    const line = text.slice(pos, lineEnd);
    pos = lineEnd + 1;
    if (line !== '' && line.charCodeAt(0) !== 35 && !/^[ \t]*$/.test(line)) {
      const li = lineOf(line);
      if (!li) return { error: 'line ' + lineno + ' is not "key: value"' };
      const { key, raw } = li;
      if (!KNOWN.has(key)) return { error: 'unknown key "' + key + '"' };
      if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if (typeof v === 'string' && v.startsWith('key "')) return { error: v };
      data[key] = v;
    }
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

function trimLine(line) {
  let a = 0, b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

// ESCAPABLE char codes as a charCode->bool array (160-bit slice: 0x5C92 backslash, 0x240 backtick,
// 0x19 star, 0x1A3 [, ] (, ) , #, +, -, ., !, >). Bit test: (ESCAPABLE[code] >> (code & 7)) & 1.
// Built from the exact set the vendor escapes.
function buildEscapable() {
  const set = ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>'];
  const words = new Array(40).fill(0); // covers code 0..319 in groups of 8; all escapers are < 96
  for (const ch of set) words[ch.charCodeAt(0) >> 3] |= 1 << (ch.charCodeAt(0) & 7);
  return words;
}
const ESCAPABLE_WORDS = buildEscapable();
const escapable = (code) => ((ESCAPABLE_WORDS[code >> 3] >>> (code & 7)) & 1) === 1;

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && escapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === w0 && s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && escapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}


/** inline(s, link): escaped text with code/strong/em/link spans. */
export function inline(s, link) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && escapable(s.charCodeAt(i + 1))) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === 96) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) { out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`; i = j + 1; }
      else { out += '`'; i++; }
      continue;
    }
    if (c === 42) { // star
      if (s.charCodeAt(i + 1) === 42) {
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
    if (c === 91) { // [
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
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
    // batch plain chars — no specials between i and j; slice wholesale
    let j = i;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (d === 92 || d === 96 || d === 42 || d === 91 || d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    if (j > i) { out += s.slice(i, j); i = j; continue; }
    out += escapeHtml(String.fromCharCode(s.charCodeAt(i)));
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
        for (const item of tok.items) out += `<li>${inline(item, link)}</li>\n`;
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

// ---------- templates ----------
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
      for (let k = 0; k < seg.length; k++) { const c = seg[k]; if (c !== ' ' && c !== '\t') { standalone = false; break; } }
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

// ---------- templates (compile once per run, reuse across that run's many renders) ----------
export function parseTemplate(name, src, tplCache) {
  if (tplCache !== undefined) {
    let t = tplCache.get(name);
    if (t !== undefined) return t;
    t = compileTemplate(name, src);
    tplCache.set(name, t);
    return t;
  }
  return compileTemplate(name, src);
}

function compileTemplate(name, src) {
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
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": a ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// lookup / textOf: fast paths — the common shape is a short dotted path on a plain
// object chain (loop var -> card object -> field); avoid the scope-walk when not needed.
function lookup(scope, path) {
  const len = path.length;
  if (len === 1 && scope !== null && Object.hasOwn(scope.vars, path[0])) return scope.vars[path[0]];
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < len; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// textOf: the hot case is a string or number; avoid the generic fallthrough.
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (Array.isArray(v)) {
    const n = v.length;
    let out = '';
    for (let i = 0; i < n; i++) {
      const e = v[i];
      if (i > 0) out += ', ';
      out += textOf(e);
    }
    return out;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

export function renderNodes(nodes, scope, ctx, depth) {
  const esc = ctx.escape; // cache the escape function: it is read on every {{ }}
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    const kind = n.kind;
    if (kind === 'text') { out += n.text; continue; }
    if (kind === 'var') { out += esc(textOf(lookup(scope, n.path))); continue; }
    if (kind === 'raw') { out += textOf(lookup(scope, n.path)); continue; }
    if (kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
      continue;
    }
    if (kind === 'for') {
      const xs = lookup(scope, n.path);
      if (!Array.isArray(xs)) continue;
      const len = xs.length;
      const loop = { index: 0, first: false, last: false, length: len };
      const body = n.body;
      const nm = n.name;
      for (let k = 0; k < len; k++) {
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === len - 1;
        out += renderNodes(body, { vars: { [nm]: xs[k], loop }, parent: scope }, ctx, depth);
      }
      continue;
    }
    if (kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
    }
  }
  return out;
}

// ---------- the pipeline (index.js logic, identical semantics) ----------
const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 0xa0 || c === 0xfeff || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
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
  // 0. templates (parse errors reported first; compiled once per run, reused by every render)
  const templates = new Map();
  const tplCache = new Map(); // per-run cache for parseTemplate's compiled trees
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try { templates.set(name, parseTemplate(name, input.templates[name], tplCache)); }
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
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags
  const bySlug = new Map();
  // Cache slugify(name) per tag name: each tag name is slugified up to 3x per post
  // (dedupe filter + lookup + record) and once more per page — collapse to 1x per name.
  const slugCache = new Map();
  const slugOfName = (name) => {
    let v = slugCache.get(name);
    if (v === undefined) { v = slugify(name); slugCache.set(name, v); }
    return v;
  };
  const ownTags = (s) => {
    const seen = new Set();
    const names = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
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
      if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOfName(name)) ?? { name, slug: slugOfName(name), url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  function cardOf(s) {
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  function pageOf(s) {
    return {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
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
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** The entry: one case's answer. */
export function run(input) {
  return build(input);
}
