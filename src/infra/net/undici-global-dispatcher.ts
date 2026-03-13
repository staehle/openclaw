import * as net from "node:net";
import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { hasProxyEnvConfigured } from "./proxy-env.js";

export const DEFAULT_UNDICI_STREAM_TIMEOUT_MS = 30 * 60 * 1000;

const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;

let lastAppliedDispatcherKey: string | null = null;

type DispatcherKind = "agent" | "env-proxy" | "unsupported";

function resolveDispatcherKind(dispatcher: unknown): DispatcherKind {
  const ctorName = (dispatcher as { constructor?: { name?: string } })?.constructor?.name;
  if (typeof ctorName !== "string" || ctorName.length === 0) {
    return "unsupported";
  }
  if (ctorName.includes("EnvHttpProxyAgent")) {
    return "env-proxy";
  }
  if (ctorName.includes("ProxyAgent")) {
    return "unsupported";
  }
  if (ctorName.includes("Agent")) {
    return "agent";
  }
  return "unsupported";
}

function resolveAutoSelectFamily(): boolean | undefined {
  if (typeof net.getDefaultAutoSelectFamily !== "function") {
    return undefined;
  }
  try {
    return net.getDefaultAutoSelectFamily();
  } catch {
    return undefined;
  }
}

function resolveConnectOptions(
  autoSelectFamily: boolean | undefined,
): { autoSelectFamily: boolean; autoSelectFamilyAttemptTimeout: number } | undefined {
  if (autoSelectFamily === undefined) {
    return undefined;
  }
  return {
    autoSelectFamily,
    autoSelectFamilyAttemptTimeout: AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  };
}

function resolveDispatcherKey(params: {
  kind: DispatcherKind;
  timeoutMs: number;
  autoSelectFamily: boolean | undefined;
}): string {
  const autoSelectToken =
    params.autoSelectFamily === undefined ? "na" : params.autoSelectFamily ? "on" : "off";
  return `${params.kind}:${params.timeoutMs}:${autoSelectToken}`;
}

export function ensureGlobalUndiciStreamTimeouts(opts?: { timeoutMs?: number }): void {
  const timeoutMsRaw = opts?.timeoutMs ?? DEFAULT_UNDICI_STREAM_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.floor(timeoutMsRaw));
  if (!Number.isFinite(timeoutMsRaw)) {
    return;
  }

  let dispatcher: unknown;
  try {
    dispatcher = getGlobalDispatcher();
  } catch {
    return;
  }

  const kind = resolveDispatcherKind(dispatcher);
  if (kind === "unsupported") {
    return;
  }

  const autoSelectFamily = resolveAutoSelectFamily();
  const nextKey = resolveDispatcherKey({ kind, timeoutMs, autoSelectFamily });
  if (lastAppliedDispatcherKey === nextKey) {
    return;
  }

  const connect = resolveConnectOptions(autoSelectFamily);
  try {
    if (kind === "env-proxy") {
      const proxyOptions = {
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
        ...(connect ? { connect } : {}),
      } as ConstructorParameters<typeof EnvHttpProxyAgent>[0];
      setGlobalDispatcher(new EnvHttpProxyAgent(proxyOptions));
    } else {
      setGlobalDispatcher(
        new Agent({
          bodyTimeout: timeoutMs,
          headersTimeout: timeoutMs,
          ...(connect ? { connect } : {}),
        }),
      );
    }
    lastAppliedDispatcherKey = nextKey;
  } catch {
    // Best-effort hardening only.
  }
}

/**
 * Patch `globalThis.fetch` to route all outbound HTTPS requests through the
 * HTTP proxy configured in the environment (HTTPS_PROXY / HTTP_PROXY etc.).
 *
 * Node.js v18+ ships a built-in `fetch` that uses an *internal* copy of undici
 * with its own global dispatcher — completely independent of the npm `undici`
 * package's `setGlobalDispatcher`.  As a result, third-party SDKs (OpenAI,
 * Anthropic, …) that rely on `globalThis.fetch` do **not** go through the
 * proxy even when `setGlobalDispatcher(new EnvHttpProxyAgent())` has been
 * called.
 *
 * The fix: replace `globalThis.fetch` with a thin wrapper that passes an
 * `EnvHttpProxyAgent` dispatcher on every request.  This is safe because:
 *   - undici's `EnvHttpProxyAgent` honours NO_PROXY exclusions, so local
 *     endpoints (WireGuard, localhost, …) bypass the proxy automatically.
 *   - The original `globalThis.fetch` signature is preserved; callers cannot
 *     tell the difference.
 *   - The patch is idempotent: calling this function multiple times is a no-op
 *     once the replacement is in place.
 *
 * Only applied when at least one proxy env var is set.
 */
let globalFetchPatched = false;

export function patchGlobalFetchForEnvProxy(): void {
  if (globalFetchPatched) {
    return;
  }
  if (!hasProxyEnvConfigured()) {
    return;
  }
  if (typeof globalThis.fetch !== "function") {
    return;
  }
  // Already patched (e.g. by a previous call before the flag was visible)
  if ((globalThis.fetch as { __undiciProxyPatch?: boolean }).__undiciProxyPatch) {
    globalFetchPatched = true;
    return;
  }
  let agent: EnvHttpProxyAgent | null = null;
  const resolveAgent = (): EnvHttpProxyAgent => {
    if (!agent) {
      agent = new EnvHttpProxyAgent();
    }
    return agent;
  };

  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>) as typeof globalThis.fetch & {
    __undiciProxyPatch: boolean;
  };
  proxyFetch.__undiciProxyPatch = true;

  globalThis.fetch = proxyFetch;
  globalFetchPatched = true;
}

export function resetGlobalUndiciStreamTimeoutsForTests(): void {
  lastAppliedDispatcherKey = null;
}
