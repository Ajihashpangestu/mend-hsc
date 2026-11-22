// mend: the CLI SPEC.md specifies (MIT). Sections 1-10 complete.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];
let STRICT = false;

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text split into lines + final-break flag (SPEC.md section 3). */
function fileLines(text: string): { lines: string[]; final: boolean; br: string } {
  if (text === '') return { lines: [], final: false, br: '\n' };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, final, br };
}

function joinLines(lines: string[], final: boolean, br: string): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

/** Tiers (section 5): 0 exact, 1 trailing ws, 2 leading+trailing ws. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) {
    let x = a, y = b;
    while (x.length > 0 && (x.endsWith(' ') || x.endsWith('\t'))) x = x.slice(0, -1);
    while (y.length > 0 && (y.endsWith(' ') || y.endsWith('\t'))) y = y.slice(0, -1);
    return x === y;
  }
  return a.trim() === b.trim();
}

/** All positions where O matches file lines at the given tier. */
function occurrencesAt(file: string[], O: string[], tier: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const last = file.length - O.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(file[i + j]!, O[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (respecting --strict) at which O occurs, or -1. */
function findTier(file: string[], O: string[]): { tier: number; positions: number[] } {
  for (const tier of STRICT ? [0] : [0, 1, 2]) {
    const positions = occurrencesAt(file, O, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return { tier: -1, positions: [] };
}

/** Build the replacement lines N for a match of O at position p in file (section 5).
 * N's ctx markers carry the O-index of the context line. */
function buildN(N: (string | { ctx: number })[], file: string[], p: number, O: string[], tier: number): string[] {
  const out: string[] = [];
  const doReindent = tier === 2;
  const F = leadWs(file[p] ?? '');
  const P = leadWs(O[0] ?? '');
  for (const item of N) {
    if (typeof item === 'object') {
      out.push(file[p + item.ctx] ?? '');
    } else if (doReindent && item !== '' && item.trim() !== '' && item.startsWith(P)) {
      out.push(F + item.slice(P.length));
    } else {
      out.push(item);
    }
  }
  return out;
}

/** The tree as the edits leave it (section 10). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const fl = fileLines(before);
      if (line < 0 || line > fl.lines.length) throw new Fail('no-match', p);
      fl.lines.splice(line, 0, ...add);
      tree.now.set(p, joinLines(fl.lines, fl.final, br));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- section 6: unified

interface HunkBody { ctx: string[]; old: string[]; neu: string[]; }
/** A body line: 0 ctx, 1 old, 2 new; backslash flag captured separately. */
function parseHunkBody(lines: string[], start: number): { O: string[]; N: (string | { ctx: number })[]; end: number; bsAfter: boolean } {
  type Kind = 'ctx' | 'old' | 'new';
  const body: { kind: Kind; text: string }[] = [];
  let i = start;
  let bsAfter = false;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') { body.push({ kind: 'ctx', text: '' }); i++; continue; }
    const c = l[0]!;
    if (c === ' ') { body.push({ kind: 'ctx', text: l.slice(1) }); i++; continue; }
    if (c === '-') { body.push({ kind: 'old', text: l.slice(1) }); i++; continue; }
    if (c === '+') { body.push({ kind: 'new', text: l.slice(1) }); i++; continue; }
    if (c === '\\') {
      // `\` refers to the body line before it; flag when it follows the last ctx/new line
      const last = body[body.length - 1];
      bsAfter = last !== undefined && (last.kind === 'ctx' || last.kind === 'new');
      i++;
      continue;
    }
    break;
  }
  // trailing empty context lines are not part of the body
  while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
  const O: string[] = [];
  const N: (string | { ctx: number })[] = [];
  body.forEach((b) => {
    if (b.kind === 'ctx') {
      N.push({ ctx: O.length });
      O.push(b.text);
    } else if (b.kind === 'old') O.push(b.text);
    else N.push(b.text);
  });
  return { O, N, end: i, bsAfter };
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(l: string): string | null {
  // l starts with '--- ' or '+++ '
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  return t;
}

function unifiedEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let section: { oldPath: string | null; newPath: string | null; creation: boolean; deletion: boolean; hunks: { A: number; O: string[]; N: (string | { ctx: number })[]; bsAfter: boolean }[] } | null = null;
  const flush = (): void => {
    if (section === null) return;
    const s = section;
    section = null;
    edits.push(makeUnifiedEdit(s));
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      flush();
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [], ...(m ? { gitOld: m[1]!, gitNew: m[2]! } as any : {}) } as any;
      (section as any).gitOld = m![1]!;
      (section as any).gitNew = m![2]!;
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (section === null || (section as any).seenPair || section.hunks.length > 0) {
          flush();
          section = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] } as any;
        }
        const op = headerPath(l);
        const np = headerPath(lines[i + 1]!);
        section.oldPath = op === '/dev/null' ? null : stripPrefix(op ?? '');
        section.newPath = np === '/dev/null' ? null : stripPrefix(np ?? '');
        (section as any).seenPair = true;
        i += 2;
        continue;
      }
      // a --- line not followed by a +++ line, inside a section's header
      if (section !== null && section.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (section !== null && section.hunks.length === 0) {
      if (l.startsWith('rename from ')) { (section as any).renameFrom = l.slice(12).trim(); i++; continue; }
      if (l.startsWith('rename to ')) { (section as any).renameTo = l.slice(10).trim(); i++; continue; }
      if (l.startsWith('new file mode')) { section.creation = true; i++; continue; }
      if (l.startsWith('deleted file mode')) { section.deletion = true; i++; continue; }
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (m === null || section === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = parseHunkBody(lines, i + 1);
      section.hunks.push({ A: parseInt(m[1]!, 10), O: body.O, N: body.N, bsAfter: body.bsAfter });
      i = body.end;
      continue;
    }
    i++;
  }
  flush();
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;

  function makeUnifiedEdit(s: any): Edit {
    const gitOld: string | null = s.gitOld ?? null;
    const gitNew: string | null = s.gitNew ?? null;
    let oldPath: string | null = s.oldPath ?? s.renameFrom ?? gitOld;
    let newPath: string | null = s.newPath ?? s.renameTo ?? gitNew;
    if (s.deletion) newPath = null;
    if (s.creation) oldPath = null;
    return (tree: Tree) => {
      // safety first (section 10), paths as written after prefix removal
      for (const q of [oldPath, newPath]) {
        if (q !== null && !safe(q)) throw new Fail('unsafe', q);
      }
      const creation = s.creation || (oldPath === null && newPath !== null);
      const deletion = s.deletion || (newPath === null && oldPath !== null);
      if (creation) {
        const p = newPath!;
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const content: string[] = [];
        let bsLast = false;
        for (const h of s.hunks) {
          for (const item of h.N) if (typeof item === 'string') content.push(item);
          if (h.bsAfter) bsLast = true;
        }
        void bsLast;
        // ends with a line break unless a `\` line follows its last `+` line
        let final = true;
        const lastHunk = s.hunks[s.hunks.length - 1];
        if (lastHunk !== undefined && lastHunk.bsAfter) final = false;
        tree.now.set(p, joinLines(content, content.length === 0 ? false : final, '\n'));
        return;
      }
      if (deletion) {
        const p = oldPath!;
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (oldPath !== null && newPath !== null && oldPath !== newPath) {
        // move
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const { lines: fl, final, br } = fileLines(tree.get(oldPath)!);
        let cur = fl.slice();
        let fin = final;
        let d = 0;
        for (const h of s.hunks) {
          const r = applyHunk(cur, fin, h, d, oldPath);
          cur = r.lines; fin = r.final;
          d += h.N.length - h.O.length;
        }
        tree.now.set(oldPath, null);
        tree.now.set(newPath, joinLines(cur, fin, br));
        tree.moves.push([oldPath, newPath]);
        return;
      }
      // change of the one path
      const p = oldPath ?? newPath!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const { lines: fl, final, br } = fileLines(tree.get(p)!);
      let cur = fl.slice();
      let fin = final;
      let d = 0;
      for (const h of s.hunks) {
        const r = applyHunk(cur, fin, h, d, p);
        cur = r.lines; fin = r.final;
        d += h.N.length - h.O.length;
      }
      tree.now.set(p, joinLines(cur, fin, br));
    };
  }

  function applyHunk(cur: string[], fin: boolean, h: any, d: number, path: string): { lines: string[]; final: boolean } {
    if (h.O.length === 0) {
      // insert after the first A + d lines (all of them when the file has fewer)
      const idx = Math.min(h.A + d, cur.length);
      const newLines = (h.N as (string | { ctx: number })[]).map((x) => (typeof x === 'string' ? x : ''));
      const atEnd = idx === cur.length;
      const out = cur.slice(0, idx).concat(newLines, cur.slice(idx));
      let f = fin;
      if (atEnd) f = !h.bsAfter;
      return { lines: out, final: f };
    }
    const { tier, positions } = findTier(cur, h.O);
    if (tier < 0) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = positions[0]!;
    for (const pos of positions) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const replacement = buildN(h.N, cur, best, h.O, tier, true);
    const atEnd = best + h.O.length === cur.length;
    const out = cur.slice(0, best).concat(replacement, cur.slice(best + h.O.length));
    let f = fin;
    if (atEnd) f = !h.bsAfter;
    return { lines: out, final: f };
  }
}

// ---------------------------------------------------------- section 7: search-replace

function searchReplaceEdits(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let lastPath: string | null = null;
  let prevReplace = -1;
  type Block = { path: string; searchLine: number; old: string[]; neu: string[] };
  const blocks: Block[] = [];
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i;
    // find path
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = lastPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    lastPath = path;
    // find =======
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    // find >>>>>>> REPLACE
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, searchLine, old: lines.slice(searchLine + 1, eq) as string[], neu: lines.slice(eq + 1, rep) as string[] });
    prevReplace = rep;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  for (const b of blocks) {
    const p = b.path;
    const old = b.old;
    const neu = b.neu;
    edits.push((tree: Tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinLines(neu.slice(), true, '\n'));
        return;
      }
      if (tree.get(p) === null) throw new Fail('missing', p);
      const { lines: fl, final, br } = fileLines(tree.get(p)!);
      const { tier, positions } = findTier(fl, old);
      if (tier < 0) throw new Fail('no-match', p);
      if (positions.length > 1) throw new Fail('ambiguous', p);
      const pos = positions[0]!;
      const replacement = buildN(neu.map((x) => x as string), fl, pos, old, tier, false);
      tree.now.set(p, joinLines(fl.slice(0, pos).concat(replacement, fl.slice(pos + old.length)), final, br));
    });
  }
  return edits;
}

// ---------------------------------------------------------------- section 8: V4A

function v4aEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${(first < 0 ? 1 : first + 1)}`);
  const last = (() => { for (let j = lines.length - 1; j >= 0; j--) if (!blank(lines[j]!)) return j; return -1; })();
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  type Chunk = { anchor: string | null; eof: boolean; O: string[]; N: (string | { ctx: number })[] };
  type Section = { kind: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; addLines: string[]; chunks: Chunk[]; declLine: number };
  const sections: Section[] = [];
  let i = first + 1;
  let cur: Section | null = null;
  let chunk: Chunk | null = null;
  let inChunk = false;
  const endChunk = (): void => { chunk = null; inChunk = false; };
  const parseChunkO = (c: Chunk): void => {
    // body lines were collected as raw with kinds
  };
  void parseChunkO;
  const bodyKinds: string[] = []; // parallel raw lines of current chunk: 'ctx'/'old'/'new'
  const flushSection = (): void => {
    if (cur !== null) {
      // blank lines at the end of a section are not part of it (drop trailing empty context lines)
      if (cur.kind === 'update' && cur.chunks.length > 0) {
        const lastChunk = cur.chunks[cur.chunks.length - 1] as any;
        while (lastChunk.O.length > 0 && lastChunk.O[lastChunk.O.length - 1] === '' && typeof lastChunk.N[lastChunk.N.length - 1] === 'object') {
          lastChunk.O.pop(); lastChunk.N.pop();
        }
      }
      if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.declLine + 1}`);
      sections.push(cur);
    }
    cur = null;
    endChunk();
    bodyKinds.length = 0;
  };
  while (i <= last) {
    const l = lines[i]!;
    const t = l.trim();
    if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) {
      flushSection();
      const kind = t.startsWith('*** Add File: ') ? 'add' : t.startsWith('*** Delete File: ') ? 'delete' : 'update';
      cur = { kind, path: t.slice(t.indexOf(':') + 1).trim(), moveTo: null, addLines: [], chunks: [], declLine: i };
      i++;
      continue;
    }
    if (t === '*** End Patch') {
      if (i === last) break;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    if (t === '*** End of File') {
      if (chunk === null || cur.kind !== 'update') throw new Exit2(`error: parse ${i + 1}`);
      (chunk as any).eof = true;
      endChunk();
      bodyKinds.length = 0;
      i++;
      continue;
    }
    if (cur.kind === 'add') {
      if (l === '') { cur.addLines.push(''); i++; continue; }
      if (l.startsWith('+')) { cur.addLines.push(l.slice(1)); i++; continue; }
      if (blank(l) && false) { i++; continue; }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (cur.kind === 'delete') {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    // update
    if (chunk === null && !inChunk) {
      if (t.startsWith('*** Move to: ') && cur.moveTo === null && cur.chunks.length === 0) { cur.moveTo = t.slice(13).trim(); i++; continue; }
      if (l.startsWith('@@')) {
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, O: [], N: [] };
        cur.chunks.push(chunk);
        inChunk = true;
        bodyKinds.length = 0;
        i++;
        continue;
      }
      if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
        // first chunk starts at a body line
        chunk = { anchor: null, eof: false, O: [], N: [] };
        cur.chunks.push(chunk);
        inChunk = true;
        bodyKinds.length = 0;
        // fall through to body handling below
      } else {
        throw new Exit2(`error: parse ${i + 1}`);
      }
    }
    if (chunk !== null) {
      if (l.startsWith('@@')) {
        // new chunk
        const anchor = l.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, O: [], N: [] };
        cur.chunks.push(chunk);
        bodyKinds.length = 0;
        i++;
        continue;
      }
      if (l === '') { (chunk as any).N.push({ ctx: (chunk as any).O.length }); (chunk as any).O.push(''); bodyKinds.push('ctx'); i++; continue; }
      const c = l[0]!;
      if (c === ' ') { (chunk as any).N.push({ ctx: (chunk as any).O.length }); (chunk as any).O.push(l.slice(1)); bodyKinds.push('ctx'); i++; continue; }
      if (c === '-') { (chunk as any).O.push(l.slice(1)); bodyKinds.push('old'); i++; continue; }
      if (c === '+') { (chunk as any).N.push(l.slice(1)); bodyKinds.push('new'); i++; continue; }
      // other line ends the chunk? spec: chunk ends at next section/End Patch/End of File. Any other line is parse error.
      throw new Exit2(`error: parse ${i + 1}`);
    }
    i++;
  }
  flushSection();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const content = s.addLines.slice();
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinLines(content, true, '\n'));
      });
    } else if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = s.path;
      const moveTo = s.moveTo;
      const chunks = s.chunks.map((c) => ({ ...c }));
      edits.push((tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        if (moveTo !== null) {
          if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
          if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        }
        const { lines: fl0, final, br } = fileLines(tree.get(p)!);
        let curL = fl0.slice();
        let fin = final;
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            let found = -1;
            for (const tier of [0, 1, 2]) {
              for (let j = cursor; j < curL.length; j++) {
                if (tierEq(curL[j]!, ch.anchor, tier)) { found = j; break; }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', p);
            cursor = found + 1;
          }
          const limit = ch.eof ? curL.length : curL.length;
          // find first occurrence of O at/after cursor at first tier
          let tier = -1;
          let pos = -1;
          if (ch.O.length === 0) {
            pos = ch.eof ? curL.length : Math.min(cursor, curL.length);
            tier = 0;
          } else {
            for (const t of [0, 1, 2]) {
              for (let j = cursor; j + ch.O.length <= limit; j++) {
                let ok = true;
                for (let k = 0; k < ch.O.length; k++) {
                  if (!tierEq(curL[j + k]!, ch.O[k]!, t)) { ok = false; break; }
                }
                if (ok) { tier = t; pos = j; break; }
              }
              if (tier >= 0) break;
            }
            if (tier < 0) throw new Fail('no-match', p);
          }
          let replacement: string[];
          if (ch.O.length === 0) {
            replacement = ch.N.map((x) => (typeof x === 'string' ? x : ''));
          } else {
            replacement = buildN(ch.N, curL, pos, ch.O, tier, false);
          }
          curL = curL.slice(0, pos).concat(replacement, curL.slice(pos + ch.O.length));
          cursor = pos + replacement.length;
        }
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, joinLines(curL, fin, br));
          tree.moves.push([p, moveTo]);
        } else {
          tree.now.set(p, joinLines(curL, fin, br));
        }
      });
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  STRICT = strict;
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines);
    else if (kind === 'v4a') edits = v4aEdits(lines);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // rows with R-move handling (section 2)
  type Row = { key: string; text: string };
  const rows: Row[] = [];
  const used = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.get(oldP) ?? null;
    const nowNew = tree.now.get(newP) ?? null;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      used.add(oldP); used.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (used.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
