// Spec-derived edge-case battery for mend (hand-computed expectations from SPEC.md v1)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
function check(name: string, files: Record<string, string>, argv: string[], stdin: string | null, expExit: number, expOut: string, expFiles?: Record<string, string | null>) {
  const d = mkdtempSync(join(tmpdir(), 'mend-'));
  for (const [n, t] of Object.entries(files)) {
    mkdirSync(join(d, n, '..'), { recursive: true });
    writeFileSync(join(d, n), t);
  }
  if (name.startsWith('unified: nearest') || name.startsWith('unified: noeol kept')) {
    console.error('DBG', name, 'dir', d, 'files', JSON.stringify(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,v.slice(0,60)]))), 'argv', JSON.stringify(argv));
  }
  const r = spawnSync('node', ['--experimental-strip-types', new URL('./main.ts', import.meta.url).pathname, ...argv], { cwd: d, input: stdin ?? '', encoding: 'utf8' });
  const gotFiles: Record<string, string> = {};
  const walk = (p: string, rel: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(p, e.name), join(rel, e.name));
      else gotFiles[join(rel, e.name)] = readFileSync(join(p, e.name), 'utf8');
    }
  };
  walk(d, '.');
  const problems: string[] = [];
  if (r.status !== expExit) problems.push(`exit ${r.status} != ${expExit} (stderr: ${r.stderr.slice(0,200)})`);
  if (r.stdout !== expOut) problems.push(`stdout ${JSON.stringify(r.stdout)} != ${JSON.stringify(expOut)}`);
  if (expFiles) {
    for (const [n, t] of Object.entries(expFiles)) {
      if (t === null) { if (existsSync(join(d, n))) problems.push(`${n} should not exist`); }
      else if (!existsSync(join(d, n))) problems.push(`${n} missing`);
      else if (readFileSync(join(d, n), 'utf8') !== t) problems.push(`${n} differs: ${JSON.stringify(readFileSync(join(d, n), 'utf8'))} != ${JSON.stringify(t)}`);
    }
  }
  if (problems.length === 0) pass++;
  else { fail++; console.log(`FAIL ${name}: ${problems.join(' | ')}`); }
  rmSync(d, { recursive: true, force: true });
}

const LF = '\n';
// --- usage errors ---
check('usage: unknown option', { f: 'x' }, ['--bogus'], null, 2, 'error: usage\n');
check('usage: format twice', { f: 'x' }, ['--format=json', '--format=v4a'], null, 2, 'error: usage\n');
check('usage: bad format name', { f: 'x' }, ['--format=xml'], null, 2, 'error: usage\n');
check('usage: two positionals', {}, ['a', 'b'], null, 2, 'error: usage\n');
check('usage: unknown short', {}, ['-x'], null, 2, 'error: usage\n');
check('ok: positional after --', {}, ['--', '-weird'], null, 2, 'error: no-patch\n');
check('dash is stdin', {}, ['-'], '*** Begin Patch\n*** End Patch\n', 2, 'error: parse 1\n');
// --- no-patch / format ---
check('no-patch', {}, ['missing.patch'], null, 2, 'error: no-patch\n');
check('format: no detect', { p: 'hello world\n' }, ['p'], null, 2, 'error: format\n');
check('detect: json wins over markers', { p: '{"command":"create","path":"n.txt","file_text":"hi"}\n' }, ['p'], null, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'hi' });
check('detect: v4a first', { p: '  *** Begin Patch  \n*** End Patch\n' }, ['p'], null, 2, 'error: parse 1\n');
check('detect: search-replace via marker', { p: 'path.txt\n<<<<<<< SEARCH\n=======\nb\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'A path.txt\nok: 1 file\n', { 'path.txt': 'b\n' });
check('detect: unified via ---/+++', { p: '--- x\n+++ x\n' }, ['p'], null, 1, 'error: missing x\nfailed: 1 of 1 edits\n');
// --- parse errors ---
check('unified: bad diff --git', { p: 'diff --git a/x b\n' }, ['p'], null, 2, 'error: parse 1\n');
check('unified: bad hunk header', { p: '--- a\n+++ a\n@@ x\n' }, ['p'], null, 2, 'error: parse 3\n');
check('unified: hunk before section', { p: '@@ -1 +1 @@\n' }, ['p'], null, 2, 'error: format\n');
check('unified: --- without +++', { p: '--- a\nzzz\n' }, ['p'], null, 2, 'error: format\n');
check('sr: no path first block', { p: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n' }, ['p'], null, 2, 'error: parse 1\n');
check('sr: missing REPLACE', { p: 'f\n<<<<<<< SEARCH\na\n=======\nb\n' }, ['p'], null, 2, 'error: parse 2\n');
check('v4a: no begin', { p: '*** End Patch\n' }, ['p'], null, 2, 'error: format\n');
check('v4a: no end', { p: '*** Begin Patch\n' }, ['p'], null, 2, 'error: parse 2\n');
check('v4a: junk line', { p: '*** Begin Patch\n*** Bogus: x\n*** End Patch\n' }, ['p'], null, 2, 'error: parse 2\n');
check('v4a: update with nothing', { p: '*** Begin Patch\n*** Update File: a\n*** End Patch\n' }, ['p'], null, 2, 'error: parse 2\n');
check('v4a: delete with body', { p: '*** Begin Patch\n*** Delete File: a\n+oops\n*** End Patch\n' }, ['p'], null, 2, 'error: parse 3\n');
check('json: bad line', { p: '{"command":"create","path":"a"}\n' }, ['p'], null, 2, 'error: parse 1\n');
check('json: jsonl bad line 2', { p: '{"command":"create","path":"a.txt","file_text":"x"}\nnot json\n' }, ['p'], null, 2, 'error: parse 2\n');
// --- unified semantics ---
check('unified: nearest occurrence with d', { f: 'a\nX\nb\nX\nc\n', p: '--- f\n+++ f\n@@ -5,1 +5,1 @@\n-X\n+Y\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nX\nb\nY\nc\n' });
check('unified: empty O inserts after A+d', { f: 'a\nb\nc\n', p: '--- f\n+++ f\n@@ -2,0 +3,1 @@\n+Z\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nb\nZ\nc\n' });
check('unified: context written from file', { f: 'A \n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-A\n+B\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'B\n' });
check('unified: tier1 trailing ws', { f: 'A   \n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-A\n+B\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'B\n' });
check('unified: tier2 reindent', { f: '    return 1;\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-return 1;\n+return 2;\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: '    return 2;\n' });
check('unified: noeol kept mid-file', { f: 'a\nb', p: '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+X\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'X\nb' });
check('unified: noeol at end keeps no break', { f: 'a\nlast', p: '--- f\n+++ f\n@@ -2 +2 @@\n-last\n+newlast\n\\ No newline at end of file\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nnewlast' });
check('unified: end-of-file match adds break unless backslash', { f: 'a\nlast', p: '--- f\n+++ f\n@@ -2 +2 @@\n-last\n+newlast\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nnewlast\n' });
check('unified: create', { p: '--- /dev/null\n+++ new/f.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n' }, ['p'], null, 0, 'A new/f.txt\nok: 1 file\n', { 'new/f.txt': 'hello\nworld\n' });
check('unified: create noeol', { p: '--- /dev/null\n+++ n.txt\n@@ -0,0 +1 @@\n+hi\n\\ No newline at end of file\n' }, ['p'], null, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'hi' });
check('unified: delete', { f: 'x\n', p: '--- f\n+++ /dev/null\n' }, ['p'], null, 0, 'D f\nok: 1 file\n', { f: null });
check('unified: rename only', { f: 'a\n', p: 'diff --git a/f b/g\nrename from f\nrename to g\n' }, ['p'], null, 0, 'R f -> g\nok: 1 file\n', { f: null, g: 'a\n' });
check('unified: rename with hunk', { f: 'a\n', p: 'diff --git a/f b/g\n--- a/f\n+++ b/g\n@@ -1 +1 @@\n-a\n+b\n' }, ['p'], null, 0, 'R f -> g\nok: 1 file\n', { f: null, g: 'b\n' });
check('unified: create exists', { f: 'x\n', p: '--- /dev/null\n+++ f\n' }, ['p'], null, 1, 'error: exists f\nfailed: 1 of 1 edits\n', { f: 'x\n' });
check('unified: delete missing', { p: '--- nope\n+++ /dev/null\n' }, ['p'], null, 1, 'error: missing nope\nfailed: 1 of 1 edits\n');
check('unified: no-match', { f: 'a\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-zzz\n+yyy\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n');
check('unified: prose ignored', { f: 'a\n', p: 'Here is my diff:\n```diff\n--- f\n+++ f\n@@ -1 +1 @@\n-a\n+b\n```\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'b\n' });
check('unified: leading a/ b/ stripped', { f: 'a\n', p: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'b\n' });
check('unified: CRLF file keeps breaks', { f: 'a\r\nb\r\n', p: '--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\r\nc\r\n' });
// --- search/replace ---
check('sr: two blocks, second inherits path', { f: 'x\n', p: 'f\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n<<<<<<< SEARCH\ny\n=======\nz\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'z\n' });
check('sr: path skips blank and fences', { f: 'x\n', p: 'f\n\n```py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'y\n' });
check('sr: ambiguous', { f: 'x\nx\n', p: 'f\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n' }, ['p'], null, 1, 'error: ambiguous f\nfailed: 1 of 1 edits\n');
check('sr: create from empty search', { p: 'new.txt\n<<<<<<< SEARCH\n=======\nA\nB\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'A new.txt\nok: 1 file\n', { 'new.txt': 'A\nB\n' });
check('sr: create exists', { f: 'x\n', p: 'f\n<<<<<<< SEARCH\n=======\nA\n>>>>>>> REPLACE\n' }, ['p'], null, 1, 'error: exists f\nfailed: 1 of 1 edits\n');
check('sr: tier2 reindent of new lines', { f: '  if (a) {\n    b();\n  }\n', p: 'f\n<<<<<<< SEARCH\nif (a) {\n=======\nif (b) {\nextra\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: '  if (b) {\n  extra\n    b();\n  }\n' });
check('sr: CRLF file', { f: 'a\r\nb\r\n', p: 'f\n<<<<<<< SEARCH\na\n=======\nc\n>>>>>>> REPLACE\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'c\r\nb\r\n' });
check('sr: no-match vs ambiguous', { f: 'zzz\n', p: 'f\n<<<<<<< SEARCH\nqqq\n=======\ny\n>>>>>>> REPLACE\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n');
// --- v4a ---
check('v4a: add file with empty lines', { p: '*** Begin Patch\n*** Add File: n.txt\n+first\n\n+third\n*** End Patch\n' }, ['p'], null, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'first\n\nthird\n' });
check('v4a: delete', { f: 'x\n', p: '*** Begin Patch\n*** Delete File: f\n*** End Patch\n' }, ['p'], null, 0, 'D f\nok: 1 file\n', { f: null });
check('v4a: move to', { f: 'a\n', p: '*** Begin Patch\n*** Update File: f\n*** Move to: g\n*** End Patch\n' }, ['p'], null, 0, 'R f -> g\nok: 1 file\n', { f: null, g: 'a\n' });
check('v4a: anchor beyond first hit', { f: 'X\nM\nX\nM\n', p: '*** Begin Patch\n*** Update File: f\n@@ M\n-X\n+Y\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'X\nM\nY\nM\n' });
check('v4a: end of file chunk', { f: 'a\nKEEP\nTAIL\n', p: '*** Begin Patch\n*** Update File: f\n@@ KEEP\n-TAIL\n+NEWTAIL\n*** End of File\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nKEEP\nNEWTAIL\n' });
check('v4a: cursor advances past written lines', { f: 'M\na\nM\na\n', p: '*** Begin Patch\n*** Update File: f\n@@\n M\n-a\n+b\n@@\n M\n-a\n+c\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'M\nb\nM\nc\n' });
check('v4a: no-match', { f: 'a\n', p: '*** Begin Patch\n*** Update File: f\n@@\n zz\n-q\n+w\n*** End Patch\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n');
check('v4a: add exists', { f: 'x\n', p: '*** Begin Patch\n*** Add File: f\n+x\n*** End Patch\n' }, ['p'], null, 1, 'error: exists f\nfailed: 1 of 1 edits\n');
check('v4a: delete missing', { p: '*** Begin Patch\n*** Delete File: nope\n*** End Patch\n' }, ['p'], null, 1, 'error: missing nope\nfailed: 1 of 1 edits\n');
check('v4a: unsafe path', { p: '*** Begin Patch\n*** Add File: ../up\n+x\n*** End Patch\n' }, ['p'], null, 1, 'error: unsafe ../up\nfailed: 1 of 1 edits\n');
check('v4a: empty section blank lines ignored', { f: 'a\n', p: '*** Begin Patch\n*** Update File: f\n\n@@\n a\n-b\n+c\n\n*** End Patch\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n');
check('v4a: CRLF file', { f: 'a\r\nb\r\n', p: '*** Begin Patch\n*** Update File: f\n@@\n a\n-b\n+c\n*** End Patch\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\r\nc\r\n' });
// --- json ---
check('json: str_replace once', { f: 'hello world\n', p: '{"command":"str_replace","path":"f","old_str":"world","new_str":"there"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'hello there\n' });
check('json: str_replace new_str absent', { f: 'hello world\n', p: '{"command":"str_replace","path":"f","old_str":" world"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'hello\n' });
check('json: create bytes exact', { p: '{"command":"create","path":"n","file_text":"a\\nb\\n"}\n' }, ['p'], null, 0, 'A n\nok: 1 file\n', { n: 'a\nb\n' });
check('json: insert at 0', { f: 'b\n', p: '{"command":"insert","path":"f","insert_line":0,"new_str":"a"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'a\nb\n' });
check('json: insert multiline and no final', { f: 'b', p: '{"command":"insert","path":"f","insert_line":1,"new_str":"x\\ny"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'b\nx\ny' });
check('json: insert out of range', { f: 'b\n', p: '{"command":"insert","path":"f","insert_line":9,"new_str":"a"}\n' }, ['p'], null, 1, 'error: no-match f\nfailed: 1 of 1 edits\n');
check('json: crlf str_replace', { f: 'a\r\nB\r\n', p: '{"command":"str_replace","path":"f","old_str":"a\\r\\nB","new_str":"c"}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'c\r\n' });
check('json: array of two', { p: '[{"command":"create","path":"a.txt","file_text":"A"},{"command":"create","path":"b.txt","file_text":"B"}]\n' }, ['p'], null, 0, 'A a.txt\nA b.txt\nok: 2 files\n', { 'a.txt': 'A', 'b.txt': 'B' });
check('json: wrong command', { p: '{"command":"frobnicate","path":"a"}\n' }, ['p'], null, 2, 'error: parse 1\n');
check('json: extra keys ignored', { f: 'x\n', p: '{"command":"str_replace","path":"f","old_str":"x","new_str":"y","wat":1}\n' }, ['p'], null, 0, 'M f\nok: 1 file\n', { f: 'y\n' });
// --- order/atomicity/output ---
check('order: later edit sees earlier', { p: '{"command":"create","path":"n.txt","file_text":"x"}\n{"command":"str_replace","path":"n.txt","old_str":"x","new_str":"y"}\n' }, ['p'], null, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'y' });
check('atomic: second fails, nothing written', { 'f.txt': 'f.txt\n' }, [], '{"command":"str_replace","path":"f.txt","old_str":"f","new_str":"g"}\n{"command":"str_replace","path":"nope.txt","old_str":"a","new_str":"b"}\n', 1, 'error: missing nope.txt\nfailed: 1 of 2 edits\n', { 'f.txt': 'f.txt\n' });
check('check mode writes nothing', { f: 'f\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-f\n+g\n' }, ['--check', 'p'], null, 0, 'M f\nok: 1 file\n', { f: 'f\n' });
check('noop change prints ok 0', { f: 'a\n', p: '--- f\n+++ f\n@@ -1 +1 @@\n-a\n+a\n' }, ['p'], null, 0, 'ok: 0 files\n');
check('unsafe path in unified', { p: '--- ../up\n+++ ../up\n' }, ['p'], null, 1, 'error: unsafe ../up\nfailed: 1 of 1 edits\n');
check('unsafe checked before missing', { p: '*** Begin Patch\n*** Delete File: /abs\n*** End Patch\n' }, ['p'], null, 1, 'error: unsafe /abs\nfailed: 1 of 1 edits\n');
check('R replaces D and A, sorted by new', { a: '1\n', b: '2\n', p: '*** Begin Patch\n*** Update File: a\n*** Move to: z\n*** Add File: m\n+3\n*** End Patch\n' }, ['p'], null, 0, 'A m\nR a -> z\nok: 2 files\n', { a: null, z: '1\n', m: '3\n' });
check('deep dirs created', { p: '*** Begin Patch\n*** Add File: x/y/z.txt\n+hi\n*** End Patch\n' }, ['p'], null, 0, 'A x/y/z.txt\nok: 1 file\n', { 'x/y/z.txt': 'hi\n' });
console.log(`\n${pass} passed, ${fail} failed`);
