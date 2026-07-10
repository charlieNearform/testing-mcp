---
stepsCompleted: ['step-01', 'step-02', 'step-03', 'step-04', 'step-05', 'step-06']
inputDocuments:
  - docs/prd.md
  - docs/architecture.md
  - _bmad-output/planning-artifacts/prd/prd-test-server-mcp-2026-07-10/SPEC.md
  - _bmad-output/planning-artifacts/architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md
  - _bmad-output/planning-artifacts/epics.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-10
**Project:** test-server-mcp

---

## Step 1: Document Discovery

### Documents Found

**PRD Documents:**
- `docs/prd.md` — main PRD (source of truth)
- `_bmad-output/planning-artifacts/prd/prd-test-server-mcp-2026-07-10/SPEC.md` — derived requirements contract (C1–C9)

**Architecture Documents:**
- `docs/architecture.md` — component spine, contracts, IPC/state schemas
- `_bmad-output/planning-artifacts/architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md` — derived invariants (AD-1…AD-10)

**Epics & Stories:**
- `_bmad-output/planning-artifacts/epics.md` — 5 epics, 18 stories

**PRFAQ:**
- `_bmad-output/planning-artifacts/prfaq.md` — historical pressure-test (resolved; findings folded into PRD)

**UX:** none (agent-facing product; Phase-2 UI deferred)

### Duplicates / Conflicts

No unresolved duplicates. `docs/prd.md` + `docs/architecture.md` are the whole-document sources of truth; `SPEC.md` / `ARCHITECTURE-SPINE.md` are their derived BMAD contracts (regenerated from memlogs on 2026-07-10) and are consistent with them.

### Alignment Check

**PRD ↔ SPEC ↔ Architecture Spine:**
- ✅ Primary consumer = AI agents; human UI explicitly Phase 2.
- ✅ Paradigm consistent: singleton daemon + per-project worker (AD-6, AD-7) across all three.
- ✅ Coverage approach consistent: single-pass V8 + setup-baseline subtraction + always-run + recall-first fallback (C9/AD-9/AD-10).
- ✅ State topology consistent: repo-local `.test-mcp/` + central `~/.test-mcp` (AD-8).

**Architecture ↔ Epics:**
- ✅ Epic 1 → AD-6, AD-8 (daemon, registration, state)
- ✅ Epic 2 → AD-2, AD-7, AD-4 (project-local execution)
- ✅ Epic 3 → AD-3, AD-9, AD-10 (coverage intelligence)
- ✅ Epic 4 → AD-1a, AD-4 (dry run, status, output)
- ✅ Epic 5 → AD-1 (Phase-2 UI)

---

## Step 2: PRD Analysis

### Functional Requirements (from epics.md inventory, derived from PRD)

FR1 singleton daemon (Streamable HTTP); FR2 `test-mcp` CLI + auto-boot; FR3 register/list/unregister + repo-local config/gitignore; FR4 project-local worker execution; FR5 structured results + failure detail; FR6 dry-run plan/commit; FR7 status + progress; FR8 minimal output; FR9 git-delta selection; FR10 coverage reverse-map; FR11 setup-baseline subtraction; FR12 always-run unmeasurable; FR13 union + full-suite fallback; FR14 watch mode; FR15 Vitest isolation; FR16 registry persistence/rehydrate; FR17 (Phase 2) human UI.

**Total FRs: 17** (FR1–FR16 Phase 1, FR17 Phase 2)

### Non-Functional Requirements

NFR1 dry-run <5s / incremental <15s; NFR2 recall-prioritised, no missed failures; NFR3 loopback + Host/Origin + bearer token; NFR4 project-local execution isolation; NFR5 state transparency + `schemaVersion`; NFR6 macOS-first; NFR7 minimal overhead; NFR8 map built within one full run.

**Total NFRs: 8**

### Additional Requirements (from Architecture)

- No starter template (greenfield); `@modelcontextprotocol/sdk` v1 (`McpServer` + `StreamableHTTPServerTransport`); `vitest/node` pinned (target 4.1.9); `child_process.fork` workers; error envelope `{code,message,details?}`; single-pass coverage engine (spike-validated).

### PRD Completeness

- ✅ Requirements extracted and mapped; no critical gaps.
- ✅ Dry run (FR6) covered in Epic 4 Story 4.1; coverage-pollution mitigations (FR11/FR12) covered in Epic 3.

---

## Step 3: Epic Coverage Validation

| FR | Requirement | Epic/Story | Status |
| --- | --- | --- | --- |
| FR1 | Singleton daemon | 1.1, 1.2 | ✅ |
| FR2 | CLI + auto-boot | 1.3 | ✅ |
| FR3 | Registration | 1.3 | ✅ |
| FR4 | Project-local execution | 2.1 | ✅ |
| FR5 | Results + failure detail | 2.2 | ✅ |
| FR6 | Dry-run plan/commit | 4.1 | ✅ |
| FR7 | Status + progress | 4.2 | ✅ |
| FR8 | Minimal output | 4.3 | ✅ |
| FR9 | Git-delta selection | 3.1 | ✅ |
| FR10 | Coverage reverse-map | 3.2 | ✅ |
| FR11 | Setup-baseline subtraction | 3.3 | ✅ |
| FR12 | Always-run unmeasurable | 3.4 | ✅ |
| FR13 | Union + fallback | 3.5 | ✅ |
| FR14 | Watch mode | 3.6 | ✅ |
| FR15 | Isolation | 2.3 | ✅ |
| FR16 | Registry persistence | 1.4 | ✅ |
| FR17 | Human UI (P2) | 5.1, 5.2 | ✅ |

### Coverage Statistics

- Total FRs: 17 · Covered: 17 · **Coverage: 100%**
- Missing requirements: none.

---

## Step 4: UX Alignment Assessment

### UX Document Status

Not applicable — the primary consumer is AI agents; there is no UX contract by design. The only human surface (Epic 5) is a Phase-2 convenience UI over the daemon.

### Warnings

⚠️ If/when Epic 5 is scheduled, produce a lightweight UX spec (dashboard layout, status/error states, reconnect behavior) before its stories are implemented. Not a Phase-1 blocker.

---

## Step 5: Epic Quality Review

| Epic | User Value | Independent | Stories Sized | No Forward Deps | State Timing | AC Clear | FR Traceable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 Core Daemon & Registration | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 2 Project-Local Execution | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 Intelligent Selection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 Agent Workflow | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 Human UI (P2) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### Notes

- The prior report's "Epic 1 sounds technical" finding is **resolved**: Epic 1 is now framed as user value ("register any vitest project and address it by projectId") rather than "project setup."
- State/entities created per-story (registry in 1.3–1.4, coverage map in 3.2, plan cache in 4.1), not upfront.
- Dependency chain 1→2→3→4 is forward-only; Epic 5 fully deferrable.
- File-churn: epics target distinct components (daemon/registry, worker, coverage engine, orchestrator/output); split justified by risk boundaries.

---

## Step 6: Final Assessment

### Overall Readiness Status

**READY** — no blocking issues.

### Critical Issues Requiring Immediate Action

None.

### Watch Items (non-blocking)

1. **Coverage-map build is the core technical risk** (per PRD/architecture and `spike/coverage-map/FINDINGS.md`). Mitigated by the single-pass + setup-baseline + always-run design, and by **vendoring `testpick`'s MIT attribution algorithm** (decision 2026-07-10) rather than rebuilding it — keep the spike harness as a regression check when implementing Epic 3, and include testpick's MIT license notice.
   - **Positioning (PRFAQ 2026-07-10):** coverage selection is table-stakes (competitors `testpick`/`vitest-agent`/`vitest-affected`/native `--stale`); the differentiator is the daemon + project-local version isolation + transparent state. Ship the wedge fast. See `prfaq-test-server-mcp.md`.
2. **Vitest version coupling** — the `vitest/node` advanced API differs 3.x↔4.x; Story 2.1 must pin and resolve from the project (target repo 4.1.9).
3. **UX for Epic 5** — add a light UX spec before Phase 2 UI stories.

### Recommended Next Steps

1. Begin implementation at **Epic 1, Story 1.1** (daemon lifecycle & singleton).
2. Front-load **Epic 3 Story 3.2/3.3** validation against the spike once Epic 2 execution works, to de-risk the differentiator early.

### Final Note

Assessment run against the regenerated, mutually-consistent PRD / SPEC / Architecture Spine / Epics set. 17/17 FRs covered, 5 epics quality-checked, 0 critical issues. Cleared to proceed to implementation.

---

**Assessment Date:** 2026-07-10
**Assessor:** BMad Implementation Readiness Workflow
