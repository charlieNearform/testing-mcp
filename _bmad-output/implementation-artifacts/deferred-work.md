# Deferred Work Ledger

## Deferred from: code review of story-1-4-registry-persistence-rehydration (2026-07-14)

- `load()` uses synchronous `readFileSync` inside async method — pre-existing pattern also used by `save()`.
- Filesystem read errors treated same as missing file — pre-existing silent catch predates this story.
- Rehydrated `status` values not normalized on restart — worker lifecycle is a later epic.
- `save()` uses direct write without atomic rename — pre-existing; unchanged by this story.
- Map key vs entry `projectId` mismatch not detected — pre-existing spread pattern from Story 1.3.
- `NaN` schemaVersion accepted without rejection — extreme JSON edge case; spec uses simple typeof check.
