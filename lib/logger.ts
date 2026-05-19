type LogLevel = "error" | "warn" | "info";

interface LogPayload {
  level: LogLevel;
  event: string;
  message: string;
  timestamp: string;
  stack?: string;
  meta?: Record<string, unknown>;
}

function serializeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { message: String(err) };
}

function emit(payload: LogPayload): void {
  const line = JSON.stringify(payload);
  if (payload.level === "error") {
    console.error(line);
    return;
  }
  if (payload.level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export function logError(
  event: string,
  err: unknown,
  meta?: Record<string, unknown>
): void {
  const { message, stack } = serializeError(err);
  emit({
    level: "error",
    event,
    message,
    timestamp: new Date().toISOString(),
    stack,
    meta,
  });
}

export function logWarn(event: string, message: string, meta?: Record<string, unknown>): void {
  emit({
    level: "warn",
    event,
    message,
    timestamp: new Date().toISOString(),
    meta,
  });
}

export function logInfo(event: string, message: string, meta?: Record<string, unknown>): void {
  emit({
    level: "info",
    event,
    message,
    timestamp: new Date().toISOString(),
    meta,
  });
}
