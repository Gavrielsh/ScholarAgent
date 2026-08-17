// Hard deadlines for every outbound HTTP call.
//
// Node's global fetch has NO default timeout. A half-open socket (load-balancer
// silently dropping a connection, an LLM provider stalling mid-stream) hangs the
// awaiting promise forever, which in the BullMQ worker means the job never
// settles, its lock is renewed indefinitely, and one of the N concurrency slots
// is gone until the process restarts. Every fetch in this codebase must go
// through one of the helpers below.

export const DEFAULT_HTTP_TIMEOUT_MS = Number(process.env.HTTP_DEFAULT_TIMEOUT_MS ?? 15_000);

/** Thrown when *our* deadline fired. Retryable: the peer was just too slow. */
export class HttpTimeoutError extends Error {
  readonly target: string;
  readonly timeoutMs: number;

  constructor(target: string, timeoutMs: number) {
    super(`HTTP request to ${target} timed out after ${timeoutMs}ms.`);
    this.name = "HttpTimeoutError";
    this.target = target;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when the *caller's* signal aborted (job deadline, worker shutdown).
 * NOT retryable in-process — the surrounding unit of work is already cancelled,
 * so retrying here would just race the shutdown.
 */
export class HttpAbortedError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`HTTP request to ${target} was aborted by the caller.`);
    this.name = "HttpAbortedError";
    this.target = target;
  }
}

export function isHttpTimeoutError(err: unknown): err is HttpTimeoutError {
  return err instanceof HttpTimeoutError;
}

export function isHttpAbortedError(err: unknown): err is HttpAbortedError {
  return err instanceof HttpAbortedError;
}

/**
 * True for any abort-shaped failure, including a bare `AbortError` from
 * undici that escaped our own classification (e.g. a signal we did not create).
 */
export function isAbortError(err: unknown): boolean {
  if (isHttpTimeoutError(err) || isHttpAbortedError(err)) return true;
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Strips the query string before a URL is put in an error message or log line.
 *
 * This is not cosmetic: the Gemini endpoints carry the API key as `?key=...`,
 * so echoing a raw request URL into an exception would leak a live credential
 * into logs, Langfuse traces, and any error reporter downstream.
 */
export function redactUrl(url: string): string {
  const cut = url.indexOf("?");
  return cut === -1 ? url : `${url.slice(0, cut)}?<redacted>`;
}

export interface FetchWithTimeoutOptions extends Omit<RequestInit, "signal"> {
  /** Wall-clock budget for headers **and** body. Defaults to 15s. */
  timeoutMs?: number;
  /**
   * Upstream cancellation (BullMQ job deadline, worker shutdown). Aborting it
   * aborts the in-flight request immediately instead of waiting out `timeoutMs`.
   */
  signal?: AbortSignal | null;
  /** Safe identifier for errors/logs. Defaults to the query-stripped URL. */
  label?: string;
}

interface Deadline {
  signal: AbortSignal;
  /** Distinguishes "we timed out" from "the caller cancelled us". */
  timedOut: () => boolean;
  dispose: () => void;
}

/**
 * One AbortController fed by two independent sources: our timer and the
 * caller's signal.
 *
 * `AbortSignal.any` would express this natively but is only available from Node
 * 20.3, and this same module is bundled into the Next.js edge-adjacent build, so
 * the listener is wired manually. The listener MUST be removed in `dispose` —
 * a single long-lived job signal wraps many sequential fetches, and leaking one
 * listener per fetch trips Node's MaxListenersExceededWarning and retains every
 * dead controller for the life of the job.
 */
function createDeadline(timeoutMs: number, external?: AbortSignal | null): Deadline {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Never let a pending request timer by itself hold the process open while the
  // worker is draining on SIGTERM.
  timer.unref?.();

  const onExternalAbort = (): void => controller.abort();

  if (external) {
    // Already-aborted signals never emit "abort" again — check before subscribing.
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function classifyAbort(
  err: unknown,
  deadline: Deadline,
  external: AbortSignal | null | undefined,
  target: string,
  timeoutMs: number
): Error {
  // Order matters: our own timeout is checked first so a job deadline that
  // happens to expire in the same tick is not misreported as a slow peer.
  if (deadline.timedOut()) return new HttpTimeoutError(target, timeoutMs);
  if (external?.aborted) return new HttpAbortedError(target);
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * `fetch` with a hard deadline. Prefer {@link fetchTextWithTimeout} — this
 * variant's timer only covers the response *headers*, so the caller becomes
 * responsible for reading the body before the socket can stall again.
 */
export async function fetchWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, signal: external, label, ...init } = options;
  const target = label ?? redactUrl(url);
  const deadline = createDeadline(timeoutMs, external);

  try {
    return await fetch(url, { ...init, signal: deadline.signal });
  } catch (err) {
    throw classifyAbort(err, deadline, external, target, timeoutMs);
  } finally {
    deadline.dispose();
  }
}

export interface HttpTextResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  /** Fully buffered response body. Always read — never left dangling. */
  body: string;
}

/**
 * The helper every caller in this repo should use.
 *
 * `fetch` resolves as soon as response *headers* arrive, so a timeout that only
 * wraps the fetch call leaves `await response.text()` unguarded — a peer can
 * send `200 OK` and then stall the body forever. Here a single deadline spans
 * both phases, and the body is always drained so undici can release the socket
 * back to the pool instead of leaking it.
 */
export async function fetchTextWithTimeout(
  url: string,
  options: FetchWithTimeoutOptions = {}
): Promise<HttpTextResponse> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, signal: external, label, ...init } = options;
  const target = label ?? redactUrl(url);
  const deadline = createDeadline(timeoutMs, external);

  try {
    const response = await fetch(url, { ...init, signal: deadline.signal });
    const body = await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, body };
  } catch (err) {
    throw classifyAbort(err, deadline, external, target, timeoutMs);
  } finally {
    deadline.dispose();
  }
}

/** Thrown when a response body exceeded the caller's byte budget. Never retryable. */
export class HttpPayloadTooLargeError extends Error {
  readonly target: string;
  readonly maxBytes: number;

  constructor(target: string, maxBytes: number) {
    super(`Response from ${target} exceeded the ${maxBytes}-byte limit.`);
    this.name = "HttpPayloadTooLargeError";
    this.target = target;
    this.maxBytes = maxBytes;
  }
}

export function isHttpPayloadTooLargeError(err: unknown): err is HttpPayloadTooLargeError {
  return err instanceof HttpPayloadTooLargeError;
}

export interface HttpBinaryResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  /** Fully buffered response body, capped at `maxBytes`. */
  body: ArrayBuffer;
}

export interface FetchBinaryOptions extends FetchWithTimeoutOptions {
  /**
   * Hard ceiling on the buffered body. Enforced while streaming, not after, so
   * a hostile or misreported `content-length` cannot make the worker allocate
   * an unbounded buffer.
   */
  maxBytes?: number;
}

/**
 * Binary sibling of {@link fetchTextWithTimeout}: one deadline covering headers
 * **and** body, plus a streaming size cap.
 *
 * Needed because media downloads cannot go through the text helper — decoding a
 * PDF as UTF-8 corrupts it — and because a download is the one call in this
 * codebase where the body is large enough that "read it all, then check the
 * size" is itself the denial-of-service.
 */
export async function fetchBinaryWithTimeout(
  url: string,
  options: FetchBinaryOptions = {}
): Promise<HttpBinaryResponse> {
  const {
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    signal: external,
    label,
    maxBytes,
    ...init
  } = options;
  const target = label ?? redactUrl(url);
  const deadline = createDeadline(timeoutMs, external);

  try {
    const response = await fetch(url, { ...init, signal: deadline.signal });

    // Cheap pre-check. Advisory only — the streaming guard below is the one that
    // actually holds when the header lies or is absent.
    const declared = Number(response.headers.get("content-length"));
    if (maxBytes !== undefined && Number.isFinite(declared) && declared > maxBytes) {
      throw new HttpPayloadTooLargeError(target, maxBytes);
    }

    const body = await readBoundedBody(response, target, maxBytes);
    return { ok: response.ok, status: response.status, headers: response.headers, body };
  } catch (err) {
    if (isHttpPayloadTooLargeError(err)) throw err;
    throw classifyAbort(err, deadline, external, target, timeoutMs);
  } finally {
    deadline.dispose();
  }
}

async function readBoundedBody(
  response: Response,
  target: string,
  maxBytes: number | undefined
): Promise<ArrayBuffer> {
  if (!response.body) {
    return new ArrayBuffer(0);
  }

  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) {
        throw new HttpPayloadTooLargeError(target, maxBytes);
      }
      parts.push(value);
    }
  } catch (err) {
    // Tear the stream down instead of leaving the remainder of a large body to
    // trickle in: undici cannot return the socket to the pool until the body is
    // either fully read or explicitly cancelled.
    await reader.cancel().catch(() => undefined);
    throw err;
  }

  reader.releaseLock();

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged.buffer;
}

/**
 * Parses a JSON body that was already buffered by {@link fetchTextWithTimeout}.
 * Providers occasionally answer `200` with an HTML error page from an edge
 * proxy; surfacing that as a typed error beats a raw `SyntaxError` with no context.
 */
export function parseJsonBody<T>(body: string, target: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      `${target} returned a non-JSON body (${body.length} bytes): ${body.slice(0, 200)}`
    );
  }
}

/**
 * `setTimeout` that resolves early when `signal` aborts, so retry backoffs do
 * not keep a cancelled job alive for the full delay.
 */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();

    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
