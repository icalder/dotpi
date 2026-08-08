---
name: codebase-memory
description: "Query a persistent knowledge graph (tree-sitter AST + Hybrid LSP type resolution) over any indexed codebase for architecture understanding, caller/impact analysis, and cross-file reasoning. Trigger on: **index this project/repo/codebase/repository**, **explore the codebase**, **understand the architecture**, **who calls X**, **what does X call**, **show dependencies**, **dead code**, **refactor candidates**, **impact analysis**. Complements grep/LSP for line-level lookups."
---

# codebase-memory

Query a persistent **knowledge graph** (tree-sitter AST + Hybrid LSP type resolution) over an indexed codebase. Use as a structural first-pass for architecture understanding, caller/impact analysis, and cross-file reasoning. Complements grep/LSP for source-level lookups.

## Prerequisites

The project must be indexed first. The **project name is derived from the repository root path**, not the folder name:

```
Repo:  /home/itcalde/rust/solardisp
Name:  home-itcalde-rust-solardisp   ← use THIS as the "project" arg
```

Discover names with `list_projects`. If a project is missing, run `index_repository(repo_path="/absolute/path/to/repo")`. Auto-indexing can be enabled with `codebase-memory-mcp config set auto_index true`.

### Team-Shared Graph Artifact

Run `index_repository(repo_path=..., persistence=true)` to write a compressed snapshot (`.codebase-memory/graph.db.zst`) into the project root. Commit it to git (a `.gitattributes` with `merge=ours` is auto-created). Teammates who clone the repo get **automatic decompression + incremental reindex** on first index — no full reindex needed. Add `.codebase-memory/` to `.gitignore` to opt out.

## Tools (14)

### Indexing
| Tool | Key parameters |
|---|---|
| `index_repository` | `repo_path` *(required)*, `mode` (full/moderate/fast/cross-repo-intelligence), `target_projects`, `name`, `persistence` *(write .codebase-memory/graph.db.zst for team sharing)* |
| `list_projects` | — |
| `index_status` | `project` |
| `delete_project` | `project` |

### Querying
| Tool | Key parameters | Best for |
|---|---|---|
| `get_architecture` | `project`, `aspects[]` (all, overview, structure, dependencies, routes, languages, packages, entry_points, hotspots, boundaries, layers, file_tree, clusters), `path` *(subdirectory scope)* | One-shot overview: layers, boundaries, hotspots, clusters |
| `search_graph` | `project`, `query` *(BM25 text)*, `name_pattern` *(regex)*, `semantic_query[]` *(vector keywords)*, `label`, `qn_pattern`, `file_pattern`, `relationship`, `min_degree`/`max_degree`, `exclude_entry_points`, `include_connected`, `limit`/`offset` | Find a definition by name, label, or structural criteria |
| `search_code` | `project`, `pattern` *(required)*, `file_pattern`, `path_filter` *(regex)*, `mode` (compact/full/files), `context`, `regex`, `limit` | Grep-like text search enriched with graph dedup; `total_grep_matches` vs `total_results` reveals dedup ratio |
| `query_graph` | `project`, `query` *(Cypher, required)*, `max_rows` | Cypher queries: multi-hop patterns, aggregations, hot-path analysis |
| `trace_path` | `project`, `function_name` *(required)*, `direction` (inbound/outbound/both), `depth` (1–5), `mode` (calls/data_flow/cross_service), `parameter_name` *(for data_flow)*, `edge_types[]`, `risk_labels`, `include_tests` | Caller/impact maps; data-flow tracing; cross-service call chains |
| `get_code_snippet` | `project`, `qualified_name` *(required — from search_graph)*, `include_neighbors` | Read source for a resolved symbol (not a search tool) |
| `detect_changes` | `project`, `scope`, `depth`, `base_branch`, `since` | Map git diff → affected symbols + risk classification |
| `manage_adr` | `project`, `mode` (get/update/sections), `content`, `sections[]` | Persist Architecture Decision Records across sessions |
| `ingest_traces` | `project`, `traces[]` *(required: caller/callee/count)* | Ingest runtime traces to enhance cross-repo call edges |

## Decision Tree

**"Who calls X / what breaks if I change X?"**
`trace_path(function_name="X", direction="inbound", depth=3)` → always prefer this over `search_graph` for caller discovery.

**"What does X call / its dependency depth?"**
`trace_path(function_name="X", direction="outbound", depth=3)`

**"Find a function/struct by name or pattern"**
`search_graph(project=…, name_pattern=".*partial.*")` — or `query="natural language"` for BM25 text search.

**"Find callers by vocab mismatch (e.g. search 'send' → find 'publish')"**
`search_graph(project=…, semantic_query=["send","pubsub"])` — requires `mode: full` or `moderate` index.

**"Show me the architecture: layers, hotspots, boundaries"**
`get_architecture(project=…, aspects=["overview"])` — adds `["clusters"]` for de-facto module grouping.

**"Read the source of a resolved symbol"**
1. `search_graph` → copy `qualified_name`
2. `get_code_snippet(qualified_name="…")`

**"Complex multi-hop / aggregation query"**
`query_graph(project=…, query="MATCH … RETURN …")` — see Cypher reference below.

**"What changed and what's affected?"**
`detect_changes(project=…, since="HEAD~3")`

## Cypher Queries (`query_graph`)

`query_graph` executes **read-only openCypher** (a subset). Anything outside the subset fails with a clear error — it does **not** silently return empty results.

### Supported Cypher subset

**Clauses:** `MATCH`, `OPTIONAL MATCH`, multiple `MATCH`, `WHERE`, `WITH` (+ `WITH … WHERE`), `RETURN`, `ORDER BY`, `SKIP`, `LIMIT`, `DISTINCT`, `UNWIND`, `UNION` / `UNION ALL`, `CASE`.

**Patterns:** labelled nodes, label alternation `(n:A|B)`, relationship types & direction, variable-length paths `[*1..3]`, inline property maps `{key: val}`.

**WHERE operators:** `= <> < <= > >=`, `AND/OR/XOR/NOT`, `IN`, `CONTAINS`, `STARTS WITH`, `ENDS WITH`, `IS [NOT] NULL`, regex `=~`, label test `n:Label`, existential `EXISTS { (n)-[:TYPE]->() }`.

**Aggregates:** `count` (+`DISTINCT`), `sum`, `avg`, `min`, `max`, `collect`.

**Functions:** `labels`, `type`, `id`, `keys`, `properties`; `toLower`/`toUpper`/`toString`/`toInteger`/`toFloat`/`toBoolean`; `size`, `length`, `trim`/`ltrim`/`rtrim`, `reverse`; `coalesce`, `substring`, `replace`, `left`, `right`.

**100k-row ceiling** — add `LIMIT` in Cypher itself for broad queries. No offset support in `query_graph`; use `search_graph` + `offset`/`limit` for paginated browsing.

### Useful query patterns

```cypher
# Dead-code detection (no callers, excluding entry points)
MATCH (f:Function)
WHERE NOT EXISTS { (f)<-[:CALLS]-() }
  AND f.name <> 'main'
RETURN f.name, f.qualified_name

# Who calls this specific function (direct callers)
MATCH (f:Function {name: 'reset_mqtt_buffer'})<-[:CALLS]-(caller)
RETURN caller.name, caller.file_path
-- For transitive (depth-N) caller maps, use trace_path instead.

# Top-N most-called callees
MATCH (f:Function)-[:CALLS]->(g:Function)
RETURN g.name AS callee, count(DISTINCT f) AS callers
ORDER BY callers DESC LIMIT 10

# Hot-path candidates (complexity + loop analysis)
MATCH (f:Function)
WHERE f.transitive_loop_depth >= 3 OR f.linear_scan_in_loop >= 1
RETURN f.qualified_name, f.transitive_loop_depth, f.linear_scan_in_loop
ORDER BY f.transitive_loop_depth DESC

# All functions in a file
MATCH (f:Function)
WHERE f.file_path CONTAINS 'mqtt.rs'
RETURN f.name, f.signature, f.complexity

# Structs that call a specific function
MATCH (s:Struct)-[:DEFINES_METHOD]->(m:Method)-[:CALLS]->(g:Function {name: 'reset_mqtt_buffer'})
RETURN DISTINCT s.name
```

### Edge types in this project
`CALLS`, `USAGE`, `DEFINES`, `DEFINES_METHOD`, `IMPORTS`, `IMPLEMENTS`, `CONTAINS_FILE`, `CONTAINS_FOLDER`, `WRITES`, `DECORATES`, `FILE_CHANGES_WITH`, `SEMANTICALLY_RELATED`, `SIMILAR_TO`, `TESTS`, `HAS_BRANCH`, `INFRA_MAPS`. Node labels include `Function`, `Method`, `Struct`, `Enum`, `Class`, `Interface`, `Variable`, `Field`, `Module`, `File`, `Folder`, `Section`, `Decorator`, `Branch`, `Type`, `Project`. Use `get_graph_schema(project=…)` for the project-specific schema.

## Trace Path Modes (`trace_path`)

| Mode | Follows | Use case |
|---|---|---|
| `calls` *(default)* | `CALLS` edges | Caller/impact maps |
| `data_flow` | `CALLS` edges (via `args` property) | Trace how a value propagates through argument expressions |
| `cross_service` | Cross-repo `CALLS` routed through `Route` nodes | Cross-service call chains, HTTP route ↔ call-site matching |

`risk_labels=true` adds CRITICAL/HIGH/MEDIUM/LOW classification by hop distance. `include_tests=true` includes test files (default: filtered out).

## Known Limitations & Gotchas

- **`search_graph` under-reports callers** — uses BM25 ranking, not full edge traversal. A function with 4 callers may report `in_degree: 3`. **Always use `trace_path(direction="inbound")` for caller discovery.**
- **`search_graph` caps at 200 results by default** — check `has_more` in the response; page with `offset` to avoid silent truncation on large result sets.
- **Method-level resolution is spotty** — methods like `UnixTimer::new` appear in hotspots but may not be individually queryable as graph nodes. Only the parent struct may be indexed.
- **`semantic_query` requires `mode: full` or `moderate`** — fast-index projects won't return vector results. Results appear in `semantic_results`, separate from `results`.
- **`search_code` has no offset** — it's capped at `limit` (default 10). Raise `limit` or narrow with `file_pattern`/`path_filter` to see more.
- **Index drifts after edits** — `detect_changes` maps uncommitted changes to affected symbols. The background watcher auto-syncs on git changes if `auto_watch` is true (default).
- **`get_code_snippet` is not a search tool** — it requires an exact `qualified_name` from `search_graph` first. Passing a short name returns suggestions when ambiguous.
- **No call-site details** — the graph gives caller counts, not argument expressions or line numbers. Use `trace_path(mode="data_flow")` for arg propagation, or grep + `get_code_snippet` for precise source.
- **Cypher is read-only** — write clauses (`MERGE`, `SET`, `DELETE`, `CREATE`) are outside the supported subset and will error.
