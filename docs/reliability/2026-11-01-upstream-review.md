# AgentMemory upstream comparison

Keep the fork for now. Port the independent safety fixes first, then evaluate a return to upstream in a separate migration exercise.

This review compares [the fork at 823df5d](https://github.com/davidrobertson/agentmemory/commit/823df5dad042d35b78aa9332de1e3597ac7d32d6) with [official upstream at c6c476d](https://github.com/rohitg00/agentmemory/commit/c6c476d2905926727fa5848a134d7a3b38a7fa98). GitHub identifies `rohitg00/agentmemory` as the parent of `davidrobertson/agentmemory`. The fork has 44 commits absent from upstream, and upstream has 65 absent from the fork. Both revisions use Apache-2.0 and have identical `LICENSE` files.

## Why retain the fork

Several fork behaviors remain distinct at these revisions.

- `src/functions/file-index.ts` uses `selectSessions` to reject partial or null session rows before filtering and applying the history cap. Upstream still sorts raw rows. Fork PR #11 fixed a real file-history failure.
- `src/functions/context.ts` includes selected durable memories in automatic context. Upstream has improved explicit durable-memory search and expansion, but its context path loads slots, profiles, and lessons without this collection.
- `src/hooks/_env.ts` hydrates hook settings from the environment file. The fork also gates pre-compact context explicitly and retains captures when worker routes return 404 during restarts.
- The fork has deliberate bounded graph writes, sharded graph indexes, and serialized viewer refreshes. Upstream also has side indexes, but its generation-scoped graph design differs. These paths need behavioral parity checks before replacement.

Upstream commit [36bdbe9](https://github.com/rohitg00/agentmemory/commit/36bdbe9) moves the engine and SDK from iii 0.22.1 to 0.25.0. It changes CLI lifecycle management to Worker Compose and moves viewer live updates to authenticated SSE. Its upgrade guide requires stopping the old runtime and preserving its data and credentials. This is an operational migration, not a routine dependency bump.

Upstream commit [857cf1b](https://github.com/rohitg00/agentmemory/commit/857cf1b) also introduces generation-scoped graph indexes and an explicit legacy scan. Upstream documents that initial discovery is unbounded. Graph retrieval reports `needs-migration` until an operator runs `graph-index migrate --allow-legacy-scan`. The review did not establish compatibility with the fork's sharded canonical graph records.

Keeping the fork has a cost. The two histories now differ across retrieval, capture, graph storage, and lifecycle management. Selective ports will need adaptation and regression tests. The preferred long-term direction is upstream once the remaining fork guarantees are either accepted upstream or demonstrated equivalent with an isolated installed-runtime test.

## First ports

| Upstream change | Decision | Reason |
| --- | --- | --- |
| [1c99508](https://github.com/rohitg00/agentmemory/commit/1c99508), import preflight | Port | Optional section shapes, keyed rows, and access-log limits must fail before a replace import deletes existing state. Preserve the fork's source budgets and graph representation. |
| [35813c5](https://github.com/rohitg00/agentmemory/commit/35813c5), identifier redaction boundaries | Port | Preserve ordinary identifiers containing key-like substrings while still redacting credentials. |
| [ea2f629](https://github.com/rohitg00/agentmemory/commit/ea2f629), structured redaction | Port capture paths | Scrubbing serialized JSON can break parsing. The fork's spool fallback then returns the original body. Recursively scrub values and collision-safe property names after JSON normalization. The unrelated vector-recovery gate edit is outside this port. |
| [72e1266](https://github.com/rohitg00/agentmemory/commit/72e1266), hook event identities | Port | Upstream reports shared prompt IDs across Claude hook events. Tests reproduce collisions for distinct subagents, tasks, and notification content. Preserve retry deduplication; identical notifications from one agent in one prompt still share an ID. |

The existing import payload, structured JSON capture body, and `ObserveBody` event payload remain the organizing data structures. These ports reuse upstream's settled behavior and the fork's boundaries. They do not introduce a new runtime architecture.

## Remaining upstream changes

The other commits fall into these groups. Deferral means the change is valuable but is outside the first safety port.

| Group and examples | Decision | Reason |
| --- | --- | --- |
| Durable search, project scoping, bounded retrieval, and token budgets, including 5a0db22, 9caace6, 9d70369, da91cc0, 6a182c4 | Evaluate next | Upstream improves linked-session scope checks, graph scores, and large-result handling. Adapt these to the fork's durable ranking, automatic context selection, and side indexes. |
| Write ordering, graph consistency, compression recovery, vector recovery, session finalization, and reflection, including a5e036c, 062159c, d9a20da, 7bf9c53, df3d4a8, 6a2b35a | Separate reliability work | These touch shared state, recovery checkpoints, or background processing. They need focused concurrency and recovery evidence. |
| Worker Compose, SSE, graph migrations, deployment changes, engine startup, diagnostics, and 0.9.31 release preparation | Separate migration | Validate installed capture, recall, hooks, auth, graph reads, restart recovery, and viewer behavior on isolated synthetic state before any deployment. |
| Linked-worktree projects and Claude transcript backfill, e37c6a7 and 0b3515d | Defer | Worktree canonicalization changes future project names without moving historical records. Transcript capture needs the fork's bounded shutdown and spool tests. |
| Hermes and OpenClaw hardening, c17874a | Separate integration review | Newer scoped credentials and profile isolation must retain custom data-directory behavior. |
| Local MCP fallback notices, 5f44085 | Defer | Adapt notices while preserving the fork's fail-closed configured-server behavior. |
| MCP stdout routing, e6d5136 | Skip the logging change | The fork already protects MCP stdout by sending all routine logs to stderr. Upstream also changes non-error logging outside MCP to stdout; this port leaves the fork's logging policy intact. |
| Exact MCP shim version, c554973 | Already covered | The fork's shim already pins its runtime release. |
| Cursor, Cline, Devin, dsh, pi and Oh My Pi integrations; skills-only Codex packaging | Defer optional integrations | These do not resolve the first safety issues. The skills-only Codex ZIP is an additional package flavor, not a reason to remove the fork's existing MCP packaging. |
| Import session limits and JSONL idempotence, export pagination, action pagination, facet cleanup, provider reporting and warnings | Follow-on correctness review | Useful independent fixes, but each needs its own boundary and compatibility checks. |
| Documentation, website, benchmark presentation, release publication and provenance | Defer to release or documentation work | Preserve review focus. No package publication is part of this PR. |

## Verification boundary

The regression tests exercise rejected imports against seeded in-memory state, structured capture and local spool files, and hook subprocess requests to isolated test servers. Generated plugin scripts must match source hooks. The repository's build, skill generation, documentation synchronization, skill checks, and test suite are required before commit.

This PR does not verify an iii 0.25 migration or install a new runtime. The existing service, memory data, repository settings, and release versions remain outside the execution scope.
