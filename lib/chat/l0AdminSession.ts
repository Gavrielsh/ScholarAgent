export type L0AdminSessionMode =
  | "awaiting_menu_choice"
  | "awaiting_user_name";

export interface L0AdminSession {
  mode: L0AdminSessionMode;
  updatedAt: number;
}

const sessions = new Map<string, L0AdminSession>();
const SESSION_TTL_MS = 60 * 60 * 1000;

function pruneExpired(now = Date.now()): void {
  for (const [phone, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(phone);
    }
  }
}

export function getL0AdminSession(adminPhone: string): L0AdminSession | null {
  pruneExpired();
  return sessions.get(adminPhone) ?? null;
}

export function setL0AdminSession(adminPhone: string, mode: L0AdminSessionMode): void {
  pruneExpired();
  sessions.set(adminPhone, { mode, updatedAt: Date.now() });
}

export function clearL0AdminSession(adminPhone: string): void {
  sessions.delete(adminPhone);
}
