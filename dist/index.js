// src/index.ts
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join as join2, relative, resolve, sep, dirname, basename } from "node:path";
import { existsSync as existsSync2 } from "node:fs";

// src/acp-graph-contract.ts
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var ACP_GRAPH_CONTRACT_VERSION = 1;
var ACP_GRAPH_V1_REQUIRED = {
  checkpoints: ["session_id", "seq_start", "seq_end", "summary", "created_at"],
  checkpoint_nodes: ["session_id", "seq_start", "node_id"],
  nodes: ["id", "kind", "title", "mention_count"],
  cp_fts: ["session_id", "seq_start", "summary"],
  node_fts: ["id", "title", "kind"],
  docs: ["id", "kind", "title", "body", "source", "indexed_at"],
  doc_fts: ["id", "kind", "title", "body"]
};
function acpGraphPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "graph", "graph.db");
}
function ftsPhrase(q) {
  const toks = String(q ?? "").toLowerCase().replace(/["'^*:()\[\]{}]/g, " ").split(/\s+/).filter((t) => t.length > 1).slice(0, 8);
  return toks.length ? toks.map((t) => '"' + t + '"*').join(" OR ") : '""';
}
function tableColumns(db, table) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}
function acpGraphStatus() {
  const path = acpGraphPath();
  const base = { path, contractVersion: ACP_GRAPH_CONTRACT_VERSION };
  if (!existsSync(path)) {
    return { ...base, ok: false, stampedVersion: 0, stamped: false, reason: "no-db", detail: `graph.db not found at ${path}` };
  }
  let db = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const stampedVersion = Number(
      db.prepare("PRAGMA user_version").get()?.user_version ?? 0
    );
    if (stampedVersion > ACP_GRAPH_CONTRACT_VERSION) {
      return {
        ...base,
        ok: false,
        stampedVersion,
        stamped: true,
        reason: "schema-mismatch",
        detail: `graph.db is stamped v${stampedVersion} but this reader implements v${ACP_GRAPH_CONTRACT_VERSION}; upgrade the reader`
      };
    }
    const missing = {};
    for (const [table, cols] of Object.entries(ACP_GRAPH_V1_REQUIRED)) {
      const have = tableColumns(db, table);
      if (have.length === 0) {
        missing[table] = [...cols];
        continue;
      }
      const lack = cols.filter((c) => !have.includes(c));
      if (lack.length) missing[table] = lack;
    }
    if (Object.keys(missing).length) {
      return {
        ...base,
        ok: false,
        stampedVersion,
        stamped: stampedVersion > 0,
        reason: "schema-mismatch",
        detail: "graph.db shape does not satisfy contract v1",
        missing
      };
    }
    if (stampedVersion === 0) {
      return {
        ...base,
        ok: true,
        stampedVersion,
        stamped: false,
        reason: "no-contract",
        detail: "graph.db has no user_version stamp (created before the contract); shape verified against v1"
      };
    }
    return { ...base, ok: true, stampedVersion, stamped: true, reason: "ok" };
  } catch (e) {
    return {
      ...base,
      ok: false,
      stampedVersion: 0,
      stamped: false,
      reason: "error",
      detail: e instanceof Error ? e.message : String(e)
    };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function withAcpGraph(fn) {
  const status = acpGraphStatus();
  if (!status.ok) {
    return {
      ok: false,
      reason: status.reason === "ok" ? "error" : status.reason,
      detail: status.detail ?? status.reason,
      status
    };
  }
  let db = null;
  try {
    db = new DatabaseSync(status.path, { readOnly: true });
    return { ok: true, value: fn(db, status), status };
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      detail: e instanceof Error ? e.message : String(e),
      status
    };
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function acpGraphOr(fallback, fn, onProblem) {
  const r = withAcpGraph(fn);
  if (r.ok) return r.value;
  onProblem?.(r.detail, r.status);
  return fallback;
}

// src/index.ts
var lastAcpProblem = null;
function note(detail, status) {
  lastAcpProblem = { detail, status };
  if (status.reason === "no-db") return;
  console.warn("[dsh-lib-analyzer] ACP graph read failed:", detail, `(reason=${status.reason})`);
}
function acpGraphDiagnostics() {
  return { status: acpGraphStatus(), lastProblem: lastAcpProblem };
}
function acpGraphStatusLine() {
  const s = acpGraphStatus();
  switch (s.reason) {
    case "ok":
      return `available (contract v${s.contractVersion}, db v${s.stampedVersion})`;
    case "no-contract":
      return `available (db has no version stamp; shape verified against contract v${s.contractVersion})`;
    case "no-db":
      return `not available \u2014 ${s.path} does not exist (is dsh-session-handoff installed?)`;
    case "schema-mismatch":
      return `NOT readable \u2014 ${s.detail}${s.missing ? " missing: " + JSON.stringify(s.missing) : ""}`;
    default:
      return `NOT readable \u2014 ${s.detail ?? "unknown error"}`;
  }
}
function acpGraphAvailable() {
  return acpGraphStatus().ok;
}
function acpDocsAvailable() {
  return acpGraphOr(false, (db) => {
    const row = db.prepare("SELECT COUNT(*) AS c FROM docs").get();
    return (row?.c ?? 0) > 0;
  }, note);
}
function acpDocSearch(query, limit, kind) {
  return acpGraphOr([], (db) => {
    const matchQ = ftsPhrase(query);
    const out = [];
    const sql = kind ? "SELECT d.source, d.title, d.body FROM doc_fts JOIN docs d ON d.id = doc_fts.id WHERE doc_fts MATCH ? AND d.kind = ? ORDER BY bm25(doc_fts) LIMIT ?" : "SELECT d.source, d.title, d.body FROM doc_fts JOIN docs d ON d.id = doc_fts.id WHERE doc_fts MATCH ? ORDER BY bm25(doc_fts) LIMIT ?";
    const args = kind ? [matchQ, kind, limit] : [matchQ, limit];
    const rows = db.prepare(sql).all(...args);
    for (const r of rows) {
      const firstLine = r.body.split(/\r?\n/).find((l) => l.toLowerCase().includes(query.toLowerCase())) ?? r.body.slice(0, 160);
      out.push({ file: r.title, line: 1, context: firstLine.trim().slice(0, 160) });
    }
    return out;
  }, note);
}
var name = "lib-analyzer";
var inject = ["tools"];
var STORE_DIR = ".dsh-lib-analyzer";
var BIG_FILE_BYTES = 1024 * 1024;
var SKIP_DIRS = /* @__PURE__ */ new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "build",
  "dist",
  "target",
  "out",
  ".zig-cache",
  "zig-out",
  ".xmake",
  ".zed",
  ".venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "archive",
  "backup",
  ".dsh-lib-analyzer"
]);
var DOC_EXTS = /* @__PURE__ */ new Set([".md", ".markdown", ".txt", ".pdf", ".rst", ".adoc", ".tex", ".dox"]);
var SRC_EXTS = /* @__PURE__ */ new Set([
  ".zig",
  ".rs",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".py",
  ".js",
  ".ts",
  ".lua",
  ".wren",
  ".r32",
  ".asm",
  ".s",
  ".go",
  ".java",
  ".m",
  ".mm",
  ".rb",
  ".php",
  ".dart",
  ".cs",
  ".swift",
  ".kt",
  ".scala",
  ".ml",
  ".hs",
  ".zig.zon"
]);
var REQUIRED_SECTIONS = ["\u6982\u89C8", "\u5173\u952E\u673A\u5236", "\u53EF\u5438\u6536\u8BBE\u8BA1", "\u843D\u5730\u7AE0\u8282", "\u98CE\u9669\u4E0E\u6559\u8BAD", "\u63D0\u53D6\u65B9\u5F0F"];
var MARKERS = ["\u2713", "\u25D0", "\u2717"];
var textOutput = () => ({
  schema: { type: "object", additionalProperties: true },
  render: (_args, value) => [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }
  ]
});
function str(a, k) {
  const v = a?.[k];
  return typeof v === "string" && v.trim() ? v.trim() : void 0;
}
function num(a, k, d) {
  const v = a?.[k];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
async function findUp(start, name2) {
  let dir = resolve(start ?? process.cwd());
  for (let i = 0; i < 8; i += 1) {
    if (existsSync2(join2(dir, name2))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
  return void 0;
}
async function findProjectRoot(cwd) {
  return await findUp(cwd, "batch") ?? await findUp(cwd, STORE_DIR) ?? resolve(cwd ?? process.cwd());
}
async function scanDir(root, maxDepth, skipExtra) {
  const skip = new Set(SKIP_DIRS);
  for (const s of skipExtra ?? []) if (s) skip.add(s);
  const files = [];
  const tree = [];
  async function walk(dir, depth) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join2(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        if (depth < maxDepth) {
          tree.push({ type: "dir", path: relative(root, p).split(sep).join("/") });
          await walk(p, depth + 1);
        }
      } else if (e.isFile()) {
        let size;
        try {
          size = (await stat(p)).size;
        } catch {
          continue;
        }
        const ext = basename(e.name).includes(".") ? "." + basename(e.name).split(".").pop().toLowerCase() : "";
        files.push({
          path: relative(root, p).split(sep).join("/"),
          size,
          ext,
          kind: SRC_EXTS.has(ext) ? "src" : DOC_EXTS.has(ext) ? "doc" : ext === ".zip" || ext === ".tar" || ext === ".gz" ? "archive" : "other",
          big: size > BIG_FILE_BYTES
        });
      }
    }
  }
  await walk(root, 0);
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  const byExt = {};
  for (const f of files) {
    if (f.kind === "src" || f.kind === "doc") {
      byExt[f.ext] = (byExt[f.ext] ?? 0) + 1;
    }
  }
  const bigFiles = files.filter((f) => f.big).sort((a, b) => b.size - a.size).map((f) => ({ path: f.path, size: f.size, mb: +(f.size / 1048576).toFixed(1), ext: f.ext }));
  const docs = files.filter((f) => f.kind === "doc" && f.size < BIG_FILE_BYTES).slice(0, 60).map((f) => f.path);
  return {
    ok: true,
    root,
    counts: {
      dirs: tree.filter((t) => t.type === "dir").length,
      files: files.length,
      srcFiles: files.filter((f) => f.kind === "src").length,
      docFiles: files.filter((f) => f.kind === "doc").length,
      totalSize,
      totalMb: +(totalSize / 1048576).toFixed(1)
    },
    topExtensions: Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 12),
    bigFiles,
    bigFileDiscipline: `>1MB \u6587\u4EF6 ${bigFiles.length} \u4E2A\uFF1A\u7981\u6B62\u6574\u4F53\u8BFB\u5165\uFF0C\u7528\u811A\u672C\u6309\u9700\u63D0\u53D6\uFF08\u76EE\u5F55/\u7AE0\u8282\u6807\u9898/\u4EE3\u7801\u5173\u952E\u5B57\uFF09\uFF0C\u5355\u6B21\u8BFB\u53D6 \u22641MB\u3002`,
    docs,
    tree: tree.slice(0, 300)
  };
}
async function loadTasks(tasksFile) {
  let raw;
  try {
    raw = await readFile(tasksFile, "utf8");
  } catch (err) {
    return { ok: false, error: `cannot read tasks file: ${tasksFile} (${err.message})` };
  }
  const tasks = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    try {
      tasks.push(JSON.parse(l));
    } catch (err) {
      return { ok: false, error: `tasks.jsonl line ${i + 1} is not valid JSON: ${err.message}` };
    }
  }
  if (!tasks.length) return { ok: false, error: "no tasks found in " + tasksFile };
  return { ok: true, tasks };
}
function taskStatus(task, baseDir) {
  const out = task?.output;
  if (!out) return "unknown";
  const p = resolve(baseDir, String(out));
  if (existsSync2(p)) return "done";
  const outDir = join2(baseDir, "batch", "out", `${String(task.id)}-`);
  if (existsSync2(outDir)) return "done";
  return "pending";
}
var scanTool = {
  name: "libscan",
  description: "Scan a reference-corpus directory (e.g. ref/<library>) into a bounded structure report: directory tree, file counts by kind/extension, the >1MB big-file list (big-file discipline: never read those whole), and doc inventory. Read-only. Use before deep-reading any library.",
  parameters: {
    type: "object",
    properties: {
      root: { type: "string", description: "Directory to scan (absolute or relative to cwd)" },
      maxDepth: { type: "number", description: "Directory tree depth (default 3)" },
      skip: { type: "array", items: { type: "string" }, description: "Extra directory names to skip" }
    },
    required: ["root"]
  },
  output: textOutput(),
  timeoutMs: 6e4,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: "generic", title: "libscan " + String(a?.root ?? ""), kind: "read", rawInput: a }),
  async execute(args) {
    const root = resolve(str(args, "root") ?? process.cwd());
    if (!existsSync2(root)) return { ok: false, error: `root not found: ${root}` };
    return scanDir(root, num(args, "maxDepth", 3), args?.skip);
  }
};
var tasksTool = {
  name: "libtasks",
  description: "Drive a library-analysis task batch (batch/tasks.jsonl format: one JSON object per line with id/target/focus/deliverable/output). Lists tasks with derived status (done when the output file exists), or returns the next pending task in full. Status is derived from the filesystem, never from memory.",
  parameters: {
    type: "object",
    properties: {
      tasksFile: { type: "string", description: "Path to tasks.jsonl (default: <project>/batch/tasks.jsonl, auto-detected upward from cwd)" },
      filter: { type: "string", enum: ["all", "pending", "done"], description: "Status filter (default all)" },
      next: { type: "boolean", description: "Return only the first pending task, fully expanded (id/target/focus/deliverable/output)" }
    }
  },
  output: textOutput(),
  timeoutMs: 3e4,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: "generic", title: "libtasks " + String(a?.filter ?? "all"), kind: "read", rawInput: a }),
  async execute(args) {
    const root = await findProjectRoot(process.cwd());
    const tasksFile = str(args, "tasksFile") ?? join2(root, "batch", "tasks.jsonl");
    const loaded = await loadTasks(tasksFile);
    if (!loaded.ok || !loaded.tasks) return loaded;
    const withStatus = loaded.tasks.map((t) => ({ ...t, status: taskStatus(t, root) }));
    if (args?.next === true) {
      const next = withStatus.find((t) => t.status === "pending");
      if (!next) return { ok: true, message: "all tasks done", total: withStatus.length, pending: 0 };
      return { ok: true, next, total: withStatus.length, pending: withStatus.filter((t) => t.status === "pending").length };
    }
    const filter = String(args?.filter ?? "all");
    const list = filter === "all" ? withStatus : withStatus.filter((t) => t.status === filter);
    return {
      ok: true,
      tasksFile,
      total: withStatus.length,
      done: withStatus.filter((t) => t.status === "done").length,
      pending: withStatus.filter((t) => t.status === "pending").length,
      tasks: list.map((t) => ({ id: t.id, phase: String(t.phase ?? ""), target: t.target, status: t.status, output: String(t.output ?? "") }))
    };
  }
};
function extractSection(text, title) {
  const re = new RegExp(`^#{1,3}\\s*.*${title}.*$`, "m");
  const m = text.match(re);
  if (!m || m.index === void 0) return void 0;
  const start = m.index + m[0].length;
  const next = text.slice(start).match(/^#{1,3}\s/m);
  return text.slice(start, next ? start + next.index : void 0).trim();
}
var reportTool = {
  name: "libreport",
  description: "Finish an absorption report: validate discipline (required sections \u6982\u89C8/\u5173\u952E\u673A\u5236/\u53EF\u5438\u6536\u8BBE\u8BA1/\u843D\u5730\u7AE0\u8282\u5EFA\u8BAE/\u98CE\u9669\u4E0E\u6559\u8BAD/\u63D0\u53D6\u65B9\u5F0F; \u2713\u25D0\u2717 comparison markers; file:line evidence citations), then sink a per-library knowledge page into <project>/.dsh-lib-analyzer/pages and update the knowledge index. Run after writing each report to batch/out/.",
  parameters: {
    type: "object",
    properties: {
      reportFile: { type: "string", description: "Path to the absorption report markdown (e.g. batch/out/r01-cyber.md)" },
      taskId: { type: "string", description: "Task id from tasks.jsonl (e.g. r01)" },
      library: { type: "string", description: "Short library id for the knowledge page (defaults to task id)" },
      sourceDir: { type: "string", description: "Scanned reference directory, recorded on the page (e.g. ref/cyber-master)" },
      root: { type: "string", description: "Project root containing batch/ (default: auto-detected upward from cwd)" }
    },
    required: ["reportFile", "taskId"]
  },
  output: textOutput(),
  timeoutMs: 3e4,
  isConcurrencySafe: () => false,
  presentCall: (a) => ({ card: "generic", title: "libreport " + String(a?.taskId ?? ""), kind: "write", rawInput: a }),
  async execute(args) {
    const a = args;
    const root = str(args, "root") ?? await findProjectRoot(process.cwd());
    const reportFile = str(args, "reportFile");
    const reportPath = resolve(root, reportFile);
    let text;
    try {
      text = await readFile(reportPath, "utf8");
    } catch (err) {
      return { ok: false, error: `cannot read report: ${reportPath} (${err.message})` };
    }
    const missing = REQUIRED_SECTIONS.filter((s) => !extractSection(text, s));
    const markers = {};
    for (const mk of MARKERS) markers[mk] = (text.match(new RegExp(mk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
    const evidenceRe = /([\w./-]+\.(?:zig|rs|c|h|cpp|cc|cxx|hpp|hh|py|js|ts|md|lua|wren|r32|asm|s|go|java|m|mm|rb|php|dart|cs|swift|kt|zig\.zon))[:：]\s*\d+/g;
    const evidence = [...text.matchAll(evidenceRe)].map((m) => m[0]).slice(0, 40);
    const extractionNote = extractSection(text, "\u63D0\u53D6\u65B9\u5F0F");
    const overview = extractSection(text, "\u6982\u89C8");
    const designs = extractSection(text, "\u53EF\u5438\u6536\u8BBE\u8BA1");
    const libId = str(args, "library") ?? String(a.taskId ?? "lib");
    const store = join2(root, STORE_DIR);
    const pagesDir = join2(store, "pages");
    await mkdir(pagesDir, { recursive: true });
    const pagePath = join2(pagesDir, `${libId}.md`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const page = [
      "---",
      `library: ${libId}`,
      `task: ${String(a.taskId ?? "")}`,
      `source: ${str(args, "sourceDir") ?? ""}`,
      `report: ${reportFile}`,
      `analyzedAt: ${now}`,
      `evidence: ${evidence.length}`,
      "---",
      "",
      `# ${libId} \u5438\u6536\u77E5\u8BC6\u9875`,
      "",
      "## \u6982\u89C8",
      "",
      (overview ?? "(\u62A5\u544A\u7F3A\u5C11\u300C\u6982\u89C8\u300D\u8282)").slice(0, 1200),
      "",
      "## \u53EF\u5438\u6536\u8BBE\u8BA1",
      "",
      (designs ?? "(\u62A5\u544A\u7F3A\u5C11\u300C\u53EF\u5438\u6536\u8BBE\u8BA1\u300D\u8282)").slice(0, 2e3).toWellFormed(),
      "",
      "## \u8BC1\u636E\u7D22\u5F15",
      "",
      ...evidence.length ? evidence.map((e) => `- \`${e}\``) : ["(\u62A5\u544A\u672A\u68C0\u51FA file:line \u8BC1\u636E)"],
      "",
      "## \u53CD\u94FE",
      "",
      `\u62A5\u544A\u5168\u6587: \`${reportFile}\``,
      ""
    ].join("\n");
    await writeFile(pagePath, page, "utf8");
    const indexPath = join2(store, "index.json");
    let index = { version: 1, pages: {}, reports: {} };
    try {
      index = JSON.parse(await readFile(indexPath, "utf8"));
    } catch {
    }
    index.pages[libId] = { task: a.taskId, source: str(args, "sourceDir") ?? "", report: reportFile, analyzedAt: now, evidence: evidence.length };
    index.reports[String(a.taskId ?? "")] = { output: reportFile, analyzedAt: now, page: libId };
    await writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
    return {
      ok: true,
      taskId: a.taskId,
      page: relative(root, pagePath).split(sep).join("/"),
      validation: {
        sectionsFound: REQUIRED_SECTIONS.filter((s) => !missing.includes(s)),
        sectionsMissing: missing,
        markers,
        evidenceCount: evidence.length,
        evidenceSample: evidence.slice(0, 10),
        extractionMethodNoted: Boolean(extractionNote)
      },
      disciplineOk: missing.length === 0
    };
  }
};
var searchTool = {
  name: "libsearch",
  description: "Keyword search across the library-analysis knowledge base: per-library knowledge pages (hindsight-style) and produced absorption reports. Returns file:line hits with a context line. Use to check what a library analysis already concluded before starting or repeating work.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Case-insensitive keyword (plain substring)" },
      root: { type: "string", description: "Project root containing .dsh-lib-analyzer (default: auto-detected upward from cwd)" },
      scope: { type: "string", enum: ["pages", "reports", "all"], description: "Where to search (default all)" },
      limit: { type: "number", description: "Max hits (default 20)" }
    },
    required: ["query"]
  },
  output: textOutput(),
  timeoutMs: 3e4,
  isConcurrencySafe: () => true,
  presentCall: (a) => ({ card: "generic", title: "libsearch " + String(a?.query ?? ""), kind: "read", rawInput: a }),
  async execute(args) {
    const q = str(args, "query");
    if (!q) return { ok: false, error: "query is required" };
    const root = str(args, "root") ?? await findProjectRoot(process.cwd());
    const store = join2(root, STORE_DIR);
    const needle = q.toLowerCase();
    const hits = [];
    const limit = num(args, "limit", 20);
    const scopeArg = String(args?.scope ?? "all");
    const kindFilter = scopeArg === "pages" ? "page" : scopeArg === "reports" ? "report" : null;
    if (acpDocsAvailable()) {
      const acpHits = acpDocSearch(q, limit, kindFilter);
      if (acpHits.length) {
        return { ok: true, query: q, scope: scopeArg, root: store, source: "acp_graph", count: acpHits.length, hits: acpHits.slice(0, limit) };
      }
    }
    const index = { pages: {}, reports: {} };
    try {
      Object.assign(index, JSON.parse(await readFile(join2(store, "index.json"), "utf8")));
    } catch {
    }
    const scope = String(args?.scope ?? "all");
    const scanPages = scope === "pages" || scope === "all";
    const scanReports = scope === "reports" || scope === "all";
    async function scanFile(file, label) {
      let text;
      try {
        text = await readFile(file, "utf8");
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
      const pagesDir = join2(store, "pages");
      if (existsSync2(pagesDir)) {
        for (const f of await readdir(pagesDir)) {
          if (f.endsWith(".md")) await scanFile(join2(pagesDir, f), `pages/${f}`);
        }
      }
    }
    if (scanReports && hits.length < limit) {
      const reportFiles = new Set(
        Object.values(index.reports).map((r) => String(r.output ?? "")).concat(
          Object.values(index.pages).map((p) => String(p.report ?? ""))
        )
      );
      for (const rel of reportFiles) {
        if (!rel) continue;
        const p = resolve(root, rel);
        if (existsSync2(p)) await scanFile(p, rel);
      }
    }
    return { ok: true, query: q, scope, root, count: hits.length, hits: hits.slice(0, limit) };
  }
};
function createRequestFence(ctx) {
  const resolveConnection = () => {
    const read = ctx?.get;
    if (typeof read !== "function") return void 0;
    try {
      const connection = read.call(ctx, "connection");
      return typeof connection?.requestRejection === "function" ? connection : void 0;
    } catch {
      return void 0;
    }
  };
  return (req, res) => {
    const connection = resolveConnection();
    if (connection === void 0) {
      res.statusCode = 503;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "connection service unavailable: the Host/Origin fence cannot be applied" }));
      return true;
    }
    const rejection = connection.requestRejection(req);
    if (rejection === void 0) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };
}
function registerHttpRoutes(ctx, register) {
  const rejected = createRequestFence(ctx);
  register("exact", "/api/analyzer/health", (req, res) => {
    if (rejected(req, res)) return;
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.setHeader("allow", "GET");
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, plugin: "dsh-lib-analyzer", ts: true }));
  });
}
function apply(ctx) {
  for (const tool of [scanTool, tasksTool, reportTool, searchTool]) {
    try {
      ctx.tools.register(tool);
    } catch (err) {
      console.error(`[lib-analyzer] ${tool.name} skipped: ${err}`);
    }
  }
  ctx.inject?.(["webServer"], (webCtx) => {
    const register = (kind, path, handler) => {
      webCtx.webServer.register({ kind, path, handler });
    };
    const mount = () => registerHttpRoutes(ctx, register);
    if (typeof webCtx.effect === "function") webCtx.effect(mount, "lib-analyzer: GET /api/analyzer/health");
    else mount();
  });
}
export {
  acpGraphAvailable,
  acpGraphDiagnostics,
  acpGraphStatusLine,
  apply,
  inject,
  name,
  registerHttpRoutes
};
