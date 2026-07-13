---
stepsCompleted: ['step-01-document-discovery', 'step-02-prd-analysis', 'step-03-epic-coverage-validation', 'step-04-ux-alignment', 'step-05-epic-quality-review', 'step-06-final-assessment']
documentsIncluded:
  prd: 'prd/prd-test-server-mcp-2026-07-10/SPEC.md'
  architecture: 'architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md'
  epics: 'epics.md'
  ux: null
---

# Implementation Readiness Assessment Report

**Date:** 2026-07-13
**Project:** test-server-mcp

## Step 1: Document Inventory

### PRD
- `prd/prd-test-server-mcp-2026-07-10/SPEC.md` (sharded-style folder; canonical PRD kernel)

### Architecture
- `architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md`

### Epics & Stories
- `epics.md` (whole document, 24.8 KB, modified 2026-07-13)
- `epics/` folder present but empty

### UX Design
- None found (WARNING)

### Supporting Artifacts (not primary readiness inputs)
- `briefs/brief-mcp-test-runner-2026-07-09/brief.md`
- `prfaq.md`, `prfaq-test-server-mcp.md`, `prfaq-test-server-mcp-distillate.md`
- `brainstorm-mcp-features-2026-07-09/` (intent + html)

### Issues
- WARNING: No UX design document found.
- NOTE: A prior report `implementation-readiness-report-2026-07-13.md` from today was overwritten by this run.
- No whole-vs-sharded duplicate conflicts for PRD, Architecture, or Epics.

## PRD Analysis

The PRD is a SPEC-kernel contract (capabilities + constraints), not numbered FR/NFR. Mapped below.

### Functional Requirements (from Capabilities)

- FR1 (C1) Dry run (plan/commit): `dryRun` returns a `TestPlan` (`planId`, files, reasoning, `expiresAt`); `run_tests({planId})` executes exactly that plan; expired plans force re-plan.
- FR2 (C2) Run tests programmatically: `run_tests({projectId,…})` returns structured pass/fail/duration/failures.
- FR3 (C3) Intelligent incremental runs: on a source change, selected set is materially smaller than the full suite while missing no real failure.
- FR4 (C4) Progress + status: `get_test_status` → idle/running/complete/error; `notifications/progress` emitted during a run (real-time push deferred to Phase 2).
- FR5 (C5) Minimal failure-focused output: summary carries counts + failures only; full stack/assertion via `get_failure_details`.
- FR6 (C6) Status monitoring: run state queryable per project at any time.
- FR7 (C7) Runtime project registration: `register_project`/`list_projects`/`unregister_project`; `test-mcp register` auto-boots the singleton and registers a config-valid project.
- FR8 (C8) Project-local execution: tests run in a per-project worker subprocess (cwd = project root) resolving `vitest/node` from the project; differing Vitest versions don't clash.
- FR9 (C9) Coverage reverse-map: source→test-file map built single-pass from runtime V8 coverage (attribution vendored from `testpick`, MIT), setup-baseline subtracted, unmeasurable tests always-run.

Total FRs: 9

### Non-Functional Requirements (from Constraints + Success signals)

- NFR1 Architecture: single daemon per system over Streamable HTTP (stateful sessions, lockfile + known port); optional stdio single-project mode; MCP SDK v1.
- NFR2 Isolation: daemon never imports a project's Vitest; per-project worker resolves `vitest/node` from the project; Vitest pinned (target 4.1.9).
- NFR3 State layout: per-project state in git-ignored `<git-root>/.test-mcp/`; daemon-global registry/lockfile in `~/.test-mcp`; `projectId` = hash of abs path, pinnable.
- NFR4 Coverage engine: single-pass V8 snapshot-diff; subtract setup-file baseline; unmeasurable tests always-run.
- NFR5 Correctness over cleverness: recall prioritised; full-suite fallback whenever selection is uncertain (no missed real failures).
- NFR6 Security: bind `127.0.0.1` only; mandatory Host/Origin validation; per-daemon bearer token (CLI-managed).
- NFR7 Versioned schemas: every persisted JSON carries `schemaVersion`.
- NFR8 Third-party attribution: retain `testpick` MIT license/copyright for vendored module; track upstream.
- NFR9 Performance: dry-run plan latency <5s; incremental single-file runs <15s; reverse-map buildable in one instrumented run.

Total NFRs: 9

### Additional Requirements / Constraints

- Non-goals (out of scope): Jest/pytest, human web UI (Phase 2), priority scoring + health monitoring, fixture/setup-time cost tracking, cross-platform beyond macOS, distributed caching.
- Positioning: feature wedge (coverage selection is table-stakes); differentiator is delivery architecture; attribution vendored not wrapped/rebuilt.

### PRD Completeness Assessment

Clear, well-scoped, and testable — each capability has an explicit success signal and constraints are concrete. Gap: no numbered FR/NFR IDs natively (mapped here), and no UX requirements (web UI explicitly deferred to Phase 2, so acceptable for this phase).

## Epic Coverage Validation

### Source note (important)

The epics document declares its own numbered **FR1–FR17 / NFR1–NFR8**, derived from `docs/prd.md` + `docs/architecture.md` (fuller source docs). The canonical planning-artifact PRD (`SPEC.md`) expresses these as **9 capabilities (C1–C9)**. The epics FR set is a more granular *superset* and is internally consistent with the SPEC. Validation below covers both the epics' FR list and the SPEC capabilities.

### SPEC Capability → Epic Coverage

| SPEC Cap | Intent | Epic FR mapping | Status |
| --- | --- | --- | --- |
| C1 Dry run | plan/commit | FR6 (Epic 4) | ✓ |
| C2 Run tests | programmatic | FR4, FR5 (Epic 2) | ✓ |
| C3 Incremental | affected-only | FR9–FR14 (Epic 3) | ✓ |
| C4 Progress/status | live status | FR7 (Epic 4) | ✓ |
| C5 Minimal output | AI-focused | FR8 (Epic 4) | ✓ |
| C6 Status monitoring | queryable | FR7 (Epic 4) | ✓ |
| C7 Registration | multi-project | FR2, FR3 (Epic 1) | ✓ |
| C8 Project-local exec | own Vitest | FR4, FR15 (Epic 2) | ✓ |
| C9 Coverage reverse-map | source→test | FR10, FR11 (Epic 3) | ✓ |

### Epics FR Coverage Matrix

| FR | Requirement (abbrev) | Epic Coverage | Status |
| --- | --- | --- | --- |
| FR1 | Singleton daemon over Streamable HTTP | Epic 1 (1.1, 1.2) | ✓ |
| FR2 | `test-mcp` CLI + auto-boot | Epic 1 (1.1, 1.3) | ✓ |
| FR3 | Register/list/unregister + repo-local config | Epic 1 (1.3) | ✓ |
| FR4 | run_tests via project-local Vitest worker | Epic 2 (2.1) | ✓ |
| FR5 | Structured results + get_failure_details | Epic 2 (2.2) | ✓ |
| FR6 | Dry-run plan/commit (planId) | Epic 4 (4.1) | ✓ |
| FR7 | get_test_status + progress notifications | Epic 4 (4.2) | ✓ |
| FR8 | Minimal failure-focused output | Epic 4 (4.3) | ✓ |
| FR9 | Git-delta selection via `--changed` | Epic 3 (3.1) | ✓ |
| FR10 | Coverage reverse-map build/persist | Epic 3 (3.2) | ✓ |
| FR11 | Setup-baseline subtraction | Epic 3 (3.3) | ✓ |
| FR12 | Always-run unmeasurable tests | Epic 3 (3.4) | ✓ |
| FR13 | Union selection + full-suite fallback | Epic 3 (3.5) | ✓ |
| FR14 | Watch/incremental mode | Epic 3 (3.6) | ✓ |
| FR15 | Vitest built-in isolation + metadata | Epic 2 (2.3) | ✓ |
| FR16 | Per-project history + rehydrate on start | Epic 1 (1.4) | ✓ |
| FR17 | Human web UI (Phase 2) | Epic 5 (5.1, 5.2) | ✓ (Phase 2) |

### NFR Coverage

| NFR | Epic | Status |
| --- | --- | --- |
| NFR1 Performance latency | Epic 4 | ✓ |
| NFR2 Recall/full-suite fallback | Epic 3 | ✓ |
| NFR3 Security (loopback/token/Host-Origin) | Epic 1 (1.2) | ✓ |
| NFR4 Execution isolation | Epic 2 | ✓ |
| NFR5 State transparency + schemaVersion | Epic 1 (1.4) | ✓ |
| NFR6 macOS first | Epic 1 | ✓ |
| NFR7 Minimal overhead | Epic 2 | ✓ |
| NFR8 Single-pass map build | Epic 3 | ✓ |

### Missing Requirements

None. Every SPEC capability and every epics FR/NFR has a traceable epic/story.

### Coverage Statistics

- Total epics FRs: 17 → covered: 17 (100%); Phase-1 FRs (FR1–FR16): 16/16.
- Total epics NFRs: 8 → covered: 8 (100%).
- SPEC capabilities C1–C9: 9/9 mapped.
- Minor flag: epics trace to `docs/prd.md`/`docs/architecture.md`, which are NOT in `planning-artifacts` (only the SPEC/spine distillates are). Recommend confirming those source docs still align with the SPEC, or updating the epics' `inputDocuments` to cite the canonical distillates.

## UX Alignment Assessment

### UX Document Status

Not Found — and intentionally so.

### Alignment Issues

None. The PRD (`SPEC.md` Intent + Non-goals) states the primary consumer is AI agents and explicitly defers the human web UI to Phase 2. The epics doc corroborates: "No UX design contract exists" and UX requirements are "None". FR17/Epic 5 (the only UI-bearing work) is scoped to Phase 2 with its own real-time-push acceptance criteria.

### Warnings

- ⚠️ Low severity: When Phase 2 (Epic 5, human UI) begins, a UX design contract will be required — the current epics for 5.1/5.2 specify behaviour (live status, reconnect resilience) but no visual/interaction design. Not a Phase-1 blocker.

## Epic Quality Review

### Epic-level assessment

| Epic | User (agent) value | Independence | Verdict |
| --- | --- | --- | --- |
| 1 Core Daemon & Registration | Agent can address all test activity via MCP; register/list/unregister projects | Stands alone | ✓ (title leans technical, goal is value-framed) |
| 2 Test Execution | Agent runs a project's tests and gets trustworthy structured results | Needs only Epic 1 (backward) | ✓ |
| 3 Intelligent Test Selection | Affected-only runs without missed failures (the differentiator) | Needs Epics 1–2 (backward) | ✓ |
| 4 Agent Workflow (dry-run/status/output) | Plan-before-commit, poll status, minimal output | Needs Epics 1–2 (backward) | ✓ |
| 5 Human Monitoring UI (Phase 2) | Human visibility over the daemon | Needs Epics 1–4 (backward) | ✓ (deferred) |

No forward dependencies between epics; all dependencies point backward. No circular dependencies.

### Story-level checks

- Sizing: stories are single-capability and independently completable. Explicit prerequisite chain in Epic 1 (1.0 → 1.4) with a hard gate on 1.0. No forward story references detected.
- Greenfield handling: correct — Story 1.0 "Greenfield Project Scaffold" stands up the project from `docs/scaffold-spec.md` before behaviour stories, matching the "no starter template" note. ✅
- Acceptance criteria: consistent Given/When/Then BDD, testable, and notably strong on error/edge paths (stale lockfile reclaim, `PlanExpired`, worker crash isolation, invalid vitest config, schemaVersion migration, isolation-disabled metadata). ✅
- Traceability: every story maps to an FR; FR→Epic map maintained in the doc. ✅

### Findings by severity

🔴 Critical Violations: None.

🟠 Major Issues: None.

🟡 Minor Concerns (all resolved or consciously accepted — see Resolution Log):
- ~~Performance NFRs not encoded as testable ACs (NFR1 latency).~~ RESOLVED — added ACs to Story 4.1 (dry-run <5s) and Story 3.6 (incremental <15s aspirational).
- ~~NFR7 ("minimal overhead") has no verification AC.~~ RESOLVED — added AC to Story 2.1 (overhead surfaced in run metadata; monitored, not gated).
- Epic 1 title reads slightly technical — ACCEPTED as-is; the epic goal statement carries the agent value.
- Epic 1 bundles daemon + MCP + registration + persistence (largest epic) — ACCEPTED; tight coupling justifies keeping together. Split candidate if scope grows.
- Epic 5 (Phase 2) lacks a UX contract — DEFERRED to Phase 2 (out of scope for Phase 1 start).

### Resolution Log (2026-07-13, post-assessment)

1. NFR1 dry-run latency → `epics.md` Story 4.1 new AC: plan returned <5s, latency recorded in plan metadata if exceeded.
2. NFR1 interactive latency → `epics.md` Story 3.6 new AC: incremental single-file run <15s aspirational (per PRD Success Metrics), recorded for tuning.
3. NFR7 overhead → `epics.md` Story 2.1 new AC: worker/daemon overhead surfaced in run metadata (monitored, not hard-gated).
4. NFR coverage map in `epics.md` extended with a "Performance NFR acceptance criteria" line pointing to the above stories.
5. Source reconciliation → VERIFIED: `docs/prd.md` and `docs/architecture.md` both exist and align with the `SPEC.md` / `ARCHITECTURE-SPINE.md` distillates; epics' `inputDocuments` already cite all four. No change required.
6. Epic 1 title + size, Epic 5 UX contract → consciously accepted/deferred as noted above.

### Best-practices compliance

- [x] Epics deliver user value
- [x] Epics function independently (backward deps only)
- [x] Stories appropriately sized
- [x] No forward dependencies
- [x] Resources created when needed (greenfield scaffold first; state created on register)
- [x] Clear acceptance criteria (BDD, error paths covered)
- [x] Traceability to FRs maintained

## Summary and Recommendations

### Overall Readiness Status

**READY** (for Phase 1 implementation).

Requirements coverage is complete (17/17 FRs, 8/8 NFRs, 9/9 SPEC capabilities), epics are user-value-oriented with backward-only dependencies, stories are independently completable with strong BDD acceptance criteria (including error paths), and greenfield scaffolding is correctly sequenced first. No critical or major issues.

### Critical Issues Requiring Immediate Action

None. All minor concerns from the initial pass have been resolved or consciously accepted (see Resolution Log under Epic Quality Review).

### Recommended Next Steps

1. Begin implementation with Story 1.0 (greenfield scaffold) per its hard-gate verification checklist; do not start Story 1.1 until it passes.
2. When Phase 2 (Epic 5) approaches, produce a UX design contract for the human monitoring UI before executing 5.1/5.2.

### Final Note

Initial assessment identified 5 minor concerns and 0 critical/major issues. As of 2026-07-13 the two substantive concerns (performance NFR acceptance criteria) are resolved in `epics.md`, source alignment is verified, and the remaining items are consciously accepted/deferred. The plan is READY for Phase 1 implementation.

**Assessed by:** BMad Implementation Readiness (Product Manager persona) — 2026-07-13
