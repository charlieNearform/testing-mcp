import { describe, it, expect, vi } from "vitest";
import {
  createSendFailureHandler,
  createTransportErrorHandler,
} from "../src/cli/mcp-bridge-resilience.ts";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const originalMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {},
} as unknown as JSONRPCMessage;

function http404(): Error {
  return new Error("Error POSTing to endpoint (HTTP 404): Session not found");
}

describe("createSendFailureHandler (mcp-bridge 404 recovery)", () => {
  it("recreates the session and retries the failed message once on a 404, when a handshake is cached", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const retrySend = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createSendFailureHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      retrySend,
      log,
    });

    await handle(originalMessage, http404());

    expect(recreateSession).toHaveBeenCalledTimes(1);
    expect(retrySend).toHaveBeenCalledTimes(1);
    expect(retrySend).toHaveBeenCalledWith(originalMessage);
    expect(log).not.toHaveBeenCalled(); // silent success -- no user-visible failure
  });

  it("logs and gives up cleanly (no loop) when the retried send also fails", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const retrySend = vi.fn().mockRejectedValue(http404());
    const log = vi.fn();

    const handle = createSendFailureHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      retrySend,
      log,
    });

    await handle(originalMessage, http404());

    expect(recreateSession).toHaveBeenCalledTimes(1);
    expect(retrySend).toHaveBeenCalledTimes(1); // exactly one retry -- never loops
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("session recreate+retry failed");
  });

  it("falls back to log-only when nothing has been cached yet (no handshake to replay)", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const retrySend = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createSendFailureHandler({
      hasCachedHandshake: () => false,
      recreateSession,
      retrySend,
      log,
    });

    await handle(originalMessage, http404());

    expect(recreateSession).not.toHaveBeenCalled();
    expect(retrySend).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("send to daemon failed");
  });

  it("keeps today's log-only behavior for a non-404 error, even with a cached handshake", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const retrySend = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createSendFailureHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      retrySend,
      log,
    });

    await handle(originalMessage, new Error("socket hang up"));

    expect(recreateSession).not.toHaveBeenCalled();
    expect(retrySend).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("send to daemon failed: socket hang up");
  });

  it("serializes concurrent 404s behind a single in-flight recreation", async () => {
    let resolveRecreate!: () => void;
    const recreateSession = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRecreate = resolve;
        }),
    );
    const retrySend = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createSendFailureHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      retrySend,
      log,
    });

    // Two sends fail around the same time before recreation has resolved.
    const first = handle(originalMessage, http404());
    const second = handle(originalMessage, http404());

    // Give both handlers a chance to reach their synchronous "start recreating if unset" check.
    await Promise.resolve();
    await Promise.resolve();
    expect(recreateSession).toHaveBeenCalledTimes(1); // only one recreation attempt in flight

    resolveRecreate();
    await Promise.all([first, second]);

    expect(recreateSession).toHaveBeenCalledTimes(1); // still just one, after both settled
    expect(retrySend).toHaveBeenCalledTimes(2); // each failed message still gets its own retry
    expect(log).not.toHaveBeenCalled();
  });
});

describe("createTransportErrorHandler (mcp-bridge SSE recovery)", () => {
  it("proactively recreates the session on a terminal SSE disconnect, when a handshake is cached", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createTransportErrorHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      log,
    });

    handle(new Error("SSE stream disconnected: TypeError: terminated"));
    await Promise.resolve();
    await Promise.resolve();

    expect(recreateSession).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1); // just the initial "daemon transport error" log
    expect(log.mock.calls[0][0]).toContain("daemon transport error");
  });

  it("recreates on the SDK's 'Maximum reconnection attempts' give-up message too", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createTransportErrorHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      log,
    });

    handle(new Error("Maximum reconnection attempts (200) exceeded."));
    await Promise.resolve();
    await Promise.resolve();

    expect(recreateSession).toHaveBeenCalledTimes(1);
  });

  it("logs and gives up cleanly (no throw) when the proactive recreate itself fails", async () => {
    const recreateSession = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const log = vi.fn();

    const handle = createTransportErrorHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      log,
    });

    handle(new Error("SSE stream disconnected: TypeError: terminated"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(recreateSession).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1][0]).toContain("session recreate after transport error failed");
  });

  it("falls back to log-only when nothing has been cached yet (no handshake to replay)", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createTransportErrorHandler({
      hasCachedHandshake: () => false,
      recreateSession,
      log,
    });

    handle(new Error("SSE stream disconnected: TypeError: terminated"));
    await Promise.resolve();

    expect(recreateSession).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("keeps log-only behavior for a non-terminal transport error, even with a cached handshake", async () => {
    const recreateSession = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();

    const handle = createTransportErrorHandler({
      hasCachedHandshake: () => true,
      recreateSession,
      log,
    });

    handle(new Error("stdio transport closed unexpectedly"));
    await Promise.resolve();

    expect(recreateSession).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
