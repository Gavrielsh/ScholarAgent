import {
  matchesUserManagementHeuristic,
} from "@/lib/agent/baseline/intentRouter";
import {
  ADMIN_ACTION_ADD_USER,
  ADMIN_ACTION_LIST_USERS,
  canManagePermissionLevel,
  isUserManagementButtonId,
  parseAddUserInput,
  parseDeleteUserInput,
} from "@/lib/agent/baseline/userManagementHandlers";
import { normalizePhoneNumber } from "@/lib/auth/userRegistry";
import { chunkWhatsAppText, WHATSAPP_TEXT_CHAR_LIMIT } from "@/lib/whatsapp/formatting";

describe("normalizePhoneNumber", () => {
  it("converts Israeli local numbers to the WhatsApp E.164 form stored in the DB", () => {
    expect(normalizePhoneNumber("050-123-4567")).toBe("972501234567");
    expect(normalizePhoneNumber("+972501234567")).toBe("972501234567");
    expect(normalizePhoneNumber("972501234567")).toBe("972501234567");
  });

  it("rejects empty or too-short input", () => {
    expect(normalizePhoneNumber("abc")).toBeNull();
    expect(normalizePhoneNumber("123")).toBeNull();
  });
});

describe("parseAddUserInput / parseDeleteUserInput", () => {
  it("parses a multi-word name, phone, and level despite extra spaces", () => {
    expect(parseAddUserInput("יוסי כהן   0501234567   2")).toEqual({
      name: "יוסי כהן",
      phone: "972501234567",
      level: 2,
    });
  });

  it("rejects an invalid permission level and keeps the caller in session", () => {
    expect(parseAddUserInput("יוסי 0501234567 9")).toBeNull();
    expect(parseAddUserInput("יוסי 0501234567")).toBeNull();
  });

  it("accepts L-prefixed levels and comma-separated tokens", () => {
    expect(parseAddUserInput("יוסי כהן, 0501234567, L1")).toEqual({
      name: "יוסי כהן",
      phone: "972501234567",
      level: 1,
    });
    expect(parseAddUserInput("דנה 0501234567 l0")).toEqual({
      name: "דנה",
      phone: "972501234567",
      level: 0,
    });
  });

  it("parses delete input as name + phone", () => {
    expect(parseDeleteUserInput("דנה לוי 0501234567")).toEqual({
      name: "דנה לוי",
      phone: "972501234567",
    });
    expect(parseDeleteUserInput("0501234567")).toBeNull();
  });

  it("parses add/delete input regardless of phone and level token order", () => {
    expect(parseAddUserInput("אח שלי 1 0543118077")).toEqual({
      name: "אח שלי",
      phone: "972543118077",
      level: 1,
    });
    expect(parseAddUserInput("L2 אח שלי 0543118077")).toEqual({
      name: "אח שלי",
      phone: "972543118077",
      level: 2,
    });
    expect(parseDeleteUserInput("0543118077 דנה לוי")).toEqual({
      name: "דנה לוי",
      phone: "972543118077",
    });
  });
});

describe("canManagePermissionLevel", () => {
  it("blocks L1 from adding or deleting L0, and allows L0 to manage every tier", () => {
    expect(canManagePermissionLevel(1, 0)).toBe(false);
    expect(canManagePermissionLevel(1, 1)).toBe(true);
    expect(canManagePermissionLevel(0, 0)).toBe(true);
    expect(canManagePermissionLevel(0, 3)).toBe(true);
  });
});

describe("matchesUserManagementHeuristic", () => {
  it("matches the required Hebrew trigger phrases", () => {
    expect(matchesUserManagementHeuristic("אפשר להוסיף תלמיד?")).toBe(true);
    expect(matchesUserManagementHeuristic("הוספת מנהלת")).toBe(true);
    expect(matchesUserManagementHeuristic("למחוק מישהו")).toBe(true);
    expect(matchesUserManagementHeuristic("מחיקת תלמידה")).toBe(true);
    expect(matchesUserManagementHeuristic("ניהול משתמשים")).toBe(true);
    expect(matchesUserManagementHeuristic("מה מזג האוויר")).toBe(false);
  });
});

describe("isUserManagementButtonId", () => {
  it("recognises only the three admin_action_* payloads", () => {
    expect(isUserManagementButtonId(ADMIN_ACTION_ADD_USER)).toBe(true);
    expect(isUserManagementButtonId(ADMIN_ACTION_LIST_USERS)).toBe(true);
    expect(isUserManagementButtonId("l0_daily_summary")).toBe(false);
    expect(isUserManagementButtonId(undefined)).toBe(false);
  });
});

describe("chunkWhatsAppText", () => {
  it("keeps short text as a single chunk and splits long text on newlines", () => {
    expect(chunkWhatsAppText("short")).toEqual(["short"]);

    const lines = Array.from({ length: 80 }, (_, i) => `row-${i}-${"x".repeat(40)}`);
    const chunks = chunkWhatsAppText(lines.join("\n"), 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 200)).toBe(true);
    expect(chunks.join("\n")).toBe(lines.join("\n"));
  });

  it("never exceeds the WhatsApp 4096-character ceiling by default", () => {
    const text = "a".repeat(WHATSAPP_TEXT_CHAR_LIMIT + 50);
    const chunks = chunkWhatsAppText(text);
    expect(chunks.every((chunk) => chunk.length <= WHATSAPP_TEXT_CHAR_LIMIT)).toBe(true);
  });
});
