import { isAdminRole, isElevatedRole } from "@/lib/auth/roles";
import type { PermissionLevel } from "@/lib/auth/types";
import {
  deleteAdminManagedUser,
  getAllManagedUsers,
  getUserByPhone,
  insertAdminManagedUser,
  normalizePhoneNumber,
} from "@/lib/auth/userRegistry";
import {
  clearAdminSession,
  getAdminSession,
  isUserManagementSessionMode,
  MAX_INVALID_ATTEMPTS,
  recordInvalidAttempt,
  SESSION_ABANDONED_MESSAGE,
  setAdminSession,
  type AdminSession,
} from "@/lib/chat/adminSession";
import { logError, logInfo } from "@/lib/logger";
import { sendWhatsAppInteractiveButtons } from "@/lib/whatsapp/messaging";

import { matchesAdminAnalyticsExitCommand, matchesUserManagementHeuristic } from "./intentRouter";

export const ADMIN_ACTION_ADD_USER = "admin_action_add_user";
export const ADMIN_ACTION_DELETE_USER = "admin_action_delete_user";
export const ADMIN_ACTION_LIST_USERS = "admin_action_list_users";

export const ADD_USER_PROMPT =
  "אנא כתוב את המשתמש בפורמט הבא:\nשם משתמש, מספר טלפון, רמת הרשאה";
export const DELETE_USER_PROMPT =
  "אנא כתוב את המשתמש בפורמט הבא:\nשם משתמש מספר טלפון";
export const HIERARCHY_DENIED_MESSAGE =
  "אין לך את ההרשאה להוסיף או למחוק רמת הרשאה מעלייך";
export const SELF_DELETE_DENIED_MESSAGE = "אינך יכול למחוק את עצמך";
export const USER_ADDED_MESSAGE = "המשתמש נוסף בהצלחה";
export const USER_DELETED_MESSAGE = "המשתמש הוסר בהצלחה";

export const ADD_FORMAT_RETRY =
  "פורמט לא תקין. אנא נסה שוב לפי הפורמט:\nשם משתמש מספר טלפון רמת הרשאה";
export const ADD_INPUT_EXAMPLE = "ישראל ישראלי, 0541234567, 0";
export const ADD_NOT_ENOUGH_ARGS_MESSAGE =
  `חסרים פרטים. אנא הזן שם, מספר טלפון ורמת הרשאה.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
export const ADD_INVALID_LEVEL_MESSAGE =
  `רמת ההרשאה לא זוהתה. יש להזין ספרה בין 0 ל-3.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
export const ADD_MISSING_PHONE_MESSAGE =
  `לא זוהה מספר טלפון תקין.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
export const ADD_MISSING_NAME_MESSAGE =
  `לא זוהה שם משתמש.\nדוגמה לקלט תקין: ${ADD_INPUT_EXAMPLE}`;
const DELETE_FORMAT_RETRY =
  "פורמט לא תקין. אנא נסה שוב לפי הפורמט:\nשם משתמש מספר טלפון";
const LIST_USERS_DENIED_MESSAGE = "פעולה זו זמינה למנהלי מערכת בלבד";
const USER_EXISTS_MESSAGE = "המשתמש כבר קיים במערכת. נסה מספר טלפון אחר.";
const USER_NOT_FOUND_MESSAGE = "המשתמש לא נמצא במערכת. בדוק את מספר הטלפון ונסה שוב.";
const EMPTY_USER_TABLE_MESSAGE = "לא נמצאו משתמשים במערכת.";
const USER_TABLE_HEADER = "רמת הרשאה | שם משתמש | מספר טלפון";
const UNKNOWN_BUTTON_MESSAGE =
  "בחירה לא מזוהה. שלח 'ניהול משתמשים' כדי לפתוח את התפריט מחדש.";
const USER_MANAGEMENT_MENU_RETRY =
  "בחירה לא מזוהה. הקלד/י 1 להוספה, 2 למחיקה, 3 לטבלת משתמשים, או ביטול ליציאה.";

export const USER_MANAGEMENT_CANCELLED_MESSAGE = "הפעולה בוטלה.";

export type UserManagementMenuChoice = "add" | "delete" | "list" | "cancel";

export type UserManagementFlowResult =
  | { type: "text"; answer: string }
  | { type: "interactive_sent" }
  | { type: "prompt_sent"; promptText: string };

export interface ParsedAddUserInput {
  name: string;
  phone: string;
  level: PermissionLevel;
}

export type ParseAddUserFailureReason =
  | "NOT_ENOUGH_ARGS"
  | "INVALID_LEVEL"
  | "MISSING_PHONE"
  | "MISSING_NAME";

export type ParseAddUserResult =
  | { success: true; data: ParsedAddUserInput }
  | { success: false; reason: ParseAddUserFailureReason };

export interface ParsedDeleteUserInput {
  name: string;
  phone: string;
}

const ADD_PARSE_ERROR_MESSAGES: Record<ParseAddUserFailureReason, string> = {
  NOT_ENOUGH_ARGS: ADD_NOT_ENOUGH_ARGS_MESSAGE,
  INVALID_LEVEL: ADD_INVALID_LEVEL_MESSAGE,
  MISSING_PHONE: ADD_MISSING_PHONE_MESSAGE,
  MISSING_NAME: ADD_MISSING_NAME_MESSAGE,
};

/** WhatsApp injects these into RTL number runs; they make /^[0-3]$/ fail. */
const BIDI_CONTROL_CHARS = /[\u200E\u200F\u202A-\u202E]/g;

function stripBidiControls(value: string): string {
  return value.replace(BIDI_CONTROL_CHARS, "");
}

/**
 * Opt-in forensic logging for the add/delete parsers, off unless
 * USER_MGMT_DEBUG=1.
 *
 * Exists because this flow is the one place where the pipeline hands the
 * handlers a string that differs from what the admin typed: everything upstream
 * of the orchestrator runs on PII-redacted text (see `redactPii` in
 * lib/ingestion/piiRedact.ts), so a parse failure here is far more often a
 * mismatch between the two strings than a genuinely malformed input. The trace
 * prints both, with code points, so that is visible in one log line instead of
 * being re-derived from a unit test that never sees the redacted form.
 *
 * Logs raw admin input verbatim — keep it off outside of an active
 * investigation.
 */
const USER_MGMT_DEBUG = process.env.USER_MGMT_DEBUG === "1";

function describeRaw(label: string, value: string): Record<string, unknown> {
  return {
    [`${label}_json`]: JSON.stringify(value),
    [`${label}_len`]: value.length,
    [`${label}_codepoints`]: Array.from(value).map(
      (char) => `${char}:U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
    ),
  };
}

export function isUserManagementButtonId(buttonId: string | undefined): boolean {
  return (
    buttonId === ADMIN_ACTION_ADD_USER ||
    buttonId === ADMIN_ACTION_DELETE_USER ||
    buttonId === ADMIN_ACTION_LIST_USERS
  );
}

/** Requester may manage a target whose privilege is equal or lower (higher numeric level). */
export function canManagePermissionLevel(
  requesterLevel: PermissionLevel,
  targetLevel: PermissionLevel
): boolean {
  return requesterLevel <= targetLevel;
}

function isPermissionLevel(value: number): value is PermissionLevel {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function tokenize(raw: string): string[] {
  return stripBidiControls(raw)
    .trim()
    .split(/[\s,]+/)
    .map(stripBidiControls)
    .filter((token) => token.length > 0);
}

export function parseUserManagementMenuChoice(
  query: string,
  buttonId?: string
): UserManagementMenuChoice | null {
  if (buttonId === ADMIN_ACTION_ADD_USER) return "add";
  if (buttonId === ADMIN_ACTION_DELETE_USER) return "delete";
  if (buttonId === ADMIN_ACTION_LIST_USERS) return "list";

  const text = stripBidiControls(query).trim();
  if (!text) return null;
  if (matchesAdminAnalyticsExitCommand(text)) return "cancel";

  if (
    /^\s*1[\.)]?\s*$/.test(text) ||
    /^\s*(?:הוסף\s*משתמש|add\s*user)\s*$/i.test(text) ||
    text === ADMIN_ACTION_ADD_USER
  ) {
    return "add";
  }
  if (
    /^\s*2[\.)]?\s*$/.test(text) ||
    /^\s*(?:מחק\s*משתמש|delete\s*user)\s*$/i.test(text) ||
    text === ADMIN_ACTION_DELETE_USER
  ) {
    return "delete";
  }
  if (
    /^\s*3[\.)]?\s*$/.test(text) ||
    /^\s*(?:טבלת\s*משתמשים|list\s*users)\s*$/i.test(text) ||
    text === ADMIN_ACTION_LIST_USERS
  ) {
    return "list";
  }

  return null;
}

/** `0`, `3`, `L1`, `l0` — the level as admins actually type it. */
const LEVEL_TOKEN = /^L?([0-3])$/i;

/**
 * Parses "name, phone, level" from one free-text WhatsApp line.
 *
 * Tolerant of both separators on purpose: ADD_USER_PROMPT shows commas,
 * ADD_FORMAT_RETRY shows spaces, and `tokenize` splits on either, so an admin
 * who mixes them still gets through. Field *order* is not fixed either — the
 * phone is identified by being the only token that normalises to a phone
 * number, and the level by matching LEVEL_TOKEN, so whatever is left is the
 * name. That is what lets "אח שלי 1 0543118077" and "L2 אח שלי 0543118077"
 * both resolve.
 *
 * The checks run phone → level → name so the returned reason names the field
 * the admin actually has to fix.
 */
export function parseAddUserInput(raw: string): ParseAddUserResult {
  const tokens = tokenize(raw);

  const trace = (
    result: ParseAddUserResult,
    meta: Record<string, unknown>
  ): ParseAddUserResult => {
    if (USER_MGMT_DEBUG) {
      logInfo("add_user_parse_trace", "parseAddUserInput result.", {
        ...describeRaw("raw", raw),
        tokens,
        phoneCandidate: null,
        normalizedPhone: null,
        levelCandidate: null,
        ...meta,
        outcome: result.success ? "SUCCESS" : result.reason,
      });
    }
    return result;
  };

  if (tokens.length < 3) {
    return trace({ success: false, reason: "NOT_ENOUGH_ARGS" }, {});
  }

  // Phone first. `normalizePhoneNumber` strips every non-digit, so this is the
  // one test that cannot be fooled by a Hebrew name or an L-prefixed level, and
  // it is immune to the bidi marks WhatsApp injects around number runs.
  let phoneIndex = -1;
  let phone: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const candidate = normalizePhoneNumber(tokens[i]);
    if (candidate) {
      phoneIndex = i;
      phone = candidate;
      break;
    }
  }

  if (phoneIndex === -1 || !phone) {
    return trace({ success: false, reason: "MISSING_PHONE" }, {});
  }

  const phoneMeta = { phoneCandidate: tokens[phoneIndex], normalizedPhone: phone };

  // Scanned from the end: the canonical format puts the level last, so a bare
  // 0–3 sitting inside the name cannot steal it.
  let levelIndex = -1;
  let level: PermissionLevel | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (i === phoneIndex) continue;
    const match = LEVEL_TOKEN.exec(stripBidiControls(tokens[i]));
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (!isPermissionLevel(parsed)) continue;
    levelIndex = i;
    level = parsed;
    break;
  }

  if (levelIndex === -1 || level === null) {
    return trace({ success: false, reason: "INVALID_LEVEL" }, phoneMeta);
  }

  const name = tokens
    .filter((_, index) => index !== phoneIndex && index !== levelIndex)
    .join(" ")
    .trim();

  const meta = { ...phoneMeta, levelCandidate: tokens[levelIndex] };

  if (!name) {
    return trace({ success: false, reason: "MISSING_NAME" }, meta);
  }

  return trace({ success: true, data: { name, phone, level } }, meta);
}

export function parseDeleteUserInput(raw: string): ParsedDeleteUserInput | null {
  const tokens = tokenize(raw);
  if (tokens.length < 2) return null;

  let phoneIndex = -1;
  let normalizedPhone: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const phone = normalizePhoneNumber(tokens[i]);
    if (phone) {
      phoneIndex = i;
      normalizedPhone = phone;
      break;
    }
  }

  if (phoneIndex === -1 || !normalizedPhone) return null;

  const nameTokens = tokens.filter((_, idx) => idx !== phoneIndex);
  const name = nameTokens.join(" ").trim();
  if (!name) return null;

  return { name, phone: normalizedPhone };
}

async function failInvalid(
  adminPhone: string,
  session: AdminSession,
  retryMessage: string
): Promise<UserManagementFlowResult> {
  if ((await recordInvalidAttempt(adminPhone, session)) >= MAX_INVALID_ATTEMPTS) {
    return { type: "text", answer: SESSION_ABANDONED_MESSAGE };
  }
  return { type: "text", answer: retryMessage };
}

async function sendUserManagementMenu(
  to: string,
  userLevel: PermissionLevel,
  signal?: AbortSignal | null
): Promise<void> {
  const buttons = [
    { id: ADMIN_ACTION_ADD_USER, title: "הוסף משתמש" },
    { id: ADMIN_ACTION_DELETE_USER, title: "מחק משתמש" },
  ];
  if (isAdminRole(userLevel)) {
    buttons.push({ id: ADMIN_ACTION_LIST_USERS, title: "טבלת משתמשים" });
  }

  await setAdminSession(to, "AWAITING_USER_MANAGEMENT_CHOICE");
  await sendWhatsAppInteractiveButtons({
    to,
    bodyText: isAdminRole(userLevel)
      ? "בחר את הפעולה שברצונך לבצע:\n1. הוסף משתמש\n2. מחק משתמש\n3. טבלת משתמשים"
      : "בחר את הפעולה שברצונך לבצע:\n1. הוסף משתמש\n2. מחק משתמש",
    buttons,
    signal,
  });
}

function formatUserTable(
  users: Array<{ phone_number: string; display_name: string; permission_level: number }>
): string {
  if (users.length === 0) return EMPTY_USER_TABLE_MESSAGE;
  const rows = users.map(
    (user) =>
      `${user.permission_level} | ${user.display_name || "—"} | ${user.phone_number}`
  );
  return [USER_TABLE_HEADER, ...rows].join("\n");
}

async function handleAddUserInput(
  adminPhone: string,
  query: string,
  commandText: string | undefined,
  requesterLevel: PermissionLevel,
  session: AdminSession
): Promise<UserManagementFlowResult> {
  // `query` has been through `redactPii`, which rewrites any Israeli phone
  // number to "[PHONE_REDACTED]" — parsing it can only ever yield MISSING_PHONE.
  // `commandText` is the same message before redaction, supplied for exactly
  // this reason (lib/whatsapp/incomingMessageProcessor.ts). It falls back to
  // `query` for callers outside the WhatsApp pipeline, such as the evaluator.
  const parsed = parseAddUserInput(commandText ?? query);

  if (USER_MGMT_DEBUG) {
    logInfo("add_user_branch_trace", "handleAddUserInput branch selected.", {
      adminPhone,
      ...describeRaw("query", query),
      ...describeRaw("commandText", commandText ?? ""),
      usedCommandText: commandText !== undefined,
      outcome: parsed.success ? "SUCCESS" : parsed.reason,
      replyConstant: parsed.success ? null : ADD_PARSE_ERROR_MESSAGES[parsed.reason],
      // Echoed so a log line proves which build produced it.
      addInputExample: ADD_INPUT_EXAMPLE,
    });
  }

  if (!parsed.success) {
    return failInvalid(adminPhone, session, ADD_PARSE_ERROR_MESSAGES[parsed.reason]);
  }

  const { name, phone, level } = parsed.data;

  if (!canManagePermissionLevel(requesterLevel, level)) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: HIERARCHY_DENIED_MESSAGE };
  }

  const inserted = await insertAdminManagedUser(phone, name, level);
  if (!inserted) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: USER_EXISTS_MESSAGE };
  }

  await clearAdminSession(adminPhone);
  return { type: "text", answer: USER_ADDED_MESSAGE };
}

async function handleDeleteUserInput(
  adminPhone: string,
  query: string,
  commandText: string | undefined,
  requesterLevel: PermissionLevel,
  session: AdminSession
): Promise<UserManagementFlowResult> {
  // Same redaction problem as handleAddUserInput — see the note there.
  const parsed = parseDeleteUserInput(commandText ?? query);

  if (USER_MGMT_DEBUG) {
    logInfo("delete_user_branch_trace", "handleDeleteUserInput branch selected.", {
      adminPhone,
      ...describeRaw("query", query),
      ...describeRaw("commandText", commandText ?? ""),
      usedCommandText: commandText !== undefined,
      outcome: parsed ? "SUCCESS" : "PARSE_FAILED",
    });
  }

  if (!parsed) return failInvalid(adminPhone, session, DELETE_FORMAT_RETRY);

  const requesterPhone = normalizePhoneNumber(adminPhone) ?? adminPhone;
  if (parsed.phone === requesterPhone) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: SELF_DELETE_DENIED_MESSAGE };
  }

  const target = await getUserByPhone(parsed.phone);
  if (target && !canManagePermissionLevel(requesterLevel, target.permission_level)) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: HIERARCHY_DENIED_MESSAGE };
  }

  const deleted = await deleteAdminManagedUser(parsed.phone);
  if (!deleted) {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: USER_NOT_FOUND_MESSAGE };
  }

  await clearAdminSession(adminPhone);
  return { type: "text", answer: USER_DELETED_MESSAGE };
}

async function applyUserManagementChoice(
  adminPhone: string,
  choice: UserManagementMenuChoice,
  requesterLevel: PermissionLevel
): Promise<UserManagementFlowResult> {
  if (choice === "cancel") {
    await clearAdminSession(adminPhone);
    return { type: "text", answer: USER_MANAGEMENT_CANCELLED_MESSAGE };
  }

  if (choice === "add") {
    await setAdminSession(adminPhone, "AWAITING_ADD_USER_DETAILS");
    return { type: "prompt_sent", promptText: ADD_USER_PROMPT };
  }

  if (choice === "delete") {
    await setAdminSession(adminPhone, "AWAITING_DELETE_USER_DETAILS");
    return { type: "prompt_sent", promptText: DELETE_USER_PROMPT };
  }

  if (!isAdminRole(requesterLevel)) {
    return { type: "text", answer: LIST_USERS_DENIED_MESSAGE };
  }
  await clearAdminSession(adminPhone);
  const users = await getAllManagedUsers();
  return { type: "text", answer: formatUserTable(users) };
}

export async function resolveUserManagementFlow(input: {
  adminPhone: string;
  /** PII-redacted text. Safe to log; used for menu/heuristic matching. */
  query: string;
  /**
   * The same message *before* redaction, for the deterministic add/delete
   * parsers only — a redacted phone number carries no digits, so parsing
   * `query` can never succeed. Never logged (outside USER_MGMT_DEBUG),
   * persisted, traced, or sent to an LLM. Optional so non-WhatsApp callers
   * keep working.
   */
  commandText?: string;
  buttonId?: string;
  requesterPermissionLevel: PermissionLevel;
  signal?: AbortSignal | null;
}): Promise<UserManagementFlowResult> {
  if (!isElevatedRole(input.requesterPermissionLevel)) {
    logError(
      "user_management_permission_violation",
      new Error("non-elevated role reached user management flow"),
      {
        adminPhone: input.adminPhone,
        requesterPermissionLevel: input.requesterPermissionLevel,
      }
    );
    return { type: "text", answer: "" };
  }

  const session = await getAdminSession(input.adminPhone);
  const menuChoice = parseUserManagementMenuChoice(input.query, input.buttonId);

  if (input.buttonId && isUserManagementButtonId(input.buttonId) && menuChoice) {
    logInfo("user_management_choice_resolved", "User-management button selected.", {
      adminPhone: input.adminPhone,
      choice: menuChoice,
    });
    return applyUserManagementChoice(
      input.adminPhone,
      menuChoice,
      input.requesterPermissionLevel
    );
  }

  if (input.buttonId && isUserManagementButtonId(input.buttonId)) {
    return { type: "text", answer: UNKNOWN_BUTTON_MESSAGE };
  }

  if (session && isUserManagementSessionMode(session.mode) && menuChoice === "cancel") {
    await clearAdminSession(input.adminPhone);
    return { type: "text", answer: USER_MANAGEMENT_CANCELLED_MESSAGE };
  }

  if (session?.mode === "AWAITING_USER_MANAGEMENT_CHOICE") {
    if (menuChoice && menuChoice !== "cancel") {
      logInfo("user_management_choice_resolved", "User-management text selected.", {
        adminPhone: input.adminPhone,
        choice: menuChoice,
      });
      return applyUserManagementChoice(
        input.adminPhone,
        menuChoice,
        input.requesterPermissionLevel
      );
    }
    if (matchesUserManagementHeuristic(input.query)) {
      await sendUserManagementMenu(
        input.adminPhone,
        input.requesterPermissionLevel,
        input.signal
      );
      return { type: "interactive_sent" };
    }
    return failInvalid(input.adminPhone, session, USER_MANAGEMENT_MENU_RETRY);
  }

  if (session?.mode === "AWAITING_ADD_USER_DETAILS") {
    return handleAddUserInput(
      input.adminPhone,
      input.query,
      input.commandText,
      input.requesterPermissionLevel,
      session
    );
  }

  if (session?.mode === "AWAITING_DELETE_USER_DETAILS") {
    return handleDeleteUserInput(
      input.adminPhone,
      input.query,
      input.commandText,
      input.requesterPermissionLevel,
      session
    );
  }

  await sendUserManagementMenu(
    input.adminPhone,
    input.requesterPermissionLevel,
    input.signal
  );
  return { type: "interactive_sent" };
}