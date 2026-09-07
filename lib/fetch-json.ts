export async function fetchJson<T = Record<string, unknown>>(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000,
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as T;
    return { response, body };
  } finally {
    window.clearTimeout(timeout);
  }
}
