/**
 * acp-graph-contract.ts — ACP 图（~/.dsh/graph/graph.db）的【规范只读接口】。
 *
 * 为什么需要它
 * ------------
 * graph.db 由 dsh-session-handoff 生产，而 acp-memory / notemap / research-lab /
 * lib-analyzer / skill-pack 五个插件各自【裸 SQLite 直读 + 硬编码表名】。后果是：
 *   - 生产者改一次 schema，五个消费方【同时静默失效】——它们全都"失败即返回 []"；
 *   - 而"返回 []"既可能是"本来就没数据"，也可能是"schema 变了/库没建/锁住了"，
 *     消费方无法区分，调用方更无法区分。acp-memory 的作者注释自述这类静默故障
 *     曾造成【一周哑火】。
 *
 * 本模块把这三件事变成结构性的，而不是靠每个消费方自觉：
 *   1) 版本协商：读 PRAGMA user_version + 必需表/列存在性检查 -> 明确的 schema 状态，
 *      而不是等某条 SQL 抛错。
 *   2) 失败可辨：所有读取返回 Result（ok/reason），reason 区分
 *      'no-db' | 'no-contract' | 'schema-mismatch' | 'error'，绝不用空数组冒充成功。
 *   3) 单一实现：五个消费方用【同一份】代码（由 scripts/sync-acp-reader.mjs 复制并
 *      带哈希校验），而不是五份会各自漂移的复制品。
 *
 * 边界（重要）
 * ------------
 * 本模块【只读】。绝不 CREATE/ALTER/INSERT/UPDATE/DELETE，绝不改 PRAGMA。
 * 库是跨会话长期记忆的 source-of-truth，其结构与数据只能由生产者(handoff)变更。
 *
 * 契约版本
 * --------
 * ACP_GRAPH_CONTRACT_VERSION 是【本模块】声明的契约版本；库侧的 PRAGMA user_version
 * 是【生产者】盖的戳。两者关系：
 *   - 库 user_version === 0  -> 'no-contract'：库先于契约存在。此时仍按 v1 形状读取并
 *     逐表校验（向后兼容），但通过 status().stamped 告知调用方"生产者还没盖章"。
 *   - 库 user_version === 本模块版本 -> 正常。
 *   - 库 user_version >  本模块版本 -> 'schema-mismatch'：库比消费方新，拒绝猜测。
 *     （库较新时按旧形状读会得到静默错误结果，这正是要防的。）
 */

// @generated-from dsh-acp-graph-contract@b7ec6e25d5855c71 — 请勿手工编辑。
// 同步工具: dsh-acp-graph-contract/sync-acp-reader.mjs （源仓库 C:/Users/snow/source/repos/dsh-acp-graph-contract/acp-graph-contract.ts）
// 手工修改会在 --check 里被发现为漂移; 要改行为请改规范源再同步。


import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 本模块实现的 ACP 图契约版本。 */
export const ACP_GRAPH_CONTRACT_VERSION = 1;

/**
 * v1 契约要求的表与列。
 * 生产者的建表语句见 handoff/lib/graph.js:138-159。消费方只依赖这里列出的部分。
 *
 * `docs` / `doc_fts` 是 dsh-lib-analyzer 唯一真正查询的表面 —— 若不在这里列出，
 * 生产者改动 docs 的列形状时 status() 仍会报 ok，而查询要到运行时才失败。
 * 校验面必须覆盖【消费方实际查询的表面】，否则契约只是装饰。
 */
export const ACP_GRAPH_V1_REQUIRED: Readonly<Record<string, readonly string[]>> = {
  checkpoints: ['session_id', 'seq_start', 'seq_end', 'summary', 'created_at'],
  checkpoint_nodes: ['session_id', 'seq_start', 'node_id'],
  nodes: ['id', 'kind', 'title', 'mention_count'],
  cp_fts: ['session_id', 'seq_start', 'summary'],
  node_fts: ['id', 'title', 'kind'],
  docs: ['id', 'kind', 'title', 'body', 'source', 'indexed_at'],
  doc_fts: ['id', 'kind', 'title', 'body'],
};

export type AcpGraphReason =
  | 'ok'
  | 'no-db'
  | 'no-contract'
  | 'schema-mismatch'
  | 'error';

export interface AcpGraphStatus {
  /** 是否可用（true 表示可以读取，且形状符合契约）。 */
  ok: boolean;
  path: string;
  /** 库侧 PRAGMA user_version。 */
  stampedVersion: number;
  /** 本模块实现的契约版本。 */
  contractVersion: number;
  /** 生产者是否已盖章（stampedVersion > 0）。 */
  stamped: boolean;
  reason: AcpGraphReason;
  /** reason !== 'ok' 时的人类可读原因（供日志/诊断）。 */
  detail?: string;
  /** 缺失的表 -> 缺失的列。 */
  missing?: Record<string, string[]>;
}

export type AcpGraphResult<T> =
  | { ok: true; value: T; status: AcpGraphStatus }
  | { ok: false; reason: Exclude<AcpGraphReason, 'ok'>; detail: string; status: AcpGraphStatus };

/** graph.db 的规范路径。 */
export function acpGraphPath(): string {
  // 路径解析规则（这是【明确的设计决定】，不是偶然）：
  //   graph.db 由 dsh-session-handoff 生产，而 handoff 用官方
  //   @deepseek-ai/dsh-home-paths 的 dshHomePath() 解析它的位置，官方只认 DSH_HOME
  //   （DSH_HOME_ENV = 'DSH_HOME'；官方源码里不存在 DSH_DATA_DIR）。
  //   消费方必须用【生产者的同一个基准】解析，否则会去读另一个文件：
  //   生产者在写 A，消费方在读 B，而两边都"成功"——这正是本契约要消灭的静默故障。
  //   因此这里【故意】不 honor 任何插件私有变量（例如某些插件自用的 DSH_DATA_DIR）。
  //   需要隔离时用 DSH_HOME：它对生产者和所有消费方同时生效。
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'graph', 'graph.db');
}

/**
 * FTS5 短语构造：每个词加引号，使路径(C:\x)、"*"、":"、引号等用户文本永远不会被
 * 解析成列过滤或运算符。无有效词时回退为空短语（无害）。
 * 这是原先在 4 个插件里【逐字复制 4 份】的那段代码的唯一实现。
 *
 * 已知语义（照实记录，因为消费方极易误解）：
 *   - 只保留【长度 > 1】的 token，因此【单字符词被丢弃】：
 *     ftsPhrase('a b') === '""'，而不是 '"a"* OR "b"*'。
 *     这是原实现的既有行为，四个消费方都依赖它；保持不变以免静默改变检索结果。
 *     （实测：ftsPhrase('C:\\x * foo') === '"\\x"* OR "foo"*' —— '\\x' 恰好是两字符。）
 *   - 最多取前 8 个 token。
 *   - 全部无效时返回 '""'，不抛错也不返回空串。
 *   - 剥离的字符集: " ' ^ * : ( ) [ ] { }
 */
export function ftsPhrase(q: unknown): string {
  const toks = String(q ?? '')
    .toLowerCase()
    .replace(/["'^*:()\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .slice(0, 8);
  return toks.length ? toks.map((t) => '"' + t + '"*').join(' OR ') : '""';
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

/**
 * 探测契约状态。这是唯一允许"试探"的地方：它只读 schema，不读数据，失败也明确分类。
 */
export function acpGraphStatus(): AcpGraphStatus {
  const path = acpGraphPath();
  const base = { path, contractVersion: ACP_GRAPH_CONTRACT_VERSION };
  if (!existsSync(path)) {
    return { ...base, ok: false, stampedVersion: 0, stamped: false, reason: 'no-db', detail: `graph.db not found at ${path}` };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const stampedVersion = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined)?.user_version ?? 0,
    );

    if (stampedVersion > ACP_GRAPH_CONTRACT_VERSION) {
      // 库比消费方新：按旧形状读会得到静默错误结果，明确拒绝而不是猜。
      return {
        ...base, ok: false, stampedVersion, stamped: true, reason: 'schema-mismatch',
        detail: `graph.db is stamped v${stampedVersion} but this reader implements v${ACP_GRAPH_CONTRACT_VERSION}; upgrade the reader`,
      };
    }

    // 逐表逐列校验（对 stamped 与 unstamped 一视同仁 —— 不靠版本号代替形状检查）。
    const missing: Record<string, string[]> = {};
    for (const [table, cols] of Object.entries(ACP_GRAPH_V1_REQUIRED)) {
      const have = tableColumns(db, table);
      if (have.length === 0) { missing[table] = [...cols]; continue; }
      const lack = cols.filter((c) => !have.includes(c));
      if (lack.length) missing[table] = lack;
    }
    if (Object.keys(missing).length) {
      return {
        ...base, ok: false, stampedVersion, stamped: stampedVersion > 0, reason: 'schema-mismatch',
        detail: 'graph.db shape does not satisfy contract v1', missing,
      };
    }

    if (stampedVersion === 0) {
      // 形状对得上，但生产者尚未盖章：可读，且如实标注。
      return {
        ...base, ok: true, stampedVersion, stamped: false, reason: 'no-contract',
        detail: 'graph.db has no user_version stamp (created before the contract); shape verified against v1',
      };
    }
    return { ...base, ok: true, stampedVersion, stamped: true, reason: 'ok' };
  } catch (e) {
    return {
      ...base, ok: false, stampedVersion: 0, stamped: false, reason: 'error',
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * 在契约保护下执行一次只读查询。
 *
 * 与"自己 try/catch 然后 return []"的区别：调用方拿到的失败是【具名的】，
 * 因此可以决定"记录/提示/降级"，而不是把"库坏了"和"没数据"混为一谈。
 */
export function withAcpGraph<T>(fn: (db: DatabaseSync, status: AcpGraphStatus) => T): AcpGraphResult<T> {
  const status = acpGraphStatus();
  if (!status.ok) {
    return {
      ok: false,
      reason: status.reason === 'ok' ? 'error' : status.reason,
      detail: status.detail ?? status.reason,
      status,
    };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(status.path, { readOnly: true });
    return { ok: true, value: fn(db, status), status };
  } catch (e) {
    return {
      ok: false, reason: 'error',
      detail: e instanceof Error ? e.message : String(e),
      status,
    };
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

/**
 * 便捷包装：失败时返回 fallback，并把失败原因交给 onProblem 记录
 * （调用方通常传自己的 warn；不传则静默 —— 但失败原因始终可从 Result 拿到）。
 */
export function acpGraphOr<T>(fallback: T, fn: (db: DatabaseSync, status: AcpGraphStatus) => T, onProblem?: (detail: string, status: AcpGraphStatus) => void): T {
  const r = withAcpGraph(fn);
  if (r.ok) return r.value;
  onProblem?.(r.detail, r.status);
  return fallback;
}

/**
 * 跨会话 checkpoint 检索：FTS5 实体命中 + 摘要命中（去重后按 limit 截断）。
 * 这是 acp-memory 原先在 core/acp.ts 里自实现的逻辑，现为共享实现。
 */
export interface AcpRecallHit { node: string; summary: string; score: number }

export function acpGraphRecall(query: string, limit = 4): AcpGraphResult<AcpRecallHit[]> {
  return withAcpGraph((db) => {
    const q = String(query ?? '').toLowerCase().trim();
    if (!q) return [] as AcpRecallHit[];
    const matchQ = ftsPhrase(q);
    const out: AcpRecallHit[] = [];
    // 1) 实体命中 -> 带出它所在的最新 checkpoint
    try {
      const rows = db.prepare('SELECT id FROM node_fts WHERE node_fts MATCH ? LIMIT ?').all(matchQ, limit) as { id: string }[];
      for (const r of rows) {
        const cps = db
          .prepare('SELECT c.summary FROM checkpoints c JOIN checkpoint_nodes cn ON cn.session_id=c.session_id AND cn.seq_start=c.seq_start WHERE cn.node_id=? ORDER BY c.created_at DESC LIMIT 1')
          .all(r.id) as { summary: string }[];
        if (cps.length) out.push({ node: r.id, summary: cps[0].summary, score: 1 });
      }
    } catch { /* 单条子查询失败不应吞掉另一条的结果 */ }
    // 2) checkpoint 摘要命中
    try {
      const cps = db
        .prepare('SELECT session_id, seq_start, summary FROM cp_fts WHERE cp_fts MATCH ? LIMIT ?')
        .all(matchQ, limit) as { session_id: string; seq_start: number; summary: string }[];
      for (const c of cps) out.push({ node: 'cp:' + c.session_id + ':' + c.seq_start, summary: c.summary, score: 0.8 });
    } catch { /* 同上 */ }
    const seen = new Set<string>();
    const dedup: AcpRecallHit[] = [];
    for (const o of out) { if (!seen.has(o.node)) { seen.add(o.node); dedup.push(o); } }
    return dedup.slice(0, limit);
  });
}

/** 热实体：按 mention_count 取图中最高频节点（供首轮注入引导）。 */
export function acpGraphHotEntities(limit = 5): AcpGraphResult<{ node: string; count: number }[]> {
  return withAcpGraph((db) =>
    db.prepare('SELECT title AS node, mention_count AS count FROM nodes ORDER BY mention_count DESC LIMIT ?').all(limit) as { node: string; count: number }[],
  );
}
