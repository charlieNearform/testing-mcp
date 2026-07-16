---
stepsCompleted: ['step-01-document-discovery', 'step-02-prd-analysis', 'step-03-epic-coverage-validation', 'step-04-ux-alignment', 'step-05-epic-quality-review', 'step-06-final-assessment']
documentsIncluded:
  prd: 'docs/prd.md (Runner Plugin API subsection + reconciled Phasing); companion SPEC.md kernel at prd/prd-test-server-mcp-2026-07-10/SPEC.md (C10-C13 added this run)'
  architecture: 'architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md (epic-altitude, inherits architecture-test-server-mcp-2026-07-10)'
  epics: 'epics.md (Epic 7 section, Stories 7.1-7.6)'
  ux: null
scope: 'Epic 7 (Runner Plugin API) only - Epics 1-6 already assessed READY in prior reports (2026-07-10, 2026-07-13) and are not re-litigated here'
---

# Implementation Readiness Assessment Report — Epic 7 (Runner Plugin API)

**Date:** 2026-07-16
**Project:** test-server-mcp

## Step 1: Document Inventory

### PRD
- `docs/prd.md` — canonical, updated 2026-07-16 with the "Runner Plugin API (Epic 7)" subsection and reconciled Phasing.
- `prd/prd-test-server-mcp-2026-07-10/SPEC.md` — the distilled requirements-contract companion prior reports treat as the PRD-analysis source.

**Issue found and resolved during this check:** SPEC.md was stale relative to `docs/prd.md` — it still listed "Jest / pytest support (future)" as a non-goal and had no capability entries for Epic 7. This is exactly the kind of drift this step exists to catch. Fixed in place (not just flagged): added C10-C13, generalized the project-local-execution constraint to runner-agnostic wording, split the Jest/pytest non-goal, added the epic-7 spine as a companion, bumped `updated`, logged to its own `.memlog.md`. No further duplicate-format conflicts found.

### Architecture
- `architecture/architecture-test-server-mcp-2026-07-10/ARCHITECTURE-SPINE.md` — parent (feature altitude), AD-7 amended in place 2026-07-16 (generalized to runner-agnostic) as part of this epic's own work.
- `architecture/architecture-epic-7-runner-plugin-api-2026-07-16/ARCHITECTURE-SPINE.md` — child (epic altitude), AD-12–AD-16, already passed its own reviewer gate (lint + rubric + tech-currency + adversarial subagents) before this check began.

### Epics & Stories
- `epics.md` — whole document. Epic 7 appended (FR18-21, NFR9-10, Epic List entry, Stories 7.1-7.6) alongside the pre-existing Epics 1-6.

### UX Design
- None — correctly absent. Epic 7 has no UI surface (it's a daemon/CLI/registry-internal change); consistent with the rest of the product's "no UX contract, agent-facing" positioning.

## PRD Analysis (Epic 7 delta only)

New capabilities (SPEC.md, added this run):
- C10 Runner plugin interface
- C11 Multi-suite registration
- C12 Per-suite scoping + graded coverage confidence
- C13 Jest plugin (seam validation)

New FRs (`epics.md`): FR18 (RunnerPlugin interface + Vitest extraction), FR19 (multi-suite registry), FR20 (per-suite scoping), FR21 (Jest plugin). New NFRs: NFR9 (runner isolation, generalizes NFR4), NFR10 (no-coverage is a defined state, not an error).

Each new capability/FR maps 1:1 to the architecture spine's AD-12 through AD-16 — no orphaned requirement, no AD without a requirement driving it.

## Epic Coverage Validation

### AD → Story traceability (the specific check requested for this run)

| AD | Story/ies citing it | Gap? |
| --- | --- | --- |
| AD-12 (RunnerPlugin Interface) | 7.1 | None |
| AD-13 (Zero-Behavior-Change Vitest Extraction) | 7.1 | None |
| AD-14 (Multi-Suite Registry Model) | 7.2 | None |
| AD-15 (Per-Suite Selection/Coverage/Confidence + orchestrator/MCP scoping) | 7.3 (selection/coverage/confidence portion), 7.4 (orchestrator/MCP portion) | None — correctly split across two stories rather than one oversized story, both cite AD-15 explicitly |
| AD-16 (Jest Seam-Validation Plugin, incl. its Open Question) | 7.6 (implementation), 7.5 (the open question specifically) | None |

Every AD maps to at least one story; every story cites the AD(s) it implements. No story invents scope an AD doesn't authorize (checked against the spine's own Deferred list — pytest/go test/Docker-plugin/universal-coverage-merge/function-level-selection appear in neither the ADs nor any Epic 7 story).

### Dependency ordering consistency

`epics.md`'s story notes (`> Architecture: ... Depends on ...`) state: 7.1 ships alone first → 7.2 depends on 7.1 → 7.3 and 7.4 both depend on 7.2 → 7.5 has no dependency (can run any time) → 7.6 depends on 7.1, 7.2, and 7.5.

This matches the architecture spine's own dependency structure exactly: AD-12/AD-13 are one shippable unit (an interface with a zero-implementations state isn't independently verifiable); AD-14 needs `RunnerPlugin.detect()`/`name` (AD-12) to exist; AD-15 needs suites (AD-14) to scope by; AD-16 needs the interface (AD-12), the registry model (AD-14), and its own open question (spiked in 7.5) resolved before `run()` is written. No divergence between the two documents found.

### Jest open-question representation

The architecture spine's AD-16 open question (plain `jest`'s `run()` calls `process.exit()`; `runCLI`/`@jest/core` resolvability via `projectRequire` is unconfirmed) is represented as its own gating story (7.5), not silently assumed away in 7.6. Story 7.6's first acceptance criterion is explicitly conditioned on "Story 7.5's confirmed embedding approach" rather than asserting the mechanism works. This is the correct pattern — matches how this project has handled every other genuine unknown (e.g. Story 6.9's CRG spike, Story 6.10's original dependency-authorization escalation).

## UX Alignment

N/A — no UX surface for this epic, correctly unrepresented rather than silently skipped.

## Epic Quality Review

- **Sizing:** six stories, each single-concern and independently completable within its stated dependency; no story bundles unrelated concerns (AD-15's two consumers were deliberately split into 7.3/7.4 rather than one large story — consistent with the granularity Epic 6 already established, e.g. 6.4-6.8).
- **Backward-only dependencies:** confirmed — no story depends on a later-numbered one.
- **Acceptance criteria:** consistent Given/When/Then BDD, each testable against a concrete artifact (interface shape, registry field, confidence level, CLI flag) rather than a vague outcome.
- **Traceability:** every story cites its governing AD(s); FR Coverage Map extended consistently with the existing epic-level (not story-level) granularity used by Epics 1-6.
- **Spike handling:** Story 7.5 follows the established spike pattern (investigate, report a confirmed approach or escalate — no speculative product code ahead of the answer).

### Findings by severity

🔴 Critical: None.

🟠 Major: None.

🟡 Minor (resolved during this run, not deferred):
- SPEC.md drift (Jest/pytest non-goal, missing C10-C13) — **RESOLVED** in place, see Document Inventory above.

## Summary and Recommendations

### Overall Readiness Status

**READY** for Epic 7 implementation.

Requirements coverage is complete (4/4 new FRs, 2/2 new NFRs, 4/4 new SPEC capabilities, all mapped to AD-12–AD-16), the epic-altitude architecture spine already passed its own reviewer gate before this check, story-to-AD traceability has no gaps, dependency ordering is consistent between `epics.md` and the architecture spine, and the one genuine open engineering question (Jest's embeddable run API) is correctly represented as its own gating spike story rather than an unstated assumption.

### Recommended Next Steps

1. Sprint-plan Epic 7 in dependency order: 7.1 → 7.2 → {7.3, 7.4} → 7.5 (any time, but before 7.6) → 7.6.
2. Story 7.5 (the Jest spike) should run before or in parallel with 7.3/7.4, since it gates 7.6 and has no dependency of its own — no reason to leave it for last.
3. If Story 7.5 escalates (per its own AC), 7.6 pauses; 7.1-7.4 remain independently shippable and deliver real value (Vitest extraction + multi-suite registration + per-suite scoping) even if the Jest plugin is delayed.

**Assessed by:** BMad Implementation Readiness (Product Manager persona) — 2026-07-16
