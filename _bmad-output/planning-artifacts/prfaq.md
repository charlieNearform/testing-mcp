# PRFAQ: Intelligent Test Runner MCP Server

> **Status: RESOLVED — historical pressure-test (2026-07-09).** This document was an early
> Working-Backwards challenge that surfaced real problems in the *original* concept. Its
> recommendation (Option A — build for AI agents) was adopted and its challenges are now
> resolved in `docs/prd.md`, `docs/architecture.md`, and the derived `SPEC.md` /
> `ARCHITECTURE-SPINE.md`. Kept as a record of *why* the design is shaped the way it is.
> The original critique is preserved unedited below.
>
> **How each challenge was resolved:**
> - **Q1/Q6 dual-user conflict** → PRD now names AI agents the *primary* user and the human
>   web UI an explicit Phase-2 convenience layer (SPEC non-goal), so the two jobs no longer
>   compete for the MVP.
> - **Q2/Q3 "does it beat `git`/`--changed`?"** → the differentiator is the runtime-coverage
>   reverse map with setup-baseline subtraction (Epic 3); `--changed` is used only as a fast
>   pass, unioned with the map. Spike-validated (~6%/~18% selection).
> - **Q4/Q6 "too much infrastructure"** → repositioned as agent test-orchestration
>   infrastructure (daemon + registration), not "a prettier test runner."
> - **Q5/Q8 "zero false negatives" trade-off** → dropped as an absolute; replaced by
>   recall-prioritised selection with conservative full-suite fallback (NFR2, AD-10).
> - **Q7 Vitest-API & multi-runner** → API-only via `vitest/node` with a pinned version;
>   Jest/pytest explicitly deferred (SPEC non-goals; AD-2 leaves an adapter seam).
> - **Q8 UI/latency metrics** → UI-latency metric removed from Phase 1; success metrics
>   now centre on dry-run <5s, incremental speed, and coverage-map build within one run.

## Question 1: Who is the *real* user?

**PRD says**: Developers writing JavaScript/TypeScript tests

**Hard follow-up**: Is this actually true? Let's pressure-test:

- Would a developer *choose* this over running `npx vitest` directly?
- Why wouldn't they just use their IDE's test runner (VS Code Jest/Test Explorer)?
- Is the "AI integration gap" mentioned really a problem developers experience, or is it an assumption?

**Reality check**: The PRD conflates two different users:
1. **Human developers** - who want faster feedback, cleaner output
2. **LLM agents** - who need programmatic test triggers and structured results

These have fundamentally different needs. A human wants a nice UI; an agent wants JSON payloads. Which job are we solving?

---

## Question 2: What's the *job* they're hiring this tool to do?

**PRD says**: "Intelligent test running capabilities"

**Hard follow-up**: Let's unpack the actual job statement:

> "When tests fail, developers hire a test runner to [do X] so they can [achieve Y]."

What's the actual job? Consider:

| Scenario | Job Statement |
|----------|---------------|
| Developer makes a change | "Run only tests affected by this change" → To minimize wait time |
| CI pipeline runs tests | "Report test results programmatically" → To enable automation |
| Debugging a flaky test | "Get detailed failure info on demand" → To diagnose issues |

Are these the same job? Or are they different jobs requiring different solutions?

**Critical insight**: The "incremental testing" job (only run affected tests) has a competitor: **git-based test selection** (`git diff main --name-only` then figure out affected tests). Does this tool solve a job git can't handle?

---

## Question 3: What alternatives do they currently use?

**PRD mentions**: native vitest CLI, jest, other test runners

**Missing alternatives**:
- **VS Code Test Explorer** - already integrates vitest/jest, shows pass/fail inline
- **GitHub Actions / CI pipelines** - already run tests on every commit
- **husky/pre-commit hooks** - run tests before commits
- **custom npm scripts** - `npm run test:watch`, `npm run test:ci`

**Key question**: What does the PRD offer that these don't?

| Feature | VS Code Test Explorer | GitHub Actions | This PRD |
|---------|------------------------|----------------|----------|
| Pass/fail visualization | ✅ Native | ❌ Only in logs | ✅ Web UI |
| Incremental testing | ⚠️ Limited | ❌ Full run only | ✅ Coverage-based |
| Programmatic access | ❌ None | ✅ Via artifacts | ✅ MCP Tools |
| AI agent integration | ❌ None | ❌ Indirect | ✅ Built-in |

Is the combination unique enough to justify building new?

---

## Question 4: What's the "hire" moment?

**PRD implies**: When test suites get too slow

**But why would they hire THIS?**

Let's think about the decision tree:

```
Developer has slow tests
├─ Option A: Wait longer (status quo)
├─ Option B: Split tests into smaller suites
├─ Option C: Use Vitest's built-in --changed flag
├─ Option D: Build an MCP server (our product)
└─ Option E: Switch to a different framework

Which option is cheaper than building an MCP server?
```

**Hard truth**: Building a full MCP server costs months of engineering time. The "slow tests" problem has much cheaper solutions (test splitting, better isolation, faster hardware).

**When would someone actually hire this?**
- Only when they ALSO need AI agent integration AND human monitoring AND coverage-based smart runs
- But the PRD doesn't position it as an "AI testing infrastructure" - it positions it as a "better test runner"

This feels like trying to build a Swiss Army knife when people just need a screwdriver.

---

## Question 5: What's the "fire" moment?

**PRD doesn't address**: When would someone STOP using this?

Realistic scenarios where someone fires this tool:

1. **It breaks** - If the MCP server becomes a bottleneck itself
2. **CI/CD conflict** - Local incremental runs give different results than CI full runs
3. **Complexity tax** - Teams prefer simplicity over "smart" features that sometimes fail
4. **Maintenance burden** - Keeping the MCP server updated alongside test framework updates
5. **Better alternative emerges** - Vitest adds native AI integration, or GitHub Copilot builds something

**Missing from PRD**: How do we prevent the "false negative" success metric from becoming a "fired" reason?

> "Zero false negatives (missed failures)" - This is the hardest constraint. If the coverage tracking misses a failure because of a bug in our dependency analysis, that's worse than running all tests.

---

## Question 6: Misalignment between solution and job

**PRD assumes**: The job is "run tests faster"

**But the solution builds**: An MCP server with HTTP endpoint, WebSocket streaming, coverage tracking

That's a lot of infrastructure for "run tests faster."

**Alternative interpretation**: The job is "enable AI agents to orchestrate testing"

If that's the real job, then:
- The HTTP UI becomes secondary (or unnecessary)
- The focus should be on reliable tool calls, not pretty dashboards
- "Incremental testing" matters less than "reliable test orchestration"

**Which job is it?**

The PRD tries to serve both human developers and AI agents, but:
- Humans want simplicity (just run my tests)
- Agents want reliability (tell me exactly what happened)

These goals conflict when you optimize for one vs the other.

---

## Question 7: Technical constraints reveal hidden assumptions

**Constraint**: "Use Vitest API (not CLI)"

**Question**: Why? 

- CLI is easier to debug
- API requires maintaining compatibility across Vitest versions
- Some Vitest features may only be accessible via CLI

**Constraint**: "Support multiple test runners (Jest, pytest)"

**Question**: Why?

- Jest is declining in popularity (Vitest is the new standard)
- Python tests (pytest) have completely different ecosystems
- Multi-runner support doubles complexity

Are these constraints serving the job, or just technical curiosity?

---

## Question 8: Success metrics pressure test

| Metric | Target | Reality check |
|--------|--------|---------------|
| Test suite runs <5 min | Fast machines only | "Slow machines" defined as...? |
| Incremental <30 sec | Single file change | Only if coverage tracking works perfectly |
| 95%+ coverage accuracy | High bar | What happens when coverage is wrong? |
| UI latency <1s | Web UI | Is the web UI necessary? |
| Zero false negatives | Absolute | Tradeoff against speed? |

**Critical issue**: "Zero false negatives" means we must run ALL tests whenever there's ANY uncertainty. But then where's the speed benefit?

**Tradeoff not addressed**: Speed vs. correctness. If we're wrong about which tests to run, we either:
- Run too few tests (false negatives) - missed bugs
- Run all tests (no speed benefit) - defeated the purpose

There's no way to have both unless the coverage tracking is perfect (which it never is).

---

## Recommendation: Refine the PRD Before Architecture

**The PRD needs fundamental refinement**. It's trying to solve two different jobs with one solution:

### Option A: Build for AI Agents (Recommended)
**Job**: Enable LLM agents to programmatically trigger and monitor tests

**Prune**:
- Remove the HTTP web UI (agents don't need browsers)
- Simplify coverage tracking (agents just need "pass/fail" answer)
- Focus on reliable tool calls, notpretty output

**Keep**:
- MCP server architecture
- Programmatic test triggering
- Structured JSON results

### Option B: Build for Human Developers
**Job**: Make local test runs faster and more pleasant

**Prune**:
- Remove MCP server (not needed for humans)
- Focus on CLI improvements or VS Code extension
- Drop multi-runner support (start with just Vitest)

**Keep**:
- Incremental testing
- Fast feedback loops
- Clean failure reporting

### Option C: Pivot to "Testing Infrastructure for AI"
**New job**: Create a platform where AI agents can orchestrate complex testing workflows

**This is the most ambitious but potentially最有价值**:
- Not just "run tests" but "orchestrate test strategies"
- AI decides when to run what, how to parallelize, when to retry
- The MCP server becomes the test orchestration layer

**Requires**:
- Clear distinction from existing tools
- Strong AI integration story (not just "can trigger tests")
- Different success metrics (reliability > speed)

---

## Next Steps

1. **Decide the primary user**: Human developers OR AI agents
2. **Define the single job being solved**: Don't try to serve both
3. **Pressure-test the success metrics**: Are they achievable given tradeoffs?
4. **Consider building a spike**: Prove the core value before building full server

**My recommendation**: Start with Option A (AI Agent focus), because:
- The MCP ecosystem is growing
- Existing tools don't solve programmatic test orchestration well
- The PRD already has the MCP foundation built

But the PRD must be rewritten to reflect this focus clearly.
