/**
 * Fuzz libscan: it walks a directory the user points it at, so the input is effectively
 * untrusted. The dangerous cases are not "weird file contents" but "weird SHAPE":
 *
 *   - a directory junction pointing at an ancestor (infinite walk)
 *   - deep nesting, thousands of entries, very long / unicode names
 *   - unreadable entries, entries that disappear mid-walk, binary blobs, huge files
 *
 * Invariants: returns a report, never throws, always terminates, bounded wall time.
 *   node test/fuzz-libscan.mjs
 * (requires dist/ to be built)
 */
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../dist/index.js';

const registered = [];
apply({ tools: { register: (t) => registered.push(t) } });
const scan = registered.find((t) => t.name === 'libscan');
if (scan === undefined) { console.log(JSON.stringify({ error: 'libscan not registered' })); process.exit(1); }

const root = mkdtempSync(join(tmpdir(), 'fuzz-libscan-'));
const problems = [];
const results = [];

async function runCase(name, dir, options = {}) {
  const started = Date.now();
  try {
    const report = await scan.execute({ root: dir, ...options });
    const ms = Date.now() - started;
    const shaped = report !== null && typeof report === 'object';
    if (!shaped) problems.push({ name, why: 'SHAPE: ' + typeof report });
    if (ms > 20000) problems.push({ name, why: 'SLOW: ' + ms + 'ms' });
    results.push({ name, ms, kind: report && typeof report === 'object' ? Object.keys(report).slice(0, 6).join(',') : '' });
  } catch (err) {
    problems.push({ name, why: 'THREW: ' + (err && err.message ? err.message : String(err)) });
  }
}

// 1. an empty directory
const empty = join(root, 'empty'); mkdirSync(empty, { recursive: true });
await runCase('empty', empty);

// 2. a junction pointing at an ancestor: the classic infinite walk
const cycle = join(root, 'cycle'); mkdirSync(join(cycle, 'inner'), { recursive: true });
try { symlinkSync(cycle, join(cycle, 'inner', 'loop'), 'junction'); } catch { /* needs privileges: skip */ }
await runCase('junction-cycle', cycle);

// 3. self-referential junction at the root
const selfRef = join(root, 'selfref'); mkdirSync(selfRef, { recursive: true });
try { symlinkSync(selfRef, join(selfRef, 'me'), 'junction'); } catch { /* skip */ }
await runCase('self-junction', selfRef);

// 4. deep nesting (200 levels)
let deep = join(root, 'deep'); mkdirSync(deep, { recursive: true });
for (let i = 0; i < 200; i++) { deep = join(deep, 'd' + i); try { mkdirSync(deep); } catch { break; } }
writeFileSync(join(deep, 'leaf.txt'), 'x');
await runCase('deep-200', join(root, 'deep'));

// 5. many entries
const many = join(root, 'many'); mkdirSync(many, { recursive: true });
for (let i = 0; i < 2000; i++) writeFileSync(join(many, 'f' + i + '.txt'), 'x');
await runCase('2000-files', many);

// 6. unicode + spaces + dots
const weird = join(root, 'weird'); mkdirSync(weird, { recursive: true });
for (const n of ['中文 文件.txt', 'emoji-\uD83D\uDE00.md', '...hidden', 'a'.repeat(120) + '.txt', 'quote\'name.txt']) {
  try { writeFileSync(join(weird, n), 'x'); } catch { /* long names may fail */ }
}
await runCase('weird-names', weird);

// 7. binary + huge + empty files
const blobs = join(root, 'blobs'); mkdirSync(blobs, { recursive: true });
writeFileSync(join(blobs, 'binary.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256)));
writeFileSync(join(blobs, 'empty.txt'), '');
const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
writeFileSync(join(blobs, 'big.txt'), big);
await runCase('blobs', blobs);

// 8. a file where a directory is expected, and a missing root
const fake = join(root, 'notadir'); writeFileSync(fake, 'i am a file');
await runCase('file-as-root', fake);
await runCase('missing-root', join(root, 'does-not-exist'));

// 9. entries removed between listing and use (best effort: delete one after creating many)
const racy = join(root, 'racy'); mkdirSync(racy, { recursive: true });
for (let i = 0; i < 50; i++) writeFileSync(join(racy, 'r' + i + '.txt'), 'x');
try { rmSync(join(racy, 'r25.txt')); } catch { /* */ }
await runCase('racy', racy);

// 10. maxDepth / skip edge values
await runCase('depth-zero', join(root, 'many'), { maxDepth: 0 });
await runCase('depth-negative', join(root, 'many'), { maxDepth: -5 });
await runCase('skip-everything', join(root, 'many'), { skip: readdirSync(join(root, 'many')) });

try { rmSync(root, { recursive: true, force: true }); } catch { /* junctions can resist removal */ }
console.log(JSON.stringify({ cases: results.length, problems: problems.length, problems_detail: problems, timings: results }, null, 1));
process.exit(problems.length ? 1 : 0);
