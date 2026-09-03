/**
 * dsh-lib-analyzer — library absorption analysis for DeepSeek Harness (TypeScript + Hono).
 *
 * Tools:
 *   libscan   — scan a reference-corpus directory (ref/) into a bounded structure
 *               report: tree, file stats, >1MB big-file list (big-file discipline),
 *               docs inventory. Read-only.
 *   libtasks  — drive a batch task list (batch/tasks.jsonl): list tasks with
 *               derived status, or fetch the next pending task in full.
 *   libreport — finish an absorption report: validate the required sections and
 *               evidence discipline (概览/关键机制/可吸收设计/落地章节建议/风险与教训/
 *               提取方式, ✓◐✗ markers, file:line citations), then sink a
 *               per-library knowledge page into <root>/.dsh-lib-analyzer/pages
 *               and update <root>/.dsh-lib-analyzer/index.json.
 *   libsearch — keyword search across knowledge pages and produced reports.
 *
 * HTTP (Hono): createHonoApp(ctx) exposes /api/analyzer/health; the plugin tries
 * to mount on the host http service, same pattern as dsh-codex.
 *
 * Design rules:
 *  1. node builtins only; no child processes, no network.
 *  2. every write stays inside the .dsh-lib-analyzer directory (the store).
 *  3. scan skips VCS/build/junk directories by default.
 *  4. the knowledge base is derived entirely from reports — auditable and
 *     rebuildable; it never recalls from conversation.
 */
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { Hono } from 'hono';

// --- ACP graph compatibility (data-layer dependency on dsh-session-handoff) ---
let DatabaseSync: any = null;
try { ({ DatabaseSync } = (await import('node:sqlite')) as any); } catch { /* old node */ }
function acpGraphPath(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'graph', 'graph.db');
}
/** ACP 图可用性：graph.db 存在 且 docs 表有数据（说明已索引外部知识）。 */
function acpDocsAvailable(): boolean {
  try {
    if (!DatabaseSync || !existsSync(acpGraphPath())) return false;
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS c FROM docs').get() as { c: number };
      return (row?.c ?? 0) > 0;
    } finally { db.close(); }
  } catch { return false; }
}
/** 查 ACP 图 doc_fts 索引（libsearch 复用）。 */
function acpDocSearch(query: string, limit: number, kind: string | null): { file: string; line: number; context: string }[] {
  try {
    const db = new DatabaseSync(acpGraphPath(), { readOnly: true });
    try {
      const matchQ = JSON.stringify(query) + '*';
      const out: { file: string; line: number; context: string }[] = [];
      const sql = kind
        ? 'SELECT d.source, d.title, d.body FROM doc_fts JOIN docs d ON d.id = doc_fts.id WHERE doc_fts MATCH ? AND d.kind = ? ORDER BY bm25(doc_fts) LIMIT ?'
        : 'SELECT d.source, d.title, d.body FROM doc_fts JOIN docs d ON d.id = doc_fts.id WHERE doc_fts MATCH ? ORDER BY bm25(doc_fts) LIMIT ?';
      const args = kind ? [matchQ, kind, limit] : [matchQ, limit];
      const rows = db.prepare(sql).all(...args) as { source: string; title: string; body: string }[];
      for (const r of rows) {
        const firstLine = r.body.split(/\r?\n/).find((l) => l.toLowerCase().includes(query.toLowerCase())) ?? r.body.slice(0, 160);
        out.push({ file: r.title, line: 1, context: firstLine.trim().slice(0, 160) });
      }
      return out;
    } finally { db.close(); }
  } catch { return []; }
}

export const name = 'lib-analyzer';
export const inject = ['tools'];

// --- minimal DSH tool surface ---
type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

interface Tool {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[] }
  output: {
    schema: Json
    render: (args: Json, value: Json) => { type: 'text'; text: string }[]
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  presentCall?: (args: Json) => Json
  execute: (args: Json, exec: { signal?: AbortSignal }) => Promise<Json>
}

interface Ctx {
  tools: { register: (tool: Tool) => void }
}

const STORE_DIR = '.dsh-lib-analyzer';
const BIG_FILE_BYTES = 1024 * 1024; // >1MB triggers big-file discipline
const SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'build', 'dist', 'target', 'out',
  '.zig-cache', 'zig-out', '.xmake', '.zed', '.venv', '__pycache__',
  '.idea', '.vscode', 'archive', 'backup', '.dsh-lib-analyzer',
]);
const DOC_EXTS = new Set(['.md', '.markdown', '.txt', '.pdf', '.rst', '.adoc', '.tex', '.dox']);
const SRC_EXTS = new Set([
  '.zig', '.rs', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.py', '.js', '.ts',
  '.lua', '.wren', '.r32', '.asm', '.s', '.go', '.java', '.m', '.mm', '.rb', '.php',
  '.dart', '.cs', '.swift', '.kt', '.scala', '.ml', '.hs', '.zig.zon',
]);
const REQUIRED_SECTIONS = ['概览', '关键机制', '可吸收设计', '落地章节', '风险与教训', '提取方式'];
const MARKERS = ['✓', '◐', '✗'];

const textOutput = (): Tool['output'] => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});

function str(a: Json | undefined, k: string): string | undefined {
  const v = (a as Record<string, Json> | undefined)?.[k];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function num(a: Json | undefined, k: string, d: number): number {
  const v = (a as Record<string, Json> | undefined)?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Walk up from cwd looking for a marker file/dir; returns the dir containing it. */
async function findUp(start: string | undefined, name: string): Promise<string | undefined> {
  let dir = resolve(start ?? process.cwd());
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, name))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

async function findProjectRoot(cwd: string | undefined): Promise<string> {
  return (await findUp(cwd, 'batch')) ?? (await findUp(cwd, STORE_DIR)) ?? resolve(cwd ?? process.cwd());
}

interface FileEntry {
  path: string
  size: number
  ext: string
  kind: 'src' | 'doc' | 'archive' | 'other'
  big: boolean
}

async function scanDir(root: string, maxDepth: number, skipExtra: string[] | undefined): Promise<Json> {
  const skip = new Set(SKIP_DIRS);
  for (const s of skipExtra ?? []) if (s) skip.add(s);
  const files: FileEntry[] = [];
  const tree: { type: string; path: string }[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        if (depth < maxDepth) {
          tree.push({ type: 'dir', path: relative(root, p).split(sep).join('/') });
          await walk(p, depth + 1);
        }
      } else if (e.isFile()) {
        let size: number;
        try {
          size = (await stat(p)).size;
        } catch {
          continue;
        }
        const ext = basename(e.name).includes('.') ? '.' + basename(e.name).split('.').pop()!.toLowerCase() : '';
        files.push({
          path: relative(root, p).split(sep).join('/'),
          size,
          ext,
          kind: SRC_EXTS.has(ext) ? 'src' : DOC_EXTS.has(ext) ? 'doc' : ext === '.zip' || ext === '.tar' || ext === '.gz' ? 'archive' : 'other',
          big: size > BIG_FILE_BYTES,
        });
      }
    }
  }
  await walk(root, 0);
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const byExt: Record<string, number> = {};
  for (const f of files) {
    if (f.kind === 'src' || f.kind === 'doc') {
      byExt[f.ext] = (byExt[f.ext] ?? 0) + 1;
    }
  }
  const bigFiles = files
    .filter((f) => f.big)
    .sort((a, b) => b.size - a.size)
    .map((f) => ({ path: f.path, size: f.size, mb: +(f.size / 1048576).toFixed(1), ext: f.ext }));
  const docs = files
    .filter((f) => f.kind === 'doc' && f.size < BIG_FILE_BYTES)
    .slice(0, 60)
    .map((f) => f.path);
  return {
    ok: true,
    root,
    counts: {
      dirs: tree.filter((t) => t.type === 'dir').length,
      files: files.length,
      srcFiles: files.filter((f) => f.kind === 'src').length,
      docFiles: files.filter((f) => f.kind === 'doc').length,
      totalSize,
      totalMb: +(totalSize / 1048576).toFixed(1),
    },
    topExtensions: Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12),
    bigFiles,
    bigFileDiscipline: `>1MB 文件 ${bigFiles.length} 个：禁止整体读入，用脚本按需提取（目录/章节标题/代码关键字），单次读取 ≤1MB。`,
    docs,
    tree: tree.slice(0, 300),
  };
}

async function loadTasks(tasksFile: string): Promise<{ ok: boolean; error?: string; tasks?: Json[] }> {
  let raw: string;
  try {
    raw = await readFile(tasksFile, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read tasks file: ${tasksFile} (${(err as Error).message})` };
  }
  const tasks: Json[] = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    try {
      tasks.push(JSON.parse(l) as Json);
    } catch (err) {
      return { ok: false, error: `tasks.jsonl line ${i + 1} is not valid JSON: ${(err as Error).message}` };
    }
  }
  if (!tasks.length) return { ok: false, error: 'no tasks found in ' + tasksFile };
  return { ok: true, tasks };
}

function taskStatus(task: Json, baseDir: string): string {
  const out = (task as Record<string, Json>)?.output;
  if (!out) return 'unknown';
  const p = resolve(baseDir, String(out));
  if (existsSync(p)) return 'done';
  const outDir = join(baseDir, 'batch', 'out', `${String((task as Record<string, Json>).id)}-`);
  if (existsSync(outDir)) return 'done';
  return 'pending';
}

const scanTool: Tool = {
  name: 'libscan',
  description: 'Scan a reference-corpus directory (e.g. ref/<library>) into a bounded structure report: directory tree, file counts by kind/extension, the >1MB big-file list (big-file discipline: never read those whole), and doc inventory. Read-only. Use before deep-reading any library.',
  parameters: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Directory to scan (absolute or relative to cwd)' },
      maxDepth: { type: 'number', description: 'Directory tree depth (default 3)' },
      skip: { type: 'array', items: { type: 'string' }, description: 'Extra directory names to skip' },
    },
    required: ['root'],
  },
  output: textOutput(),
  timeoutMs: 60000,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: 'generic', title: 'libscan ' + String((a as Record<string, Json>)?.root ?? ''), kind: 'read', rawInput: a }),
  async execute(args) {
    const root = resolve(str(args, 'root') ?? process.cwd());
    if (!existsSync(root)) return { ok: false, error: `root not found: ${root}` };
    return scanDir(root, num(args, 'maxDepth', 3), (args as Record<string, Json>)?.skip as string[] | undefined);
  },
};

const tasksTool: Tool = {
  name: 'libtasks',
  description: 'Drive a library-analysis task batch (batch/tasks.jsonl format: one JSON object per line with id/target/focus/deliverable/output). Lists tasks with derived status (done when the output file exists), or returns the next pending task in full. Status is derived from the filesystem, never from memory.',
  parameters: {
    type: 'object',
    properties: {
      tasksFile: { type: 'string', description: 'Path to tasks.jsonl (default: <project>/batch/tasks.jsonl, auto-detected upward from cwd)' },
      filter: { type: 'string', enum: ['all', 'pending', 'done'], description: 'Status filter (default all)' },
      next: { type: 'boolean', description: 'Return only the first pending task, fully expanded (id/target/focus/deliverable/output)' },
    },
  },
  output: textOutput(),
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: 'generic', title: 'libtasks ' + String((a as Record<string, Json>)?.filter ?? 'all'), kind: 'read', rawInput: a }),
  async execute(args) {
    const root = await findProjectRoot(process.cwd());
    const tasksFile = str(args, 'tasksFile') ?? join(root, 'batch', 'tasks.jsonl');
    const loaded = await loadTasks(tasksFile);
    if (!loaded.ok || !loaded.tasks) return loaded;
    const withStatus = loaded.tasks.map((t) => ({ ...(t as object), status: taskStatus(t, root) }));
    if ((args as Record<string, Json>)?.next === true) {
      const next = withStatus.find((t) => (t as Record<string, Json>).status === 'pending');
      if (!next) return { ok: true, message: 'all tasks done', total: withStatus.length, pending: 0 };
      return { ok: true, next, total: withStatus.length, pending: withStatus.filter((t) => (t as Record<string, Json>).status === 'pending').length };
    }
    const filter = String((args as Record<string, Json>)?.filter ?? 'all');
    const list = filter === 'all' ? withStatus : withStatus.filter((t) => (t as Record<string, Json>).status === filter);
    return {
      ok: true,
      tasksFile,
      total: withStatus.length,
      done: withStatus.filter((t) => (t as Record<string, Json>).status === 'done').length,
      pending: withStatus.filter((t) => (t as Record<string, Json>).status === 'pending').length,
      tasks: list.map((t) => ({ id: (t as Record<string, Json>).id, phase: String((t as Record<string, Json>).phase ?? ''), target: (t as Record<string, Json>).target, status: (t as Record<string, Json>).status, output: String((t as Record<string, Json>).output ?? '') })),
    };
  },
};

function extractSection(text: string, title: string): string | undefined {
  const re = new RegExp(`^#{1,3}\\s*.*${title}.*$`, 'm');
  const m = text.match(re);
  if (!m || m.index === undefined) return undefined;
  const start = m.index + m[0].length;
  const next = text.slice(start).match(/^#{1,3}\s/m);
  return text.slice(start, next ? start + next.index! : undefined).trim();
}

const reportTool: Tool = {
  name: 'libreport',
  description: 'Finish an absorption report: validate discipline (required sections 概览/关键机制/可吸收设计/落地章节建议/风险与教训/提取方式; ✓◐✗ comparison markers; file:line evidence citations), then sink a per-library knowledge page into <project>/.dsh-lib-analyzer/pages and update the knowledge index. Run after writing each report to batch/out/.',
  parameters: {
    type: 'object',
    properties: {
      reportFile: { type: 'string', description: 'Path to the absorption report markdown (e.g. batch/out/r01-cyber.md)' },
      taskId: { type: 'string', description: 'Task id from tasks.jsonl (e.g. r01)' },
      library: { type: 'string', description: 'Short library id for the knowledge page (defaults to task id)' },
      sourceDir: { type: 'string', description: 'Scanned reference directory, recorded on the page (e.g. ref/cyber-master)' },
      root: { type: 'string', description: 'Project root containing batch/ (default: auto-detected upward from cwd)' },
    },
    required: ['reportFile', 'taskId'],
  },
  output: textOutput(),
  timeoutMs: 30000,
  isConcurrencySafe: () => false,
  presentCall: (a) => ({ card: 'generic', title: 'libreport ' + String((a as Record<string, Json>)?.taskId ?? ''), kind: 'write', rawInput: a }),
  async execute(args) {
    const a = args as Record<string, Json>;
    const root = str(args, 'root') ?? (await findProjectRoot(process.cwd()));
    const reportFile = str(args, 'reportFile');
    const reportPath = resolve(root, reportFile!);
    let text: string;
    try {
      text = await readFile(reportPath, 'utf8');
    } catch (err) {
      return { ok: false, error: `cannot read report: ${reportPath} (${(err as Error).message})` };
    }
    const missing = REQUIRED_SECTIONS.filter((s) => !extractSection(text, s));
    const markers: Record<string, number> = {};
    for (const mk of MARKERS) markers[mk] = (text.match(new RegExp(mk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    const evidenceRe = /([\w./-]+\.(?:zig|rs|c|h|cpp|cc|cxx|hpp|hh|py|js|ts|md|lua|wren|r32|asm|s|go|java|m|mm|rb|php|dart|cs|swift|kt|zig\.zon))[:：]\s*\d+/g;
    const evidence = [...text.matchAll(evidenceRe)].map((m) => m[0]).slice(0, 40);
    const extractionNote = extractSection(text, '提取方式');
    const overview = extractSection(text, '概览');
    const designs = extractSection(text, '可吸收设计');

    const libId = str(args, 'library') ?? String(a.taskId ?? 'lib');
    const store = join(root, STORE_DIR);
    const pagesDir = join(store, 'pages');
    await mkdir(pagesDir, { recursive: true });
    const pagePath = join(pagesDir, `${libId}.md`);
    const now = new Date().toISOString();
    const page = [
      '---',
      `library: ${libId}`,
      `task: ${String(a.taskId ?? '')}`,
      `source: ${str(args, 'sourceDir') ?? ''}`,
      `report: ${reportFile}`,
      `analyzedAt: ${now}`,
      `evidence: ${evidence.length}`,
      '---',
      '',
      `# ${libId} 吸收知识页`,
      '',
      '## 概览',
      '',
      (overview ?? '(报告缺少「概览」节)').slice(0, 1200),
      '',
      '## 可吸收设计',
      '',
      (designs ?? '(报告缺少「可吸收设计」节)').slice(0, 2000),
      '',
      '## 证据索引',
      '',
      ...(evidence.length ? evidence.map((e) => `- \`${e}\``) : ['(报告未检出 file:line 证据)']),
      '',
      '## 反链',
      '',
      `报告全文: \`${reportFile}\``,
      '',
    ].join('\n');
    await writeFile(pagePath, page, 'utf8');

    const indexPath = join(store, 'index.json');
    let index: { version: number; pages: Record<string, Json>; reports: Record<string, Json> } = { version: 1, pages: {}, reports: {} };
    try {
      index = JSON.parse(await readFile(indexPath, 'utf8')) as typeof index;
    } catch {
      /* first run */
    }
    index.pages[libId] = { task: a.taskId, source: str(args, 'sourceDir') ?? '', report: reportFile, analyzedAt: now, evidence: evidence.length };
    index.reports[String(a.taskId ?? '')] = { output: reportFile, analyzedAt: now, page: libId };
    await writeFile(indexPath, JSON.stringify(index, null, 2), 'utf8');

    return {
      ok: true,
      taskId: a.taskId,
      page: relative(root, pagePath).split(sep).join('/'),
      validation: {
        sectionsFound: REQUIRED_SECTIONS.filter((s) => !missing.includes(s)),
        sectionsMissing: missing,
        markers,
        evidenceCount: evidence.length,
        evidenceSample: evidence.slice(0, 10),
        extractionMethodNoted: Boolean(extractionNote),
      },
      disciplineOk: missing.length === 0,
    };
  },
};

const searchTool: Tool = {
  name: 'libsearch',
  description: 'Keyword search across the library-analysis knowledge base: per-library knowledge pages (hindsight-style) and produced absorption reports. Returns file:line hits with a context line. Use to check what a library analysis already concluded before starting or repeating work.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Case-insensitive keyword (plain substring)' },
      root: { type: 'string', description: 'Project root containing .dsh-lib-analyzer (default: auto-detected upward from cwd)' },
      scope: { type: 'string', enum: ['pages', 'reports', 'all'], description: 'Where to search (default all)' },
      limit: { type: 'number', description: 'Max hits (default 20)' },
    },
    required: ['query'],
  },
  output: textOutput(),
  timeoutMs: 30000,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: 'generic', title: 'libsearch ' + String((a as Record<string, Json>)?.query ?? ''), kind: 'read', rawInput: a }),
  async execute(args) {
    const q = str(args, 'query');
    if (!q) return { ok: false, error: 'query is required' };
    const root = str(args, 'root') ?? (await findProjectRoot(process.cwd()));
    const store = join(root, STORE_DIR);
    const needle = q.toLowerCase();
    const hits: { file: string; line: number; context: string }[] = [];
    const limit = num(args, 'limit', 20);
    const scopeArg = String((args as Record<string, Json>)?.scope ?? 'all');
    const kindFilter = scopeArg === 'pages' ? 'page' : scopeArg === 'reports' ? 'report' : null;

    // 兼容依赖：ACP 图已索引外部知识时，复用 ACP doc_fts 索引（不再逐行扫描）
    if (acpDocsAvailable()) {
      const acpHits = acpDocSearch(q, limit, kindFilter);
      if (acpHits.length) {
        return { ok: true, query: q, scope: scopeArg, root: store, source: 'acp_graph', count: acpHits.length, hits: acpHits.slice(0, limit) };
      }
    }
    // 降级：ACP 不可用或无命中 → 回退本地逐行扫描

    const index: { pages: Record<string, Json>; reports: Record<string, Json> } = { pages: {}, reports: {} };
    try {
      Object.assign(index, JSON.parse(await readFile(join(store, 'index.json'), 'utf8')));
    } catch {
      /* no index yet */
    }

    const scope = String((args as Record<string, Json>)?.scope ?? 'all');
    const scanPages = scope === 'pages' || scope === 'all';
    const scanReports = scope === 'reports' || scope === 'all';

    async function scanFile(file: string, label: string): Promise<void> {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        return;
      }
      const lines = text.split(/\r?\n/);
      for (const [i, line] of lines.entries()) {
        if (line.toLowerCase().includes(needle)) {
          hits.push({ file: label, line: i + 1, context: line.trim().slice(0, 160) });
          if (hits.length >= limit) return;
        }
      }
    }

    if (scanPages) {
      const pagesDir = join(store, 'pages');
      if (existsSync(pagesDir)) {
        for (const f of await readdir(pagesDir)) {
          if (f.endsWith('.md')) await scanFile(join(pagesDir, f), `pages/${f}`);
        }
      }
    }
    if (scanReports && hits.length < limit) {
      const reportFiles = new Set<string>(
        Object.values(index.reports).map((r) => String((r as Record<string, Json>).output ?? '')).concat(
          Object.values(index.pages).map((p) => String((p as Record<string, Json>).report ?? '')),
        ),
      );
      for (const rel of reportFiles) {
        if (!rel) continue;
        const p = resolve(root, rel);
        if (existsSync(p)) await scanFile(p, rel);
      }
    }
    return { ok: true, query: q, scope, root, count: hits.length, hits: hits.slice(0, limit) };
  },
};

// --- Hono app factory (same pattern as dsh-codex) ---

export interface AppEnv {
  Bindings: { ctx: unknown }
}

export function createHonoApp(_ctx: unknown): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/api/analyzer/health', (c) => c.json({ ok: true, plugin: 'dsh-lib-analyzer', ts: true, hono: true }));
  return app;
}

export function apply(ctx: Ctx): void {
  for (const tool of [scanTool, tasksTool, reportTool, searchTool]) {
    try {
      ctx.tools.register(tool);
    } catch (err) {
      console.error(`[lib-analyzer] ${tool.name} skipped: ${err}`);
    }
  }

  // Hono app: try to mount on the host http service when available.
  try {
    const http = (ctx as unknown as { http?: { mount?: (p: string, f: unknown) => void } }).http;
    if (http?.mount) http.mount('/analyzer', createHonoApp(ctx).fetch);
  } catch {
    /* no host http service */
  }
}
