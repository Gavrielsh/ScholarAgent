import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";

export interface ChatHistoryEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string; // ISO 8601
  messageId?: string;
}

export interface ChatHistoryFile {
  senderId: string;
  createdAt: string;
  updatedAt: string;
  entries: ChatHistoryEntry[];
}

const CHAT_DIR = process.env.CHAT_HISTORY_DIR ?? join(process.cwd(), "data", "chats");

// Per-senderId in-process mutex chain to serialise concurrent writes that
// arrive in the same Node process. Each new operation chains onto the
// previous promise for that sender so no two writers race.
//
// TODO: For multi-instance deployments (e.g. Vercel serverless or k8s),
//       replace this with a Postgres advisory lock or a Redis lock so
//       concurrency is enforced across processes too.
const senderLocks = new Map<string, Promise<unknown>>();

function withSenderLock<T>(senderId: string, task: () => Promise<T>): Promise<T> {
  const previous = senderLocks.get(senderId) ?? Promise.resolve();
  const next = previous.then(task, task);
  // Track the lock without leaking rejections, and clear it when this op finishes.
  senderLocks.set(
    senderId,
    next.catch(() => undefined)
  );
  next.finally(() => {
    if (senderLocks.get(senderId) === next || senderLocks.get(senderId) === next.catch(() => undefined)) {
      senderLocks.delete(senderId);
    }
  });
  return next;
}

// Validates that the sender ID is safe to use in a filename — prevents path
// traversal (e.g. "../../etc/passwd") and other surprises.
function safeSenderFilePath(senderId: string): string {
  if (!senderId || !/^[A-Za-z0-9_+\-]{3,64}$/.test(senderId)) {
    throw new Error(`Invalid senderId for chat history: "${senderId}".`);
  }
  const target = normalize(join(CHAT_DIR, `${senderId}.json`));
  const root = resolve(CHAT_DIR);
  if (!resolve(target).startsWith(root + sep) && resolve(target) !== root) {
    throw new Error("Resolved chat history path escapes the configured directory.");
  }
  return target;
}

async function ensureDirExists(filePath: string): Promise<void> {
  try {
    await mkdir(dirname(filePath), { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied creating chat history directory: ${dirname(filePath)}`);
    }
    throw err;
  }
}

async function readHistoryFile(filePath: string, senderId: string): Promise<ChatHistoryFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ChatHistoryFile;

    if (!parsed || !Array.isArray(parsed.entries)) {
      throw new Error("Malformed chat history file: missing entries array.");
    }
    return parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      const now = new Date().toISOString();
      return { senderId, createdAt: now, updatedAt: now, entries: [] };
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied reading chat history file: ${filePath}`);
    }
    if (err instanceof SyntaxError) {
      // TODO: Move the corrupted file aside instead of overwriting it once
      //       observability is wired in, so the data can be inspected later.
      const now = new Date().toISOString();
      return { senderId, createdAt: now, updatedAt: now, entries: [] };
    }
    throw err;
  }
}

// Atomic write: write to a sibling temp file then rename. On POSIX file
// systems rename is atomic, so a partial write never overwrites the live file.
async function writeHistoryFileAtomic(filePath: string, payload: ChatHistoryFile): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    await rename(tempPath, filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`Permission denied writing chat history: ${filePath}`);
    }
    if (code === "ENOSPC") {
      throw new Error("Disk is full; cannot persist chat history.");
    }
    throw err;
  }
}

// Public API: append one or more entries for a given sender.
// Concurrent calls from the same process are serialised per sender.
export async function appendChatEntries(
  senderId: string,
  newEntries: ChatHistoryEntry[]
): Promise<ChatHistoryFile> {
  if (newEntries.length === 0) {
    // No-op fast path; still take the lock so callers can rely on ordering.
    return withSenderLock(senderId, async () => {
      const path = safeSenderFilePath(senderId);
      await ensureDirExists(path);
      return readHistoryFile(path, senderId);
    });
  }

  return withSenderLock(senderId, async () => {
    const path = safeSenderFilePath(senderId);
    await ensureDirExists(path);

    const current = await readHistoryFile(path, senderId);
    const updated: ChatHistoryFile = {
      ...current,
      updatedAt: new Date().toISOString(),
      entries: [...current.entries, ...newEntries],
    };

    await writeHistoryFileAtomic(path, updated);
    return updated;
  });
}

export async function readChatHistory(senderId: string): Promise<ChatHistoryFile> {
  return withSenderLock(senderId, async () => {
    const path = safeSenderFilePath(senderId);
    return readHistoryFile(path, senderId);
  });
}
