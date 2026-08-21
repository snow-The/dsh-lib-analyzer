# dsh-lib-analyzer

Library absorption analysis for DeepSeek Harness — turn a reference corpus
(`ref/`) into auditable, evidence-first **absorption reports** and a
searchable per-library knowledge base.

Inspired by two things, and better than both for this job:

- **r32's `ref → batch` pipeline** (tasks.jsonl → prompts → `batch/out/*.md`
  absorption reports with 大文件纪律 / 证据优先 / 提取方式 provenance):
  its discipline is now enforced by tools, not just prompt text.
- **hindsight-coding-agents**: its knowledge-page + retrieval idea is kept,
  but pages here are **derived from finished reports** (with file:line
  evidence and rebuildable from disk) instead of being recalled from
  conversation — auditable, no background model calls, fully offline.

## Tools

| Tool | Purpose |
|---|---|
| `libscan` | Scan `ref/<library>`: tree, language mix, **>1MB big-file list** (big-file discipline), doc inventory. Read-only. |
| `libtasks` | Drive `batch/tasks.jsonl` (id/target/focus/deliverable/output per line): list with filesystem-derived status, or `--next` pending task in full. |
| `libreport` | Validate a finished report (required sections 概览/关键机制/可吸收设计/落地章节建议/风险与教训/提取方式, ✓◐✗ markers, file:line evidence), then sink a knowledge page into `.dsh-lib-analyzer/pages/` and update the index. |
| `libsearch` | Keyword search across knowledge pages + produced reports (hindsight-style retrieval, local-only). |

## Skill

- `library-analysis` — full workflow: take task → read project context
  (adc/src/book/SYNTHESIS) → scan → disciplined read-only research → report
  with provenance → `libreport` sink → next task.

## Layout

```
<project>/
├── ref/                 # read-only reference corpus
├── batch/
│   ├── tasks.jsonl
│   └── out/*.md         # absorption reports
└── .dsh-lib-analyzer/
    ├── index.json
    └── pages/<lib>.md   # per-library knowledge pages
```

## Design rules

1. Node builtins only — no child processes, no network, no model calls.
2. All writes stay inside `.dsh-lib-analyzer/`.
3. Task status is derived from the filesystem (output file exists), never
   from memory.
4. The knowledge base is fully rebuildable from reports.

## License

MIT
