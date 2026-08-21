---
name: library-analysis
description: >-
  Library absorption analysis — produce evidence-first "absorption reports"
  (吸收报告) for a reference corpus (ref/) that feed decisions in a host
  project. Drives task batches (batch/tasks.jsonl), enforces big-file
  discipline (>1MB never read whole), file:line evidence citations,
  ✓/◐/✗ comparison markers, an 提取方式 provenance section, and sinks each
  finished report into a searchable per-library knowledge base via libreport.
  Use when the user asks to study/absorb a third-party codebase, mine a
  reference library for designs, run the ref→batch pipeline, or build up
  library knowledge pages.
---

# Library Analysis（库吸收分析）

把 `ref/` 参考库转成**可落地、可审计**的吸收报告，并沉淀为可检索的知识库。

## 目标项目布局（r32 惯例，可配置）

```
<project>/
├── ref/                  # 参考库（第三方源码/文档/手册，只读）
├── batch/
│   ├── tasks.jsonl       # 任务清单：每行一个 JSON 任务
│   ├── prompts/          # 生成的提示词（可选）
│   ├── adc.md            # 项目架构常识（权威）
│   ├── src.md            # 项目源码模块地图
│   ├── book.md           # 书籍/章节索引
│   ├── out/              # 吸收报告输出（r01-cyber.md ...）
│   └── out/SYNTHESIS.md  # 已有吸收结论汇总（避免重复研究）
└── .dsh-lib-analyzer/    # 知识库（libreport 自动维护）
    ├── index.json
    └── pages/<lib>.md    # 每库一页知识页
```

## 工作流

1. **取任务**：`libtasks`（`--next` 拿下一个 pending 任务；任务含 target/focus/
   deliverable/output）。没有任务文件时按 `libtasks` 报错给出的格式建一个。
2. **读项目常识**（研究前必读，r32 惯例）：
   `batch/adc.md`（架构权威）、`batch/src.md`（模块地图）、`batch/book.md`
   （章节索引）、`batch/out/SYNTHESIS.md`（已有结论，避免重复）。
3. **摸结构**：`libscan` 扫 `ref/<target>` —— 目录树、语言分布、**>1MB 大文件
   清单**、文档清单。
4. **只读研究**（纪律）：
   - 不改 `ref/` 下任何文件；引用具体文件/函数/结构体（带路径）。
   - **大文件纪律**：>1MB 的 md/源码禁止整体读入 —— 用脚本按需提取（目录/
     章标题/代码关键字），单次读取 ≤1MB（约 1 万行）。
   - **证据优先**：结论必须给「文件:行」级出处；无出处的推断标「待复核」。
5. **写报告**：中文 Markdown，写到任务指定的 output 路径。结构：
   1. 概览
   2. 关键机制（对照结论用 ✓ 实证 / ◐ 记录（差距=教学取舍）/ ✗ 冲突（需改））
   3. 可吸收设计（每条标注 **直接可用 / 需改造 / 仅参考**）
   4. 落地章节建议（每条建议都能在目标项目某章节落地）
   5. 风险与教训
   6. **提取方式**（必须）：① 每个结论的来源文件/章节（文件:行 或 章名）
      ② 用了什么提取手段（脚本正则/目录扫描/精读某段/全文略读）③ 哪些关键段
      **建议主上下文亲自复核**（拿不准/影响大决策的，列出来，不要藏）。
6. **收尾沉淀**：`libreport` 校验报告纪律（必需小节/✓◐✗/file:line 证据）并
   生成知识页到 `.dsh-lib-analyzer/pages/`。校验缺节就补，别跳过。
7. **下一任务**：重复 1–6。全部完成后更新/检查 `SYNTHESIS.md`。

## 检索与复用

- `libsearch <query>`：在知识页 + 已产报告中检索既有结论，研究新库前先查，
  避免重复劳动。
- 知识页由报告自动生成、可审计可重建 —— 结论以报告为准，不以对话回忆为准。

## 与通用 agent 技能的分工

- 这是**批量收集资料引导决策**的定位：报告引导主上下文，不代替主上下文阅读。
- 拿不准/影响大决策的关键段必须在「提取方式」里点名建议主上下文亲自复核。
