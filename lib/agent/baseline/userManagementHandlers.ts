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

export function parseAddUserInput(raw: string): ParseAddUserResult {
  // חיתוך המחרוזת לפי פסיקים במקום רווחים
  const parts = raw.split(",");
  
  if (parts.length !== 3) {
    return { success: false, reason: "NOT_ENOUGH_ARGS" };
  }

  const rawName = parts[0];
  const rawPhone = parts[1];
  const rawLevel = parts[2];

  // 1. בדיקת שם משתמש
  const name = rawName.trim();
  if (!name) {
    return { success: false, reason: "MISSING_NAME" };
  }

  // 2. בדיקת טלפון
  const phone = normalizePhoneNumber(rawPhone);
  if (!phone) {
    return { success: false, reason: "MISSING_PHONE" };
  }

  // 3. בדיקת רמת הרשאה
  let parsedLevel: PermissionLevel | null = null;
  const cleanLevel = stripBidiControls(rawLevel).toUpperCase().replace("L", "").trim();
  
  if (/^[0-3]$/.test(cleanLevel)) {
    const num = Number.parseInt(cleanLevel, 10);
    if (isPermissionLevel(num)) {
      parsedLevel = num;
    }
  }

  if (parsedLevel === null) {
    return { success: false, reason: "INVALID_LEVEL" };
  }

  return { success: true, data: { name, phone, level: parsedLevel } };
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
  requesterLevel: PermissionLevel,
  session: AdminSession
): Promise<UserManagementFlowResult> {
  const parsed = parseAddUserInput(query);
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
  requesterLevel: PermissionLevel,
  session: AdminSession
): Promise<UserManagementFlowResult> {
  const parsed = parseDeleteUserInput(query);
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
  query: string;
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
      input.requesterPermissionLevel,
      session
    );
  }

  if (session?.mode === "AWAITING_DELETE_USER_DETAILS") {
    return handleDeleteUserInput(
      input.adminPhone,
      input.query,
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