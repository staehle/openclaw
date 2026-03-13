import {
  ensureGlobalUndiciEnvProxyDispatcher,
  ensureGlobalUndiciStreamTimeouts,
  patchGlobalFetchForEnvProxy,
} from "../../../infra/net/undici-global-dispatcher.js";

export function configureEmbeddedAttemptHttpRuntime(params: { timeoutMs: number }): void {
  // Proxy bootstrap must happen before timeout tuning so the timeouts wrap the
  // active EnvHttpProxyAgent instead of being replaced by a bare proxy dispatcher.
  ensureGlobalUndiciEnvProxyDispatcher();
  patchGlobalFetchForEnvProxy();
  ensureGlobalUndiciStreamTimeouts({ timeoutMs: params.timeoutMs });
}
