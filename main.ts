// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

type MovePair = { old: string; next: string };
let moveLog: MovePair[] = [];
const fileLines = (s: string): { lines: string[]; br: string; final: boolean } => {
  const br = s.includes('\r\n') ? '\r\n' : '\n';
  if (s === '') return { lines: [], br, final: false };
  const final = s.endsWith(br);
  const lines = s.split(br);
  if (final) lines.pop();
  return { lines, br, final };
};
const lead = (s: string): string => s.match(/^[ \t]*/)?.[0] ?? '';
function occurrences(old: string[], cur: string[], strict: boolean, start = 0, endOnly = false): { tier: number; at: number[] } {
  const norm = (s: string, tier: number) => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const at: number[] = [];
    for (let i = Math.max(0, start); i + old.length <= cur.length; i++) {
      if (endOnly && i + old.length !== cur.length) continue;
      if (old.every((x, j) => norm(x, tier) === norm(cur[i + j]!, tier))) at.push(i);
    }
    if (at.length) return { tier, at };
  }
  return { tier: -1, at: [] };
}
function rewrite(old: string[], fresh: string[], cur: string[], pos: number, tier: number, ctx: Map<number, number>): string[] {
  const out = fresh.map((line, j) => {
    if (ctx.has(j)) return cur[pos + ctx.get(j)!]!;
    if (tier !== 2 || line.trim() === '') return line;
    const p = lead(old[0] ?? ''), f = lead(cur[pos] ?? '');
    return line.startsWith(p) ? f + line.slice(p.length) : line;
  });
  return [...cur.slice(0, pos), ...out, ...cur.slice(pos + old.length)];
}
const safePath = (p: string): void => { if (!safe(p)) throw new Fail('unsafe', p); };
function trimContextTail(part: { old: string[]; fresh: string[]; ctx: Map<number, number> }): void {
  while (part.old.at(-1) === '' && part.fresh.at(-1) === '' && part.ctx.has(part.fresh.length - 1)) {
    part.old.pop();
    part.fresh.pop();
    part.ctx.delete(part.fresh.length);
  }
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type H = { line: number; a: number; old: string[]; fresh: string[]; ctx: Map<number, number>; lastNoNl: boolean };
  type S = { old: string; next: string; create: boolean; del: boolean; hunks: H[] };
  const sections: S[] = [];
  let cur: S | null = null, i = 0;
  const strip = (x: string) => x.split('\t', 1)[0]!.trim().replace(/^[ab]\//, '');
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { old: m[1]!, next: m[2]!, create: false, del: false, hunks: [] }; sections.push(cur); i++; continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m || !cur) throw new Exit2(`error: parse ${i + 1}`);
      const h: H = { line: i + 1, a: Number(m[1]), old: [], fresh: [], ctx: new Map(), lastNoNl: false };
      i++;
      let last: 'ctx' | 'add' | null = null;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) break;
        if (b.startsWith('\\')) { if (last) h.lastNoNl = true; i++; continue; }
        if (b === '' || /^[ +\-]/.test(b)) {
          const kind = b === '' ? 'ctx' : b[0] === ' ' ? 'ctx' : b[0] === '+' ? 'add' : 'del';
          const val = b === '' ? '' : b.slice(1);
          if (kind !== 'add') h.old.push(val);
          if (kind !== 'del') { if (kind === 'ctx') h.ctx.set(h.fresh.length, h.old.length - 1); h.fresh.push(val); }
          last = kind === 'del' ? null : kind;
          h.lastNoNl = false; i++; continue;
        }
        break;
      }
      // The cursor already points at the first line outside this hunk body.
      trimContextTail(h);
      cur.hunks.push(h); continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!cur || cur.hunks.length) { cur = { old: '', next: '', create: false, del: false, hunks: [] }; sections.push(cur); }
      cur.old = strip(l.slice(4)); cur.next = strip(lines[i + 1]!.slice(4));
      cur.create = cur.old === '/dev/null'; cur.del = cur.next === '/dev/null'; i += 2; continue;
    }
    if (cur && l.startsWith('rename from ')) cur.old = l.slice(12).trim().replace(/^a\//, '');
    else if (cur && l.startsWith('rename to ')) cur.next = l.slice(10).trim().replace(/^b\//, '');
    else if (cur && l.startsWith('new file mode ')) cur.create = true;
    else if (cur && l.startsWith('deleted file mode ')) cur.del = true;
    i++;
  }
  if (!sections.length) throw new Exit2('error: parse 1');
  return sections.map((s) => (tree) => {
    const from = s.create ? s.next : s.old, to = s.del ? s.old : s.next;
    safePath(from); if (to !== from) safePath(to);
    const before = s.create ? null : tree.get(from);
    if (s.create) { if (tree.get(to) !== null) throw new Fail('exists', to); }
    else if (before === null) throw new Fail('missing', from);
    if (!s.create && !s.del && to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    if (s.del) { tree.now.set(from, null); return; }
    let data = before ?? '', parsed = fileLines(data), linesNow = [...parsed.lines], delta = 0;
    for (const h of s.hunks) {
      const O = h.old, N = h.fresh;
      let at: number;
      let tier = 0;
      if (O.length) {
        const found = occurrences(O, linesNow, strict);
        if (!found.at.length) throw new Fail('no-match', from);
        tier = found.tier; const target = h.a - 1 + delta;
        at = found.at.reduce((best, x) => Math.abs(x - target) < Math.abs(best - target) || (Math.abs(x - target) === Math.abs(best - target) && x < best) ? x : best);
      } else at = Math.min(linesNow.length, Math.max(0, h.a + delta));
      const end = at + O.length === linesNow.length;
      linesNow = rewrite(O, N, linesNow, at, tier, h.ctx);
      if (end) parsed.final = !h.lastNoNl;
      delta += N.length - O.length;
    }
    const out = linesNow.join(parsed.br) + (parsed.final ? parsed.br : '');
    tree.now.set(to, out);
    if (to !== from) { tree.now.set(from, null); moveLog.push({ old: from, next: to }); }
  });
}
function searchEdits(lines: string[], strict: boolean): Edit[] {
  const out: Edit[] = []; let prior = '', i = 0, region = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const start = i, path = lines.slice(region, i).reverse().find(x => x.trim() && !x.trim().startsWith('```'))?.trim() ?? prior;
    if (!path) throw new Exit2(`error: parse ${start + 1}`);
    const sep = lines.indexOf('=======', i + 1), end = sep < 0 ? -1 : lines.findIndex((x, j) => j > sep && x.trimEnd() === '>>>>>>> REPLACE');
    if (sep < 0 || end < 0) throw new Exit2(`error: parse ${start + 1}`);
    const old = lines.slice(i + 1, sep), fresh = lines.slice(sep + 1, end); prior = path; region = end + 1; i = end + 1;
    out.push((tree) => {
      safePath(path); const before = tree.get(path);
      if (!old.length) { if (before !== null) throw new Fail('exists', path); tree.now.set(path, fresh.join('\n') + '\n'); return; }
      if (before === null) throw new Fail('missing', path);
      const f = fileLines(before), found = occurrences(old, f.lines, strict);
      if (!found.at.length) throw new Fail('no-match', path);
      if (found.at.length > 1) throw new Fail('ambiguous', path);
      const pos = found.at[0]!, n = rewrite(old, fresh, f.lines, pos, found.tier, new Map());
      tree.now.set(path, n.join(f.br) + (f.final ? f.br : ''));
    });
  }
  if (!out.length) throw new Exit2('error: parse 1');
  return out;
}

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex(x => x.trim() !== '');
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1; while (last >= 0 && !lines[last]!.trim()) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const out: Edit[] = []; let i = first + 1;
  while (i < last) {
    if (!lines[i]!.trim()) { i++; continue; }
    const head = lines[i]!, m = /^\*\*\* (Add File|Delete File|Update File): (.*)$/.exec(head);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!, path = m[2]!.trim(), sectionLine = i + 1; i++;
    if (kind === 'Add File') {
      const content: string[] = [];
      while (i < last && !lines[i]!.startsWith('*** ')) { const x = lines[i++]!; if (x === '') content.push(''); else if (x.startsWith('+')) content.push(x.slice(1)); else throw new Exit2(`error: parse ${i}`); }
      out.push(tree => { safePath(path); if (tree.get(path) !== null) throw new Fail('exists', path); tree.now.set(path, content.join('\n') + '\n'); });
      continue;
    }
    if (kind === 'Delete File') {
      if (i < last && !lines[i]!.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
      out.push(tree => { safePath(path); if (tree.get(path) === null) throw new Fail('missing', path); tree.now.set(path, null); });
      continue;
    }
    let move = '', chunks: { anchor: string; end: boolean; old: string[]; fresh: string[]; ctx: Map<number, number> }[] = [];
    if (lines[i]?.startsWith('*** Move to: ')) move = lines[i++]!.slice(13).trim();
    let chunk: typeof chunks[number] | null = null;
    const finish = () => {
      if (chunk) { trimContextTail(chunk); chunks.push(chunk); }
      chunk = null;
    };
    while (i < last && !lines[i]!.startsWith('*** Add File: ') && !lines[i]!.startsWith('*** Delete File: ') && !lines[i]!.startsWith('*** Update File: ')) {
      const x = lines[i]!;
      if (x.startsWith('@@')) { finish(); chunk = { anchor: x.slice(2).trim(), end: false, old: [], fresh: [], ctx: new Map() }; i++; continue; }
      if (x === '*** End of File') { if (!chunk) chunk = { anchor: '', end: false, old: [], fresh: [], ctx: new Map() }; chunk.end = true; finish(); i++; continue; }
      if (x === '' || /^[ +\-]/.test(x)) {
        if (!chunk) chunk = { anchor: '', end: false, old: [], fresh: [], ctx: new Map() };
        const k = x === '' ? ' ' : x[0]!, v = x === '' ? '' : x.slice(1);
        if (k !== '+') chunk.old.push(v);
        if (k !== '-') { if (k === ' ') chunk.ctx.set(chunk.fresh.length, chunk.old.length - 1); chunk.fresh.push(v); }
        i++; continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    finish();
    if (!chunks.length && !move) throw new Exit2(`error: parse ${sectionLine}`);
    out.push(tree => {
      safePath(path); if (move) safePath(move);
      const src = tree.get(path); if (src === null) throw new Fail('missing', path);
      if (move && tree.get(move) !== null) throw new Fail('exists', move);
      const f = fileLines(src); let arr = [...f.lines], cursor = 0;
      for (const c of chunks) {
        if (c.anchor) {
          const a = occurrences([c.anchor], arr, strict, cursor);
          if (!a.at.length) throw new Fail('no-match', path);
          cursor = a.at[0]! + 1;
        }
        let pos: number;
        if (!c.old.length) pos = c.end ? arr.length : cursor;
        else {
          const found = occurrences(c.old, arr, strict, cursor, c.end);
          if (!found.at.length) throw new Fail('no-match', path);
          pos = found.at[0]!;
          arr = rewrite(c.old, c.fresh, arr, pos, found.tier, c.ctx);
          cursor = pos + c.fresh.length; continue;
        }
        arr.splice(pos, 0, ...c.fresh); cursor = pos + c.fresh.length;
      }
      const dest = move || path;
      tree.now.set(dest, arr.join(f.br) + (f.final ? f.br : ''));
      if (move) { tree.now.set(path, null); moveLog.push({ old: path, next: move }); }
    });
  }
  if (!out.length) throw new Exit2('error: parse 1');
  return out;
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
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    moveLog = [];
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchEdits(lines, strict) : v4aEdits(lines, strict);
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
  const rows: string[] = [];
  const moved = moveLog.filter(m => tree.original(m.old) !== null && tree.now.get(m.old) === null && tree.original(m.next) === null && tree.now.get(m.next) !== null);
  const movedPaths = new Set(moved.flatMap(m => [m.old, m.next]));
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedPaths.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  for (const m of moved) rows.push(`R ${m.old} -> ${m.next}`);
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.startsWith('R ') ? a.split(' -> ')[1]! : a.slice(2)), Buffer.from(b.startsWith('R ') ? b.split(' -> ')[1]! : b.slice(2))));
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
// Patch-format readers are added below the starter implementation in this first pass.
