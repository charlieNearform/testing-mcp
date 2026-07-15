import { afterEach, describe, it, expect } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  SNAPSHOT_SCHEMA_VERSION,
  changedSinceSnapshot,
  computeHashes,
  loadSnapshot,
  saveSnapshot,
  selectionDelta,
  snapshotPath,
  writeCurrentSnapshot,
  type SnapshotFile,
} from "../src/snapshot/index.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

let dir: string;

/** A git repo with a couple of tracked sources + a committed `.gitignore` for `.test-mcp/`. */
function makeRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "test-mcp-snap-"));
  fs.writeFileSync(path.join(d, ".gitignore"), ".test-mcp/\n");
  fs.writeFileSync(path.join(d, "a.ts"), `export const a = 1;\n`);
  fs.writeFileSync(path.join(d, "b.ts"), `export const b = 2;\n`);
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "-A"], { cwd: d });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: d, env: GIT_ENV });
  return d;
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe("snapshot: computeHashes", () => {
  it("is stable for unchanged content and changes when content changes", () => {
    dir = makeRepo();
    const first = computeHashes(dir, ["a.ts", "b.ts"]);
    const second = computeHashes(dir, ["a.ts", "b.ts"]);
    expect(second).toEqual(first);
    expect(first["a.ts"]).toMatch(/^[0-9a-f]{64}$/);

    fs.appendFileSync(path.join(dir, "a.ts"), `// touched\n`);
    const third = computeHashes(dir, ["a.ts", "b.ts"]);
    expect(third["a.ts"]).not.toBe(first["a.ts"]);
    expect(third["b.ts"]).toBe(first["b.ts"]);
  });

  it("skips unreadable/absent files (treated as absent)", () => {
    dir = makeRepo();
    const hashes = computeHashes(dir, ["a.ts", "does-not-exist.ts"]);
    expect(hashes["a.ts"]).toBeDefined();
    expect(hashes["does-not-exist.ts"]).toBeUndefined();
  });
});

describe("snapshot: save/load round-trip", () => {
  it("round-trips a snapshot and rejects a wrong schemaVersion (treated as absent)", () => {
    dir = makeRepo();
    const snap: SnapshotFile = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      takenAt: new Date().toISOString(),
      files: { "a.ts": "deadbeef" },
    };
    saveSnapshot(dir, snap);
    expect(loadSnapshot(dir)).toEqual(snap);

    // Hand-write a future/incompatible schema -> loadSnapshot must treat it as absent.
    fs.writeFileSync(
      snapshotPath(dir),
      JSON.stringify({ ...snap, schemaVersion: SNAPSHOT_SCHEMA_VERSION + 999 }),
    );
    expect(loadSnapshot(dir)).toBeNull();
  });

  it("returns null when no snapshot exists", () => {
    dir = makeRepo();
    expect(loadSnapshot(dir)).toBeNull();
  });
});

describe("snapshot: changedSinceSnapshot", () => {
  it("returns null (fall back) when there is no snapshot", () => {
    dir = makeRepo();
    expect(changedSinceSnapshot(dir)).toBeNull();
  });

  it("detects modify, add, and delete against the snapshot", () => {
    dir = makeRepo();
    writeCurrentSnapshot(dir);

    fs.appendFileSync(path.join(dir, "a.ts"), `// touched\n`); // modify
    fs.writeFileSync(path.join(dir, "c.ts"), `export const c = 3;\n`); // add (untracked)
    fs.rmSync(path.join(dir, "b.ts")); // delete

    const changed = changedSinceSnapshot(dir);
    expect(changed).not.toBeNull();
    expect(changed!.files.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
    // Only the newly-present file is "added"; the deletion lives in `files` only.
    expect(changed!.added).toEqual(["c.ts"]);
  });

  it("detects a change to a non-ASCII / spaced filename (git -z parsing)", () => {
    dir = makeRepo();
    const oddName = "src/café dôme.ts";
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, oddName), `export const x = 1;\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "odd name"], { cwd: dir, env: GIT_ENV });

    writeCurrentSnapshot(dir);
    fs.appendFileSync(path.join(dir, oddName), `// touched\n`);

    const changed = changedSinceSnapshot(dir);
    // Before the -z fix, git octal-quoted the path and the newline split dropped it -> invisible.
    expect(changed!.files).toContain(oddName);
  });

  it("sees no diff when a change is reverted before diffing", () => {
    dir = makeRepo();
    const original = fs.readFileSync(path.join(dir, "a.ts"));
    writeCurrentSnapshot(dir);

    fs.appendFileSync(path.join(dir, "a.ts"), `// touched\n`);
    fs.writeFileSync(path.join(dir, "a.ts"), original); // revert to snapshot content

    const changed = changedSinceSnapshot(dir);
    expect(changed).toEqual({ files: [], added: [] });
  });

  it("returns null when the persisted snapshot has a wrong schemaVersion", () => {
    dir = makeRepo();
    writeCurrentSnapshot(dir);
    const snap = JSON.parse(fs.readFileSync(snapshotPath(dir), "utf8")) as SnapshotFile;
    fs.writeFileSync(snapshotPath(dir), JSON.stringify({ ...snap, schemaVersion: 999 }));
    expect(changedSinceSnapshot(dir)).toBeNull();
  });
});

describe("snapshot: selectionDelta captures selection-time state", () => {
  it("returns the diff plus a pending payload of the CURRENT tree", () => {
    dir = makeRepo();
    writeCurrentSnapshot(dir);
    fs.appendFileSync(path.join(dir, "a.ts"), `// touched\n`);

    const sel = selectionDelta(dir);
    expect(sel.changed!.files).toContain("a.ts");
    expect(sel.pending).not.toBeNull();
    // The pending payload hashes the tree as of NOW (selection time), including the edit.
    expect(sel.pending!.files["a.ts"]).toBe(computeHashes(dir, ["a.ts"])["a.ts"]);
  });

  it("populates pending even on the first run (no snapshot -> changed null)", () => {
    dir = makeRepo();
    const sel = selectionDelta(dir);
    expect(sel.changed).toBeNull();
    expect(sel.pending).not.toBeNull();
    // Persisting it makes the very next delta a clean no-op.
    saveSnapshot(dir, sel.pending!);
    expect(changedSinceSnapshot(dir)).toEqual({ files: [], added: [] });
  });

  it("persisting the selection-time payload keeps a mid-run edit visible next delta (invariant 5)", () => {
    dir = makeRepo();
    writeCurrentSnapshot(dir);

    // Selection time: an edit to a.ts is captured in the pending payload.
    fs.appendFileSync(path.join(dir, "a.ts"), `// v1\n`);
    const sel = selectionDelta(dir);

    // A FURTHER edit lands after selection but before the run advances the snapshot.
    fs.appendFileSync(path.join(dir, "a.ts"), `// v2 mid-run\n`);

    // The run succeeds and advances using the captured selection-time payload — NOT a re-hash.
    saveSnapshot(dir, sel.pending!);

    // Because we baselined the selection-time (v1) hash, the unvalidated v2 edit is still
    // in the next delta. A post-run re-hash would have baselined v2 and hidden it.
    expect(changedSinceSnapshot(dir)!.files).toContain("a.ts");
  });
});

describe("snapshot: loadSnapshot boundary validation", () => {
  it("rejects a files map with a non-string hash value (treated as absent)", () => {
    dir = makeRepo();
    fs.mkdirSync(path.dirname(snapshotPath(dir)), { recursive: true });
    fs.writeFileSync(
      snapshotPath(dir),
      JSON.stringify({
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        takenAt: new Date().toISOString(),
        files: { "a.ts": 123 },
      }),
    );
    expect(loadSnapshot(dir)).toBeNull();
  });
});
