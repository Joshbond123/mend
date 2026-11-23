// mend: apply AI-written edits in four formats to a tree of text files.
// The contract is SPEC.md (version 1); this file implements it exactly.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// errors

class ParseError {
  line: number;
  constructor(line: number) {
    this.line = line;
  }
}

class UsageError {}

const parseErr = (line: number): ParseError => new ParseError(line);

// ---------------------------------------------------------------------------
// lines, files, paths

const stripTrailing = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const isBlank = (s: string): boolean => stripBoth(s) === '';

type FileState = { lines: string[]; endsWithBreak: boolean; eol: string };

function parseFileText(text: string): FileState {
  const nl = text.indexOf('\n');
  const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], endsWithBreak: false, eol };
  const parts = text.split(eol);
  const ends = text.endsWith(eol);
  if (ends) parts.pop();
  return { lines: parts, endsWithBreak: ends, eol };
}

function serializeFile(s: FileState): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.eol) + (s.endsWithBreak ? s.eol : '');
}

function safePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.indexOf('\\') !== -1) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// matching tiers

function lineMatches(a: string, b: string, tier: number): boolean {
  if (a === b) return true;
  if (tier === 0) return false;
  if (stripTrailing(a) === stripTrailing(b)) return true;
  if (tier === 1) return false;
  return stripBoth(a) === stripBoth(b);
}

function occurrencesAt(file: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const m = o.length;
  if (m === 0) return out;
  for (let i = 0; i + m <= file.length; i += 1) {
    let ok = true;
    for (let j = 0; j < m; j += 1) {
      if (!lineMatches(file[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

type TierMatch = { tier: number; occ: number[] };

function findTier(file: string[], o: string[], strict: boolean): TierMatch | null {
  const last = strict ? 0 : 2;
  for (let t = 0; t <= last; t += 1) {
    const occ = occurrencesAt(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// Re-indent one N line at tier 2: a non-blank line that starts with P gets P
// replaced by F, the leading whitespace of the file's first matched line.
function reindentLine(line: string, f: string, p: string, tier: number): string {
  if (tier !== 2) return line;
  if (line === '' || stripBoth(line) === '') return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

// ---------------------------------------------------------------------------
// the virtual tree

class Tree {
  current = new Map<string, string | null>();
  initial = new Map<string, string | null>();
  touched = new Set<string>();

  read(p: string): string | null {
    if (this.current.has(p)) return this.current.get(p) as string | null;
    let value: string | null = null;
    try {
      const st = statSync(p);
      if (st.isFile()) value = readFileSync(p, 'utf8');
    } catch {
      value = null;
    }
    this.current.set(p, value);
    if (!this.initial.has(p)) this.initial.set(p, value);
    this.touched.add(p);
    return value;
  }

  set(p: string, text: string): void {
    this.current.set(p, text);
    if (!this.initial.has(p)) this.initial.set(p, null);
    this.touched.add(p);
  }

  remove(p: string): void {
    this.current.set(p, null);
    if (!this.initial.has(p)) this.initial.set(p, null);
    this.touched.add(p);
  }

  exists(p: string): boolean {
    return this.read(p) !== null;
  }
}

// ---------------------------------------------------------------------------
// edits

type EditResult = { ok: true } | { ok: false; code: string; path: string };

type Edit = {
  apply(tree: Tree, strict: boolean): EditResult;
};

const fail = (code: string, path: string): EditResult => ({ ok: false, code, path });

// A file changed by an edit: its state before, and the new state or null.
type Mutation = { path: string; state: FileState | null };

// ---------------------------------------------------------------------------
// unified diffs

type Hunk = { a: number; body: string[] };

type USection = {
  gitOld: string | null;
  gitNew: string | null;
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
};

function newSection(): USection {
  return {
    gitOld: null,
    gitNew: null,
    oldPath: null,
    newPath: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

// `--- <path>` / `+++ <path>`: text after four chars, up to the first tab,
// surrounding spaces removed, `/dev/null` means no file, a/ or b/ removed.
function dashPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab !== -1) rest = rest.slice(0, tab);
  rest = rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (rest === '/dev/null') return null;
  return stripAB(rest);
}

function parseUnified(l: string[]): USection[] {
  const sections: USection[] = [];
  let i = 0;
  while (i < l.length) {
    const line = l[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw parseErr(i + 1);
      const sec = newSection();
      sec.gitOld = stripAB(m[1]);
      sec.gitNew = stripAB(m[2]);
      i += 1;
      i = parseSection(sec, l, i);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < l.length && l[i + 1].startsWith('+++ ')) {
      const sec = newSection();
      i = parseSection(sec, l, i);
      sections.push(sec);
      continue;
    }
    if (line.startsWith('@@')) throw parseErr(i + 1);
    i += 1;
  }
  return sections;
}

function parseSection(sec: USection, l: string[], i: number): number {
  while (i < l.length) {
    const line = l[i];
    if (line.startsWith('@@')) return parseHunks(sec, l, i);
    if (line.startsWith('diff --git ')) return i;
    if (line.startsWith('--- ')) {
      if (i + 1 < l.length && l[i + 1].startsWith('+++ ')) {
        sec.oldPath = dashPath(line);
        sec.newPath = dashPath(l[i + 1]);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      throw parseErr(i + 2);
    }
    if (line.startsWith('rename from ')) {
      sec.renameFrom = line.slice('rename from '.length);
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      sec.renameTo = line.slice('rename to '.length);
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      sec.isCreate = true;
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      sec.isDelete = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return i;
}

function parseHunks(sec: USection, l: string[], i: number): number {
  while (i < l.length) {
    const line = l[i];
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw parseErr(i + 1);
      const a = parseInt(m[1], 10);
      i += 1;
      const body: string[] = [];
      while (i < l.length) {
        const b = l[i];
        if (b.startsWith('@@')) break;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < l.length && l[i + 1].startsWith('+++ ')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push({ a, body });
      continue;
    }
    return i;
  }
  return i;
}

// The body line after the last context or `+` line is a `\` line?
function noFinalBreak(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    const b = body[k];
    if (b === '' || b[0] === ' ' || b[0] === '+') last = k;
  }
  if (last === -1) return false;
  return last + 1 < body.length && body[last + 1].startsWith('\\');
}

type NEntry = { text: string; ctx: number | null };

function hunkLines(body: string[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const b of body) {
    if (b === '') {
      o.push('');
      n.push({ text: '', ctx: o.length - 1 });
    } else if (b[0] === ' ') {
      o.push(b.slice(1));
      n.push({ text: b.slice(1), ctx: o.length - 1 });
    } else if (b[0] === '-') {
      o.push(b.slice(1));
    } else if (b[0] === '+') {
      n.push({ text: b.slice(1), ctx: null });
    }
  }
  return { o, n };
}

// A context line is written as the file's own matched line; every other line of
// N is written as it is (or re-indented at tier 2).
function buildReplacement(n: NEntry[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  const f = o.length > 0 ? leadingWs(fileLines[pos]) : '';
  const p = o.length > 0 ? leadingWs(o[0]) : '';
  return n.map((e) => (e.ctx !== null ? fileLines[pos + e.ctx] : reindentLine(e.text, f, p, tier)));
}

class UnifiedEdit implements Edit {
  sec: USection;

  constructor(sec: USection) {
    this.sec = sec;
  }

  paths(): { old: string | null; next: string | null } {
    const s = this.sec;
    let oldP: string | null;
    let newP: string | null;
    if (s.hasPair) {
      oldP = s.oldPath;
      newP = s.newPath;
    } else if (s.renameFrom !== null || s.renameTo !== null) {
      oldP = s.renameFrom !== null ? s.renameFrom : s.gitOld;
      newP = s.renameTo !== null ? s.renameTo : s.gitNew;
    } else {
      oldP = s.gitOld;
      newP = s.gitNew;
    }
    return { old: oldP, next: newP };
  }

  movePair(): { from: string; to: string } | null {
    const { old: oldP, next: newP } = this.paths();
    if (oldP === null || newP === null || oldP === newP) return null;
    const creation = this.sec.isCreate || oldP === null;
    const deletion = !creation && (this.sec.isDelete || newP === null);
    if (creation || deletion) return null;
    return { from: oldP, to: newP };
  }

  apply(tree: Tree, strict: boolean): EditResult {
    const { old: oldP, next: newP } = this.paths();
    const creation = this.sec.isCreate || oldP === null;
    const deletion = !creation && (this.sec.isDelete || newP === null);

    // safety, before anything else
    if (oldP !== null && !safePath(oldP)) return fail('unsafe', oldP);
    if (newP !== null && !safePath(newP)) return fail('unsafe', newP);

    if (creation) {
      const target = newP !== null ? newP : oldP;
      if (target === null) return fail('missing', '');
      if (tree.exists(target)) return fail('exists', target);
      const lines: string[] = [];
      let lastPlus: string[] | null = null;
      let lastPlusAt = -1;
      for (const h of this.sec.hunks) {
        for (let k = 0; k < h.body.length; k += 1) {
          if (h.body[k][0] === '+') {
            lines.push(h.body[k].slice(1));
            lastPlus = h.body;
            lastPlusAt = k;
          }
        }
      }
      let ends = true;
      if (lastPlus !== null && lastPlusAt + 1 < (lastPlus as string[]).length && (lastPlus as string[])[lastPlusAt + 1].startsWith('\\')) {
        ends = false;
      }
      tree.set(target, serializeFile({ lines, endsWithBreak: ends, eol: '\n' }));
      return { ok: true };
    }

    if (deletion) {
      const target = oldP !== null ? oldP : newP;
      if (target === null) return fail('missing', '');
      if (!tree.exists(target)) return fail('missing', target);
      tree.remove(target);
      return { ok: true };
    }

    // change or move
    const src = oldP as string;
    const dst = newP as string;
    const text = tree.read(src);
    if (text === null) return fail('missing', src);
    const isMove = src !== dst;
    if (isMove && tree.exists(dst)) return fail('exists', dst);

    const st = parseFileText(text);
    const lines = st.lines.slice();
    let ends = st.endsWithBreak;
    let d = 0;
    for (const h of this.sec.hunks) {
      const { o, n } = hunkLines(h.body);
      if (o.length > 0) {
        const found = findTier(lines, o, strict);
        if (found === null) return fail('no-match', src);
        const target = h.a - 1 + d;
        let best = found.occ[0];
        let bestDist = Math.abs(best - target);
        for (const pos of found.occ) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const repl = buildReplacement(n, lines, best, o, found.tier);
        const runsToEnd = best + o.length === lines.length;
        if (runsToEnd) ends = !noFinalBreak(h.body);
        lines.splice(best, o.length, ...repl);
        d += n.length - o.length;
      } else {
        let pos = h.a + d;
        if (pos < 0) pos = 0;
        if (pos > lines.length) pos = lines.length;
        const runsToEnd = pos === lines.length;
        if (runsToEnd) ends = !noFinalBreak(h.body);
        lines.splice(pos, 0, ...n.map((e) => e.text));
        d += n.length;
      }
    }

    const out = serializeFile({ lines, endsWithBreak: ends, eol: st.eol });
    if (isMove) {
      tree.set(dst, out);
      tree.remove(src);
    } else {
      tree.set(src, out);
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks

type SRBlock = { path: string; old: string[]; next: string[] };

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_SEP = '=======';
const SR_END = '>>>>>>> REPLACE';

function parseSearchReplace(l: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < l.length) {
    if (stripTrailing(l[i]) !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const raw = l[j];
      if (isBlank(raw)) continue;
      const t = raw.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseErr(searchLine);

    let k = i + 1;
    const oldLines: string[] = [];
    while (k < l.length && stripTrailing(l[k]) !== SR_SEP) {
      oldLines.push(l[k]);
      k += 1;
    }
    if (k >= l.length) throw parseErr(searchLine);
    let m = k + 1;
    const newLines: string[] = [];
    while (m < l.length && stripTrailing(l[m]) !== SR_END) {
      newLines.push(l[m]);
      m += 1;
    }
    if (m >= l.length) throw parseErr(searchLine);
    blocks.push({ path, old: oldLines, next: newLines });
    prevPath = path;
    prevEnd = m + 1;
    i = m + 1;
  }
  return blocks;
}

class SearchReplaceEdit implements Edit {
  block: SRBlock;

  constructor(block: SRBlock) {
    this.block = block;
  }

  apply(tree: Tree, strict: boolean): EditResult {
    const { path, old, next } = this.block;
    if (!safePath(path)) return fail('unsafe', path);
    if (old.length === 0) {
      if (tree.exists(path)) return fail('exists', path);
      tree.set(path, serializeFile({ lines: next, endsWithBreak: true, eol: '\n' }));
      return { ok: true };
    }
    const text = tree.read(path);
    if (text === null) return fail('missing', path);
    const st = parseFileText(text);
    const lines = st.lines;
    const found = findTier(lines, old, strict);
    if (found === null) return fail('no-match', path);
    if (found.occ.length !== 1) return fail('ambiguous', path);
    const pos = found.occ[0];
    const repl = next.map((line) => reindentLine(line, leadingWs(lines[pos]), leadingWs(old[0]), found.tier));
    const out = lines.slice(0, pos).concat(repl, lines.slice(pos + old.length));
    tree.set(path, serializeFile({ lines: out, endsWithBreak: st.endsWithBreak, eol: st.eol }));
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// V4A patches

type V4AChunk = { anchor: string | null; endOfFile: boolean; body: string[] };
type V4ASection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[] };

function v4aPath(line: string, prefix: string): string {
  const rest = line.slice(prefix.length);
  return rest.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function parseV4A(l: string[]): V4ASection[] {
  const nonBlank: number[] = [];
  for (let i = 0; i < l.length; i += 1) {
    if (!isBlank(l[i])) nonBlank.push(i);
  }
  if (nonBlank.length === 0) throw parseErr(1);
  const first = nonBlank[0];
  if (stripBoth(l[first]) !== '*** Begin Patch') throw parseErr(first + 1);
  const last = nonBlank[nonBlank.length - 1];
  if (stripBoth(l[last]) !== '*** End Patch') throw parseErr(l.length + 1);

  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = l[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = v4aPath(line, '*** Add File: ');
      i += 1;
      const lines: string[] = [];
      while (i < last) {
        const b = l[i];
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
        if (b === '') {
          lines.push('');
          i += 1;
          continue;
        }
        if (b[0] === '+') {
          lines.push(b.slice(1));
          i += 1;
          continue;
        }
        throw parseErr(i + 1);
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      sections.push({ kind: 'add', path, lines });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = v4aPath(line, '*** Delete File: ');
      i += 1;
      while (i < last) {
        const b = l[i];
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
        if (isBlank(b)) {
          i += 1;
          continue;
        }
        throw parseErr(i + 1);
      }
      sections.push({ kind: 'delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = v4aPath(line, '*** Update File: ');
      const updateLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      if (i < last && l[i].startsWith('*** Move to: ')) {
        moveTo = v4aPath(l[i], '*** Move to: ');
        i += 1;
      }
      const bodyIdx: number[] = [];
      while (i < last) {
        const b = l[i];
        if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
        bodyIdx.push(i);
        i += 1;
      }
      while (bodyIdx.length > 0 && isBlank(l[bodyIdx[bodyIdx.length - 1]])) bodyIdx.pop();
      const chunks = parseV4AChunks(l, bodyIdx);
      if (chunks.length === 0 && moveTo === null) throw parseErr(updateLine);
      sections.push({ kind: 'update', path, moveTo, chunks });
      continue;
    }
    throw parseErr(i + 1);
  }
  return sections;
}

function parseV4AChunks(l: string[], idxs: number[]): V4AChunk[] {
  const chunks: V4AChunk[] = [];
  let k = 0;
  while (k < idxs.length) {
    let anchor: string | null = null;
    if (l[idxs[k]].startsWith('@@')) {
      const text = l[idxs[k]].slice(2).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      anchor = text === '' ? null : text;
      k += 1;
    } else if (chunks.length > 0) {
      throw parseErr(idxs[k] + 1);
    }
    const body: string[] = [];
    let endOfFile = false;
    while (k < idxs.length) {
      const b = l[idxs[k]];
      if (b.startsWith('@@')) break;
      if (b === '*** End of File') {
        endOfFile = true;
        k += 1;
        break;
      }
      if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
        body.push(b);
        k += 1;
        continue;
      }
      throw parseErr(idxs[k] + 1);
    }
    chunks.push({ anchor, endOfFile, body });
  }
  return chunks;
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const last = strict ? 0 : 2;
  for (let t = 0; t <= last; t += 1) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineMatches(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

class V4AEdit implements Edit {
  sec: V4ASection;

  constructor(sec: V4ASection) {
    this.sec = sec;
  }

  apply(tree: Tree, strict: boolean): EditResult {
    const sec = this.sec;
    if (!safePath(sec.path)) return fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.exists(sec.path)) return fail('exists', sec.path);
      tree.set(sec.path, serializeFile({ lines: sec.lines.slice(), endsWithBreak: true, eol: '\n' }));
      return { ok: true };
    }
    if (sec.kind === 'delete') {
      if (!tree.exists(sec.path)) return fail('missing', sec.path);
      tree.remove(sec.path);
      return { ok: true };
    }
    if (sec.moveTo !== null && !safePath(sec.moveTo)) return fail('unsafe', sec.moveTo);
    const text = tree.read(sec.path);
    if (text === null) return fail('missing', sec.path);
    const isMove = sec.moveTo !== null && sec.moveTo !== sec.path;
    if (isMove && tree.exists(sec.moveTo as string)) return fail('exists', sec.moveTo as string);

    const st = parseFileText(text);
    const lines = st.lines.slice();
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(lines, chunk.anchor, cursor, strict);
        if (at === -1) return fail('no-match', sec.path);
        cursor = at + 1;
      }
      const { o, n } = hunkLines(chunk.body);
      if (o.length === 0) {
        let pos: number;
        if (chunk.endOfFile) pos = lines.length;
        else {
          pos = cursor;
          if (pos > lines.length) pos = lines.length;
        }
        lines.splice(pos, 0, ...n.map((e) => e.text));
        cursor = pos + n.length;
        continue;
      }
      let found: TierMatch | null = null;
      for (let t = 0; t <= (strict ? 0 : 2); t += 1) {
        const occ = occurrencesAt(lines, o, t).filter((p) => {
          if (p < cursor) return false;
          if (chunk.endOfFile && p + o.length !== lines.length) return false;
          return true;
        });
        if (occ.length > 0) {
          found = { tier: t, occ };
          break;
        }
      }
      if (found === null) return fail('no-match', sec.path);
      const pos = found.occ[0];
      const repl = buildReplacement(n, lines, pos, o, found.tier);
      lines.splice(pos, o.length, ...repl);
      cursor = pos + n.length;
    }

    const out = serializeFile({ lines, endsWithBreak: st.endsWithBreak, eol: st.eol });
    if (isMove) {
      tree.set(sec.moveTo as string, out);
      tree.remove(sec.path);
    } else {
      tree.set(sec.path, out);
    }
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// JSON edits

type JsonEdit = { kind: 'create'; path: string; fileText: string } | { kind: 'str_replace'; path: string; oldStr: string; newStr: string } | { kind: 'insert'; path: string; insertLine: number; newStr: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonEditFrom(value: unknown): JsonEdit | null {
  if (!isObject(value)) return null;
  const path = value.path;
  const command = value.command;
  if (typeof path !== 'string' || typeof command !== 'string') return null;
  if (command === 'create') {
    if (typeof value.file_text !== 'string') return null;
    return { kind: 'create', path, fileText: value.file_text };
  }
  if (command === 'str_replace') {
    if (typeof value.old_str !== 'string' || value.old_str === '') return null;
    let newStr = '';
    if (value.new_str !== undefined) {
      if (typeof value.new_str !== 'string') return null;
      newStr = value.new_str;
    }
    return { kind: 'str_replace', path, oldStr: value.old_str, newStr };
  }
  if (command === 'insert') {
    if (typeof value.new_str !== 'string') return null;
    if (typeof value.insert_line !== 'number' || !Number.isInteger(value.insert_line)) return null;
    return { kind: 'insert', path, insertLine: value.insert_line, newStr: value.new_str };
  }
  return null;
}

function splitNewStr(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function parseJson(text: string, l: string[]): JsonEdit[] {
  let arrayForm = false;
  let arr: unknown[] | null = null;
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) {
      arrayForm = true;
      arr = v;
    }
  } catch {
    arrayForm = false;
  }
  if (arrayForm) {
    const at = text.indexOf('[');
    let line = 1;
    for (let k = 0; k < at; k += 1) if (text[k] === '\n') line += 1;
    const edits: JsonEdit[] = [];
    for (const item of arr as unknown[]) {
      const e = jsonEditFrom(item);
      if (e === null) throw parseErr(line);
      edits.push(e);
    }
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < l.length; i += 1) {
    if (isBlank(l[i])) continue;
    let v: unknown;
    try {
      v = JSON.parse(l[i]);
    } catch {
      throw parseErr(i + 1);
    }
    const e = jsonEditFrom(v);
    if (e === null) throw parseErr(i + 1);
    edits.push(e);
  }
  return edits;
}

class JsonEditImpl implements Edit {
  edit: JsonEdit;

  constructor(edit: JsonEdit) {
    this.edit = edit;
  }

  apply(tree: Tree, strict: boolean): EditResult {
    const e = this.edit;
    if (!safePath(e.path)) return fail('unsafe', e.path);
    if (e.kind === 'create') {
      if (tree.exists(e.path)) return fail('exists', e.path);
      tree.set(e.path, e.fileText);
      return { ok: true };
    }
    const text = tree.read(e.path);
    if (text === null) return fail('missing', e.path);
    const st = parseFileText(text);
    if (e.kind === 'str_replace') {
      const crlf = st.eol === '\r\n';
      const norm = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const body = norm(text);
      const oldStr = norm(e.oldStr);
      const newStr = norm(e.newStr);
      const occ: number[] = [];
      let from = 0;
      for (;;) {
        const at = body.indexOf(oldStr, from);
        if (at === -1) break;
        occ.push(at);
        from = at + 1;
      }
      if (occ.length === 0) return fail('no-match', e.path);
      if (occ.length > 1) return fail('ambiguous', e.path);
      const at = occ[0];
      const result = body.slice(0, at) + newStr + body.slice(at + oldStr.length);
      const out = crlf ? result.split('\n').join('\r\n') : result;
      tree.set(e.path, out);
      return { ok: true };
    }
    // insert
    const lines = st.lines;
    if (e.insertLine < 0 || e.insertLine > lines.length) return fail('no-match', e.path);
    const ins = splitNewStr(e.newStr);
    const out = lines.slice(0, e.insertLine).concat(ins, lines.slice(e.insertLine));
    tree.set(e.path, serializeFile({ lines: out, endsWithBreak: st.endsWithBreak, eol: st.eol }));
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// format detection

function detectFormat(l: string[]): string {
  let firstNonBlank = -1;
  for (let i = 0; i < l.length; i += 1) {
    if (!isBlank(l[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank !== -1) {
    const first = l[firstNonBlank];
    if (stripBoth(first) === '*** Begin Patch') return 'v4a';
    const m = /\S/.exec(first);
    if (m !== null && (m[0] === '[' || m[0] === '{')) return 'json';
  }
  for (const line of l) {
    if (stripTrailing(line) === SR_SEARCH) return 'search-replace';
  }
  for (let i = 0; i < l.length; i += 1) {
    if (l[i].startsWith('diff --git ')) return 'unified';
    if (l[i].startsWith('--- ') && i + 1 < l.length && l[i + 1].startsWith('+++ ')) return 'unified';
  }
  return '';
}

// ---------------------------------------------------------------------------
// main

type Options = { format: string; check: boolean; strict: boolean; patch: string | null };

function parseArgs(argv: string[]): Options {
  const opts: Options = { format: 'auto', check: false, strict: false, patch: null };
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOfOptions = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg !== '-' && arg.startsWith('-')) {
      if (arg.startsWith('--format=')) {
        if (seenFormat) throw new UsageError();
        seenFormat = true;
        const name = arg.slice('--format='.length);
        if (name !== 'unified' && name !== 'search-replace' && name !== 'v4a' && name !== 'json' && name !== 'auto') {
          throw new UsageError();
        }
        opts.format = name;
        continue;
      }
      if (arg === '--check') {
        if (seenCheck) throw new UsageError();
        seenCheck = true;
        opts.check = true;
        continue;
      }
      if (arg === '--strict') {
        if (seenStrict) throw new UsageError();
        seenStrict = true;
        opts.strict = true;
        continue;
      }
      throw new UsageError();
    }
    positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError();
  opts.patch = positional.length === 1 ? positional[0] : null;
  return opts;
}

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function readPatch(opts: Options): string {
  if (opts.patch === null || opts.patch === '-') {
    try {
      return readFileSync(0, 'utf8');
    } catch {
      throw new NoPatchError();
    }
  }
  try {
    const st = statSync(opts.patch);
    if (!st.isFile()) throw new NoPatchError();
    return readFileSync(opts.patch, 'utf8');
  } catch {
    throw new NoPatchError();
  }
}

class NoPatchError {}

function buildEdits(format: string, text: string, l: string[]): Edit[] {
  let edits: Edit[] = [];
  if (format === 'unified') {
    edits = parseUnified(l).map((s) => new UnifiedEdit(s));
  } else if (format === 'search-replace') {
    edits = parseSearchReplace(l).map((b) => new SearchReplaceEdit(b));
  } else if (format === 'v4a') {
    edits = parseV4A(l).map((s) => new V4AEdit(s));
  } else {
    edits = parseJson(text, l).map((e) => new JsonEditImpl(e));
  }
  if (edits.length === 0) throw parseErr(1);
  return edits;
}

function writeOutput(s: string): void {
  process.stdout.write(s);
}

function run(argv: string[]): number {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch {
    writeOutput('error: usage\n');
    return 2;
  }

  let text: string;
  try {
    text = readPatch(opts);
  } catch {
    writeOutput('error: no-patch\n');
    return 2;
  }

  const l = patchLines(text);
  let format = opts.format;
  if (format === 'auto') {
    format = detectFormat(l);
    if (format === '') {
      writeOutput('error: format\n');
      return 2;
    }
  }

  let edits: Edit[];
  try {
    edits = buildEdits(format, text, l);
  } catch (err) {
    if (err instanceof ParseError) {
      writeOutput(`error: parse ${err.line}\n`);
      return 2;
    }
    throw err;
  }

  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  const moves: { from: string; to: string }[] = [];
  for (const edit of edits) {
    let res: EditResult;
    try {
      res = edit.apply(tree, opts.strict);
    } catch (err) {
      throw err;
    }
    if (res.ok) {
      if (edit instanceof UnifiedEdit) {
        const mv = edit.movePair();
        if (mv !== null) moves.push(mv);
      } else if (edit instanceof V4AEdit && edit.sec.kind === 'update' && edit.sec.moveTo !== null && edit.sec.moveTo !== edit.sec.path) {
        moves.push({ from: edit.sec.path, to: edit.sec.moveTo });
      }
    } else {
      failures.push({ code: res.code, path: res.path });
    }
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    writeOutput(out);
    return 1;
  }

  // compute the changes
  const paths = new Set<string>(tree.touched);
  const before = new Map<string, string | null>();
  const after = new Map<string, string | null>();
  for (const p of paths) {
    before.set(p, tree.initial.has(p) ? (tree.initial.get(p) as string | null) : null);
    after.set(p, tree.current.has(p) ? (tree.current.get(p) as string | null) : null);
  }

  const movePairs = moves.filter((mv) => {
    const b = before.get(mv.from);
    const a = after.get(mv.from);
    const bn = before.get(mv.to);
    const an = after.get(mv.to);
    return b !== null && b !== undefined && a === null && (bn === null || bn === undefined) && an !== null && an !== undefined;
  });
  const movedFrom = new Set(movePairs.map((m) => m.from));
  const movedTo = new Map(movePairs.map((m) => [m.to, m.from]));

  const lines: { key: string; text: string }[] = [];
  for (const p of paths) {
    const b = before.get(p) as string | null;
    const a = after.get(p) as string | null;
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    if (b === null && a !== null) lines.push({ key: p, text: `A ${p}` });
    else if (b !== null && a === null) lines.push({ key: p, text: `D ${p}` });
    else if (b !== null && a !== null && b !== a) lines.push({ key: p, text: `M ${p}` });
  }
  for (const mv of movePairs) {
    lines.push({ key: mv.to, text: `R ${mv.from} -> ${mv.to}` });
  }
  lines.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));

  // write
  if (!opts.check) {
    for (const p of paths) {
      const b = before.get(p) as string | null;
      const a = after.get(p) as string | null;
      if (a === null) {
        if (b !== null) {
          try {
            unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      } else if (a !== b) {
        try {
          mkdirSync(dirname(p), { recursive: true });
        } catch {
          /* ignore */
        }
        writeFileSync(p, a, 'utf8');
      }
    }
  }

  let out = '';
  for (const ln of lines) out += `${ln.text}\n`;
  out += lines.length === 1 ? 'ok: 1 file\n' : `ok: ${lines.length} files\n`;
  writeOutput(out);
  return 0;
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = run(process.argv.slice(2));
}
