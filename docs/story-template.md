# Story Template

Every story follows this shape. Inconsistent story input is the single largest source of inconsistent output across agent sessions.

---

## Story: {short noun phrase describing the outcome}

**ID:** `{epic}-{number}` (e.g. `setup-001`)
**Slice:** `{feature directory affected}` (e.g. `src/server`)
**Type:** `feature` | `refactor` | `bug` | `infra` | `housekeeping`
**Depends on:** `{list of story IDs that must merge first, or "none"}`

### Source

Link or quote the original functional requirement, design reference, or bug report.

- Requirement: {link/quote}
- Context pack: {link to `_bmad-output/implementation-artifacts/epic-<N>-context.md`, if available}
- Related story: {link, if applicable}

### Acceptance criteria

Each criterion in Given/When/Then form. Each becomes a named test in the implementation.

1. **Given** {initial state}
   **When** {action}
   **Then** {observable outcome}

2. **Given** {...}
   **When** {...}
   **Then** {...}

(Aim for 2–6 criteria.)

### Out of scope

What the story explicitly does *not* cover.

- {thing the agent might be tempted to also do, but shouldn't}
- {related feature that's a separate story}

### Notes for the agent

Optional. Use only when there's context that can't be inferred from documents.

- Patterns from `docs/patterns.md` that apply: {list}
- Existing similar implementations to mirror: {file paths}
- Known gotchas: {anything counter-intuitive about this work}

### Escalation triggers

Things the agent should escalate before starting:

- {decision that needs human input}
- {missing context — e.g. "this requires an API endpoint not yet defined"}

---

## Sizing check

Before submitting, the story author confirms:

- [ ] Acceptance criteria are testable as written
- [ ] Out-of-scope is explicit
- [ ] All dependencies are listed
- [ ] The story fits a single agent session (rough heuristic: under ~20 files touched, under ~500 lines net change)
- [ ] Context is scoped: source docs and context packs are cited, not copied wholesale

## What a good story looks like

A story is well-shaped when:

- A reviewer can predict roughly what the diff will contain just from reading the story
- The acceptance criteria map 1:1 to named tests in the resulting PR
- The "out of scope" section answered at least one question the reviewer would have asked
- The agent didn't need to invent any patterns or escalate any decisions to complete it

## Example

### Story: Create basic MCP server skeleton

**ID:** `setup-001`
**Slice:** `src/server`
**Type:** `infra`
**Depends on:** none

### Source

> Build an MCP server that exposes test-running capabilities via standardized tools.

### Acceptance criteria

1. **Given** the server starts
   **When** a client connects
   **Then** the server advertises tools: `run_tests`, `get_test_status`, `get_failure_details`

2. **Given** the server receives a tool call
   **When** the tool is valid
   **Then** the server executes and returns results

3. **Given** the server receives an invalid tool call
   **When** validation fails
   **Then** the server returns an error response

### Out of scope

- Test runner integration (Vitest/Jest) — separate stories
- Coverage intelligence — separate story
- Human UI — separate story

### Notes for the agent

- Follow MCP SDK patterns from @modelcontextprotocol/sdk
- Use stdio transport for communication
- Keep tools minimal initially

### Escalation triggers

- None expected; pattern is well-established.
