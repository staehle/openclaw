import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/fetch-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { FormData as UndiciFormData, ProxyAgent, fetch as undiciFetch } from "undici";
import { withValidatedDiscordProxy } from "../proxy-fetch.js";

/**
 * undici.fetch with a custom `dispatcher` only recognises undici's own FormData
 * when auto-setting the multipart Content-Type header. The global Node FormData
 * (from `globalThis`) is treated as an opaque body and sent as text/plain.
 * This helper converts a global FormData into an undici FormData so the
 * multipart boundary is set correctly.
 */
function toUndiciFormData(input: FormData): UndiciFormData {
  const fd = new UndiciFormData();
  for (const [key, value] of input.entries()) {
    if (value instanceof File) {
      fd.append(key, new Blob([value], { type: value.type }), value.name);
    } else {
      fd.append(key, value);
    }
  }
  return fd;
}

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const fetcher = withValidatedDiscordProxy(proxyUrl, runtime, (proxy) => {
    const agent = new ProxyAgent(proxy);
    return wrapFetchWithAbortSignal(((input: RequestInfo | URL, init?: RequestInit) => {
      const adjusted: Record<string, unknown> = {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      };
      // Convert global FormData to undici FormData so the multipart
      // Content-Type + boundary is set correctly through the proxy.
      if (init?.body instanceof FormData && !(init.body instanceof UndiciFormData)) {
        adjusted.body = toUndiciFormData(init.body);
      }
      return undiciFetch(input as string | URL, adjusted) as unknown as Promise<Response>;
    }) as typeof fetch);
  });
  if (!fetcher) {
    return fetch;
  }
  runtime.log?.("discord: rest proxy enabled");
  return fetcher;
}
