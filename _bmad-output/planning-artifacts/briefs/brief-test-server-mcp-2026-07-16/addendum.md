# Addendum: Runner Plugin API

## Prior art & comparables (research pass, 2026-07-16)

Grounding for the brief's "what makes this different" section — captured here rather than in the brief itself, since downstream (PRD/architecture) will want the detail.

### Plugin/extensibility shapes in existing test runners

Two dominant patterns:

- **Hook-based (N:1 fan-out)** — pytest's `pluggy` defines `hookspec`s (signature contracts, no logic) that any number of registered `hookimpl`s can implement; pytest, tox, and devpi all run on it. Suits cross-cutting concerns (collection, fixtures) more than swapping the whole engine.
  Sources: [pluggy](https://github.com/pytest-dev/pluggy), [pytest hook docs](https://docs.pytest.org/en/stable/how-to/writing_hook_functions.html)
- **Interface/module-swap (1:1 replacement)** — Jest's `testRunner` config point takes a module path exporting a single function `(globalConfig, config, environment, runtime, testPath) => Promise<TestResult>`. This is the closest existing analogue to a `RunnerPlugin`; Jest's own `jest-circus` vs `jest-jasmine2` proves the swap works in production.
  Sources: [Jest config](https://jestjs.io/docs/configuration), [jest-circus](https://www.npmjs.com/package/jest-circus)
- **Reporter-class interface** — Playwright Test and Mocha expose a reporter class (`onBegin`/`onTestEnd`/`onEnd`, promise-returning) that's runner-agnostic by design; third-party reporters already target Playwright, Cypress, Mocha, Jest, and Vitest simultaneously. Cypress reuses Mocha's BDD interface rather than defining a separate model.
  Source: [Playwright Reporter API](https://playwright.dev/docs/api/class-reporter)

**Read for our design:** our `RunnerPlugin` is closer to Jest's `testRunner` swap-point (1:1, "this plugin IS the execution engine for this project") than to pytest's hook fan-out (many plugins cooperating on one run). That's the right shape given the daemon picks exactly one runner per registered project.

### Test-result & coverage interchange formats

- **CTRF** (Common Test Report Format, est. 2023) — JSON schema, 3 required fields (name/duration/status) + optional extensible metadata, explicitly designed as "same JSON no matter the tool." Community reporters already ship for Jest, Go, .NET, Newman. It's the closest-fitting precedent for a plugin *contract* (not just a report artifact) because of its required-core-plus-optional-extensions shape.
  Sources: [ctrf.io](https://ctrf.io/docs/intro), [ctrf-io/ctrf](https://github.com/ctrf-io/ctrf)
- **JUnit XML** — incumbent CI-wide default, structured, widely ingested by dashboards/CI.
- **TAP** — older/looser line-protocol with free-form YAML blocks, ad-hoc parsing; converters exist to JUnit XML.
  Source: [TAP vs subunit](https://kinoshita.eti.br/2011/06/04/a-comparison-of-tap-test-anything-protocol-and-subunit.html)
- **lcov (`.info`)** is genuinely polyglot: originally gcov (C/C++), also produced by grcov (Rust), coverage.py/pytest-cov (Python), simplecov (Ruby), Istanbul/nyc (JS), and via converters like `gcov2lcov` (Go).
  Sources: [lcov](https://github.com/linux-test-project/lcov), [Codecov supported formats](https://docs.codecov.com/docs/supported-report-formats), [gcov2lcov](https://github.com/jandelgado/gcov2lcov)
- **Cobertura XML** is the main competing/complementary standard, often used interchangeably alongside lcov in dashboards (SonarQube, Codecov, Code Climate).
- Notably, even **Bazel's** native `coverage` command — built for polyglot orgs — only cleanly ingests LCOV-emitting runtimes (Java/C++/Go) and struggles with Istanbul's own JSON output. This is independent confirmation that "coverage as optional/graded, not universal" is a real, currently-unsolved seam even in mature tooling, not an invented problem.
  Source: [Bazel coverage](https://bazel.build/configure/coverage)

### Polyglot orchestration precedents

- **Bazel** — heaviest-weight comparable: hermetic, polyglot test rules with native LCOV-based coverage merging, but demands full build-graph adoption (a much bigger commitment than registering a project with a daemon).
- **Nx** — plugin/executor system with affected-detection (git-aware incremental testing — same ambition as this system), but stays JS-monorepo-centric even with its "plugin" extensions to other languages.

### Synthesis: the differentiation gap

**Neither treats coverage as an explicitly optional, graded per-plugin capability.** That framing, plus staying a lightweight non-hermetic MCP daemon rather than a build system, is the genuine gap this brief can honestly claim — not novelty in "pluggable test runners" as a concept, but in combining it with optional/graded coverage and an MCP-native, zero-build-graph-adoption integration model.

Full research agent output retained in session; digest captured here on 2026-07-16.
