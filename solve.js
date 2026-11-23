// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the answer
// makefun-site 1.0.0's build returns for the same input, byte for byte.
//
// Same pipeline, same rules (README.md of makefun-site 1.0.0 is the spec, its code
// the reference wherever the two differ), rewritten for speed:
//  - Markdown is lexed and rendered in one pass, with no token objects.
//  - Inline rendering scans to the next special character and copies the plain
//    run between them as-is (it holds no escapable character), instead of
//    escaping one character at a time.
//  - slugify results are cached per run() call (tag names come from a small
//    table, titles and headings repeat); nothing is kept from one case to the
//    next — every cache below is created fresh inside run().
//  - A post's card (and its word count) is computed once and reused.
//  - Templates render into an array joined once, instead of string += per node.
//  - Templates are compiled to small render functions (their node tree turned
//    into code: direct scope lookups, no per-node dispatch). The generated code
//    holds template text only as JSON string literals and path/name pieces only
//    after the reference's own regexes validated them, so a template cannot
//    break out of the generated function; if compilation ever fails, the run
//    falls back to the tree-walking renderer below, which renders the same nodes.
//  - Front matter is scanned with indexOf, without splitting the whole body.
//  - Word counting is a single charCode pass, not a regex match that allocates
//    an array of every word.
//
// No dependency, no I/O, no clock, no randomness: the output is a function of
// the input alone, exactly as the reference's is.

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESCAPE_TEST = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESCAPE_TEST.test(text) ? text.replace(ESCAPE_ALL, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text` (see makefun-site's text.js), with per-run memoisation.
 * `cache` is a Map created fresh for each run() call.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
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
  const res = out === '' ? 'untitled' : out;
  cache.set(text, res);
  return res;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date, cache) {
  if (cache !== undefined) {
    const hit = cache.get(date);
    if (hit !== undefined) return hit;
  }
  const [y, m, d] = date.split('-');
  const res = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  if (cache !== undefined) cache.set(date, res);
  return res;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * Same decisions as the reference's parseFrontMatter; the lines are found with indexOf instead of
 * splitting (and rejoining) the whole body.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  if (nl === -1) {
    if (text !== '---') return { error: 'no front matter' };
    return { error: 'the front matter is not closed' };
  }
  if (text.slice(0, nl) !== '---') return { error: 'no front matter' };
  // Find the closing '---' line; lineNo is the 0-based index of the line starting at pos.
  let pos = nl + 1;
  let lineNo = 1;
  let closeLine = -1;
  let closeEnd = -1;
  for (;;) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    if (text.slice(pos, eol) === '---') {
      closeLine = lineNo;
      closeEnd = eol;
      break;
    }
    if (eol === text.length) break;
    pos = eol + 1;
    lineNo++;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = nl + 1;
  lineNo = 1;
  while (lineNo < closeLine) {
    let eol = text.indexOf('\n', pos);
    if (eol === -1) eol = text.length;
    const line = text.slice(pos, eol);
    if (!/^[ \t]*$/.test(line) && !line.startsWith('#')) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = eol + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- Markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

/** Spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null; // '#'
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 96) return FENCE_OPEN.test(line); // '`'
  if (c === 35) return headingOf(line) !== null; // '#'
  if (c === 45 || c === 42) return HR.test(line); // '-' '*'
  if (c === 32 || c === 9) {
    // ' ' or '\t': blank only when the whole line is spaces and tabs.
    for (let k = 0; k < line.length; k++) {
      const cc = line.charCodeAt(k);
      if (cc !== 32 && cc !== 9) return false;
    }
    return true;
  }
  return false;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The characters inline rendering must stop at: the escapable backslash, code/strong/em/link openers, and the escape table. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    // Copy the plain run up to the next special character as-is: it holds none of & < > " '.
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    const j = m === null ? n : m.index;
    if (j > i) out += s.slice(i, j);
    if (m === null) break;
    i = j;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        const nx = s[i + 1];
        out += ESCAPES[nx] ?? nx;
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', i + 1);
      if (k > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const k = findUnescaped(s, '**', i + 2);
        if (k > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const k = findSingleStar(s, i + 1);
        if (k > i + 1) {
          out += `<em>${inline(s.slice(i + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i++;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i++;
      }
      continue;
    }
    // One of & < > " '.
    out += ESCAPES[c];
    i++;
  }
  return out;
}

/**
 * `src` rendered in one pass (lex + render fused): its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env, slugCache) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      // ' ' or '\t': a blank line only when the whole line is spaces and tabs; any other such line is a paragraph line.
      let allWs = true;
      for (let k = 0; k < line.length; k++) {
        const cc = line.charCodeAt(k);
        if (cc !== 32 && cc !== 9) {
          allWs = false;
          break;
        }
      }
      if (allWs) {
        i++;
        continue;
      }
    }
    if (c0 === 96) {
      // '`': a fence?
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !(lines[i].charCodeAt(0) === 96 && FENCE_CLOSE.test(lines[i]))) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`}</code></pre>`);
        continue;
      }
    }
    if (c0 === 35) {
      // '#': a heading?
      const h = headingOf(line);
      if (h !== null) {
        const id = uniqueSlug(slugify(h.text, slugCache), ids);
        const html = inline(h.text, env);
        blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
        i++;
        continue;
      }
    }
    if (c0 === 45 || c0 === 42) {
      // '-' or '*': a thematic break?
      if (HR.test(line)) {
        blocks.push('<hr>');
        i++;
        continue;
      }
    }
    if (c0 === 62) {
      // '>': a blockquote.
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const ls = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') ls.push(t);
      }
      blocks.push(ls.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(ls.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    // A list?
    let bullet = null;
    let ordered = null;
    if (c0 === 45 || c0 === 42) bullet = BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const start = isOrdered ? Number(ordered[1]) : 1;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (lines[i].charCodeAt(0) === 32 && lines[i].charCodeAt(1) === 32 && CONTINUED.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (let k = 0; k < items.length; k++) s += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      s += `</${tag}>`;
      blocks.push(s);
      continue;
    }
    // A paragraph: this line and the lines after it up to a blank line, a fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
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
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
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
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/**
 * escapeHtml(textOf(v)) in one step: numbers and booleans have no escapable character, and escaping an
 * array's items before joining them is the same as escaping the joined text (", " holds none).
 */
function escTextOf(v) {
  if (typeof v === 'string') return escapeHtml(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(escTextOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ v, p }) into `out` (joined once by the caller).
 * `templates` holds the parsed templates; `depth` is the include depth.
 * This is the fallback renderer; the compiled functions below render the same nodes.
 */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escTextOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          renderNodes(n.body, { v: { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } }, p: scope }, templates, depth, out);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

/** First-name lookup for compiled templates: the nearest scope holding `name`, or undefined. */
function lk(S, name) {
  let s = S;
  while (s !== null && !Object.hasOwn(s.v, name)) s = s.p;
  return s === null ? undefined : s.v[name];
}

/** One more path step for compiled templates: an own property, or undefined. */
function prop(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** The helpers a compiled template function receives as `H`. */
const HELPERS = { esc: escapeHtml, textOf, escTextOf, truthy, lk, prop };

/** Code for the value at `path` in the scope variable `scopeVar`. */
function genGet(path, scopeVar) {
  let code = `H.lk(${scopeVar},${JSON.stringify(path[0])})`;
  for (let k = 1; k < path.length; k++) code = `H.prop(${code},${JSON.stringify(path[k])})`;
  return code;
}

/** Code for `nodes` rendered in the scope variable `scopeVar`, appended to `out` (code lines). */
function genNodes(nodes, scopeVar, out, tmp) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') out.push(`out.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var') out.push(`out.push(H.escTextOf(${genGet(n.path, scopeVar)}));`);
    else if (n.kind === 'raw') out.push(`out.push(H.textOf(${genGet(n.path, scopeVar)}));`);
    else if (n.kind === 'if') {
      out.push(`if(H.truthy(${genGet(n.path, scopeVar)})!==${n.not}){`);
      genNodes(n.then, scopeVar, out, tmp);
      if (n.else !== null) {
        out.push('}else{');
        genNodes(n.else, scopeVar, out, tmp);
      }
      out.push('}');
    } else if (n.kind === 'for') {
      const id = ++tmp.n;
      const xv = `_x${id}`;
      const kv = `_k${id}`;
      const sv = `_s${id}`;
      const lv = `_l${id}`;
      // One frame and one loop object per execution of this loop, rebound each iteration: nothing keeps a scope
      // or a loop object past the iteration that renders in it, and a re-entrant render of this template is a
      // fresh activation with its own variables. The loop binding is set after the element, as in the reference's
      // object literal, so a loop variable named "loop" still loses to the loop object.
      out.push(`var ${xv}=${genGet(n.path, scopeVar)};if(Array.isArray(${xv})){var ${sv}={v:{},p:${scopeVar}};var ${lv}={index:0,first:false,last:false,length:${xv}.length};for(var ${kv}=0;${kv}<${xv}.length;${kv}++){${sv}.v[${JSON.stringify(n.name)}]=${xv}[${kv}];${sv}.v.loop=${lv};${lv}.index=${kv}+1;${lv}.first=${kv}===0;${lv}.last=${kv}===${xv}.length-1;`);
      genNodes(n.body, sv, out, tmp);
      out.push('}}');
    } else if (n.kind === 'include') {
      const id = ++tmp.n;
      const tv = `_t${id}`;
      out.push(`var ${tv}=T.get(${JSON.stringify(n.name)});if(${tv}!==undefined&&D<8)${tv}(${scopeVar},out,T,D+1,H);`);
    }
  }
}

/**
 * `nodes` compiled to a render function (S, out, T, D, H): S the scope ({ v, p }),
 * out the output array, T the compiled templates by name, D the include depth,
 * H the helpers. Throws when the Function constructor is unavailable.
 */
function compileTemplate(nodes) {
  const lines = [];
  genNodes(nodes, 'S', lines, { n: 0 });
  return new Function('S', 'out', 'T', 'D', 'H', lines.join('\n'));
}

/** The template names `nodes` includes directly, anywhere in its tree. */
function directIncludes(nodes) {
  const out = new Set();
  const walk = (ns) => {
    for (const n of ns) {
      if (n.kind === 'include') out.add(n.name);
      else if (n.kind === 'if') {
        walk(n.then);
        if (n.else !== null) walk(n.else);
      } else if (n.kind === 'for') walk(n.body);
    }
  };
  walk(nodes);
  return out;
}

/**
 * The first-segment names `nodes` reads that are not bound by an enclosing for loop (`bound`),
 * following includes through `free` (each template's own set, computed with no names bound).
 * A read of a name bound at the include site is not free: the included template's set loses it.
 */
function freeNamesOf(nodes, bound, free) {
  const out = new Set();
  const walk = (ns, b) => {
    for (const n of ns) {
      if (n.kind === 'text') continue;
      if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
        if (!b.has(n.path[0])) out.add(n.path[0]);
        if (n.kind === 'if') {
          walk(n.then, b);
          if (n.else !== null) walk(n.else, b);
        }
      } else if (n.kind === 'for') {
        if (!b.has(n.path[0])) out.add(n.path[0]);
        const b2 = new Set(b);
        b2.add(n.name);
        b2.add('loop');
        walk(n.body, b2);
      } else if (n.kind === 'include') {
        const f = free.get(n.name);
        if (f !== undefined) for (const name of f) if (!b.has(name)) out.add(name);
      }
    }
  };
  walk(nodes, bound);
  return out;
}

/**
 * The longest chain of includes starting at `name`, in edges (0 when it includes nothing),
 * or Infinity when the chain reaches a cycle. Memoised in `memo`.
 */
function includeChainLen(name, templates, visiting, memo) {
  if (memo.has(name)) return memo.get(name);
  if (visiting.has(name)) return Infinity;
  const nodes = templates.get(name);
  if (nodes === undefined) {
    memo.set(name, 0);
    return 0;
  }
  visiting.add(name);
  let k = 0;
  for (const inc of directIncludes(nodes)) {
    const sub = includeChainLen(inc, templates, visiting, memo);
    if (sub === Infinity) {
      visiting.delete(name);
      memo.set(name, Infinity);
      return Infinity;
    }
    if (sub + 1 > k) k = sub + 1;
  }
  visiting.delete(name);
  memo.set(name, k);
  return k;
}

// ---------------------------------------------------------------- the build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
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

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  // name -> parsed nodes, and name -> compiled render function (null when a template did not parse).
  const templates = new Map();
  const compiled = new Map();
  let useCompiled = true;
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      const nodes = parseTemplate(name, input.templates[name]);
      templates.set(name, nodes);
      compiled.set(name, compileTemplate(nodes));
    } catch (err) {
      if (err instanceof TemplateError) {
        report.push(err.message);
      } else if (err instanceof SyntaxError || err instanceof ReferenceError || err instanceof TypeError) {
        // The Function constructor (or the generated code) is unavailable: fall back to the tree renderer.
        useCompiled = false;
      } else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const output = {};

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const names = s.data.tags ?? [];
    for (let k = 0; k < names.length; k++) {
      const sl = slugify(names[k], slugCache);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(names[k]);
      }
    }
    return out;
  };
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const names = ownTags(p);
    for (let k = 0; k < names.length; k++) {
      const name = names[k];
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A post's card, as lists show it — computed once per source and reused.
  const cardOf = (s) => {
    let c = s.card;
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = c;
    return c;
  };

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) });

  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  if (useCompiled) {
    // Templates that read only site, tags and recent render the same on every page (the header, the nav,
    // the filler partials that do not read the page): render each once with the root scope and reuse the
    // string at every include site. A template whose include chain reaches a cycle is never reused: its
    // output would depend on the depth it is entered at. The wrapper falls back to the real render when
    // the entry depth plus the template's longest include chain could reach the depth limit, so the
    // reused string is only used where the depth limit cannot bind.
    const free = new Map();
    for (const name of templates.keys()) free.set(name, new Set());
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, nodes] of templates) {
        const next = freeNamesOf(nodes, new Set(), free);
        const cur = free.get(name);
        if (next.size !== cur.size || [...next].some((x) => !cur.has(x))) {
          free.set(name, next);
          changed = true;
        }
      }
    }
    const chainMemo = new Map();
    const rootScope = { v: { site, tags: allTags, recent }, p: null };
    const renderedOnce = new Map();
    for (const name of templates.keys()) {
      const f = free.get(name);
      if ([...f].some((x) => x !== 'site' && x !== 'tags' && x !== 'recent')) continue;
      const k = includeChainLen(name, templates, new Set(), chainMemo);
      if (k === Infinity) continue;
      const fn = compiled.get(name);
      if (fn === undefined) continue;
      const out = [];
      fn(rootScope, out, compiled, 0, HELPERS);
      renderedOnce.set(name, { text: out.join(''), fn, k });
    }
    for (const [name, r] of renderedOnce) {
      const { text, fn, k } = r;
      compiled.set(name, (S, o, T, D, H) => {
        if (D + k <= 8) o.push(text);
        else fn(S, o, T, D, H);
      });
    }
  }
  const render = (name, vars) => {
    const scope = { v: { site, tags: allTags, recent, ...vars }, p: null };
    const out = [];
    if (useCompiled) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      fn(scope, out, compiled, 0, HELPERS);
    } else {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      renderNodes(nodes, scope, templates, 0, out);
    }
    return out.join('');
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
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
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
