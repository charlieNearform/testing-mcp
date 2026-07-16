import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Reacts to a `clientTransport.send()` failure from the `mcp-bridge` command. Pulled out of
 * `src/cli/main.ts` (which runs `program.parse()` at import time, making it unsafe to import
 * directly from a unit test) so the 404-recovery decision can be exercised with fake transports
 * instead of a real daemon/process.
 */
export interface SendFailureDeps {
  /** True once the `initialize` request has been cached (nothing to replay before then). */
  hasCachedHandshake: () => boolean;
  /** Build a fresh transport, replay the cached handshake against it, and swap it in. */
  recreateSession: () => Promise<void>;
  /** Retry the original message against whatever transport is current after recreation. */
  retrySend: (message: JSONRPCMessage) => Promise<void>;
  /** Stderr sink (no trailing newline expected). */
  log: (message: string) => void;
}

/**
 * Builds the send-failure handler for one bridge session. The returned function only recovers
 * from an HTTP 404 (the daemon-side session is genuinely gone) with a handshake to replay --
 * every other error keeps today's log-only behaviour. Concurrent 404s share one in-flight
 * `recreateSession()` call via the closure-held `recreating` guard, so simultaneous failures never
 * race to build more than one fresh transport. If the retried send ALSO fails, this logs and gives
 * up on that message -- it never loops or retries indefinitely.
 */
export function createSendFailureHandler(
  deps: SendFailureDeps,
): (message: JSONRPCMessage, err: unknown) => Promise<void> {
  let recreating: Promise<void> | undefined;

  return async (message, err) => {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Matches @modelcontextprotocol/sdk@1.12.1's plain `Error POSTing to endpoint (HTTP ${status})`
    // thrown by StreamableHTTPClientTransport.send() -- there's no typed/structured status code to
    // check instead. If the pinned SDK version changes this wording, this match (and the whole
    // recovery path) silently stops firing; the recover-and-retry-once e2e test in
    // test/cli-mcp-bridge.test.ts against the REAL SDK is what would catch that regression.
    if (errorMessage.includes("HTTP 404") && deps.hasCachedHandshake()) {
      try {
        if (!recreating) {
          recreating = deps.recreateSession().finally(() => {
            recreating = undefined;
          });
        }
        await recreating;
        await deps.retrySend(message); // retry the original failed message once
        return;
      } catch (retryErr: unknown) {
        const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
        deps.log(`test-mcp mcp-bridge: session recreate+retry failed: ${retryMessage}`);
        return;
      }
    }
    deps.log(`test-mcp mcp-bridge: send to daemon failed: ${errorMessage}`);
  };
}
