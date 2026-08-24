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
  setAdminSession,
} from "@/lib/chat/adminSession";
import { logError } from "@/lib/logger";
import { sendWhatsAppInteractiveButtons } from "@/lib/whatsapp/messaging";

export const ADMIN_ACTION_ADD_USER = "admin_action_add_user";
export const ADMIN_ACTION_DELETE_USER = "admin_action_delete_user";
export const ADMIN_ACTION_LIST_USERS = "admin_action_list_users";

export const ADD_USER_PROMPT =
  "אנא כתוב את המשתמש בפורמט הבא:\nשם משתמש מספר טלפון רמת הרשאה";
export const DELETE_USER_PROMPT =
  "אנא כתוב את המשתמש בפורמט הבא:\nשם משתמש מספר טלפון";
export const HIERARCHY_DENIED_MESSAGE =
  "אין לך את ההרשאה להוסיף או למחוק רמת הרשאה מעלייך";
export const SELF_DELETE_DENIED_MESSAGE = "אינך יכול למחוק את עצמך";
export const USER_ADDED_MESSAGE = "המשתמש נוסף בהצלחה";
export const USER_DELETED_MESSAGE = "המשתמש הוסר בהצלחה";

export const ADD_FORMAT_RETRY =
  "פורמט לא תקין. אנא נסה שוב לפי הפורמט:\nשם משתמש מספר טלפון רמת הרשאה";
const DELETE_FORMAT_RETRY =
  "פורמט לא תקין. אנא נסה שוב לפי הפורמט:\nשם משתמש מספר טלפון";
const LIST_USERS_DENIED_MESSAGE = "פעולה זו זמינה למנהלי מערכת בלבד";
const USER_EXISTS_MESSAGE = "המשתמש כבר קיים במערכת. נסה מספר טלפון אחר.";
const USER_NOT_FOUND_MESSAGE = "המשתמש לא נמצא במערכת. בדוק את מספר הטלפון ונסה שוב.";
const EMPTY_USER_TABLE_MESSAGE = "לא נמצאו משתמשים במערכת.";
const USER_TABLE_HEADER = "רמת הרשאה | שם משתמש | מספר טלפון";

export type UserManagementFlowResult =
  | { type: "text"; answer: string }
  | { type: "interactive_sent" }
  | { type: "prompt_sent"; promptText: string };

export interface ParsedAddUserInput {
  name: string;
  phone: string;
  level: PermissionLevel;
}

export interface ParsedDeleteUserInput {
  name: string;
  phone: string;
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
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter((token) => token.length > 0);
}

const USER_MANAGEMENT_CANCEL_PATTERN = /^ביטול$|^חזור$|^יציאה$/i;
export const USER_MANAGEMENT_CANCELLED_MESSAGE = "הפעולה בוטלה.";

function isUserManagementCancelCommand(query: string): boolean {
  return USER_MANAGEMENT_CANCEL_PATTERN.test(query.trim());
}

export function parseAddUserInput(raw: string): ParsedAddUserInput | null {
  const tokens = tokenize(raw);
  if (tokens.length < 3) return null;

  let levelIndex = -1;
  let parsedLevel: PermissionLevel | null = null;

  for (let i = 0; i < tokens.length; i++) {
    const rawLevel = tokens[i].toUpperCase().replace("L", "");
    if (/^[0-3]$/.test(rawLevel)) {
      const num = Number.parseInt(rawLevel, 10);
      if (isPermissionLevel(num)) {
        levelIndex = i;
        parsedLevel = num;
        break;
      }
    }
  }

  if (levelIndex === -1 || parsedLevel === null) return null;

  let phoneIndex = -1;
  let normalizedPhone: string | null = null;

  for (let i = 0; i < tokens.length; i++) {
    if (i === levelIndex) continue;
    const phone = normalizePhoneNumber(tokens[i]);
    if (phone) {
      phoneIndex = i;
      normalizedPhone = phone;
      break;
    }
  }

  if (phoneIndex === -1 || !normalizedPhone) return null;

  const nameTokens = tokens.filter((_, idx) => idx !== levelIndex && idx !== phoneIndex);
  const name = nameTokens.join(" ").trim();
  if (!name) return null;

  return { name, phone: normalizedPhone, level: parsedLevel };
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

async function sendUserManagementMenu(
  to: string,
  userLevel: PermissionLevel
): Promise<void> {
  const buttons = [
    { id: ADMIN_ACTION_ADD_USER, title: "הוסף משתמש" },
    { id: ADMIN_ACTION_DELETE_USER, title: "מחק משתמש" },
  ];
  if (isAdminRole(userLevel)) {
    buttons.push({ id: ADMIN_ACTION_LIST_USERS, title: "טבלת משתמשים" });
  }

  await sendWhatsAppInteractiveButtons({
    to,
    bodyText: "בחר את הפעולה שברצונך לבצע:",
    buttons,
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
  requesterLevel: PermissionLevel
): Promise<string> {
  const parsed = parseAddUserInput(query);
  if (!parsed) return ADD_FORMAT_RETRY;

  if (!canManagePermissionLevel(requesterLevel, parsed.level)) {
    return HIERARCHY_DENIED_MESSAGE;
  }

  const inserted = await insertAdminManagedUser(parsed.phone, parsed.name, parsed.level);
  if (!inserted) return USER_EXISTS_MESSAGE;

  await clearAdminSession(adminPhone);
  return USER_ADDED_MESSAGE;
}

async function handleDeleteUserInput(
  adminPhone: string,
  query: string,
  requesterLevel: PermissionLevel
): Promise<string> {
  const parsed = parseDeleteUserInput(query);
  if (!parsed) return DELETE_FORMAT_RETRY;

  const requesterPhone = normalizePhoneNumber(adminPhone) ?? adminPhone;
  if (parsed.phone === requesterPhone) {
    return SELF_DELETE_DENIED_MESSAGE;
  }

  const target = await getUserByPhone(parsed.phone);
  if (target && !canManagePermissionLevel(requesterLevel, target.permission_level)) {
    return HIERARCHY_DENIED_MESSAGE;
  }

  const deleted = await deleteAdminManagedUser(parsed.phone);
  if (!deleted) return USER_NOT_FOUND_MESSAGE;

  await clearAdminSession(adminPhone);
  return USER_DELETED_MESSAGE;
}

async function handleUserManagementButton(
  adminPhone: string,
  buttonId: string,
  requesterLevel: PermissionLevel
): Promise<UserManagementFlowResult> {
  if (buttonId === ADMIN_ACTION_ADD_USER) {
    await setAdminSession(adminPhone, "AWAITING_ADD_USER_DETAILS");
    return { type: "prompt_sent", promptText: ADD_USER_PROMPT };
  }

  if (buttonId === ADMIN_ACTION_DELETE_USER) {
    await setAdminSession(adminPhone, "AWAITING_DELETE_USER_DETAILS");
    return { type: "prompt_sent", promptText: DELETE_USER_PROMPT };
  }

  if (buttonId === ADMIN_ACTION_LIST_USERS) {
    if (!isAdminRole(requesterLevel)) {
      return { type: "text", answer: LIST_USERS_DENIED_MESSAGE };
    }
    const users = await getAllManagedUsers();
    return { type: "text", answer: formatUserTable(users) };
  }

  return { type: "text", answer: "" };
}

export async function resolveUserManagementFlow(input: {
  adminPhone: string;
  query: string;
  buttonId?: string;
  requesterPermissionLevel: PermissionLevel;
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

  if (input.buttonId && isUserManagementButtonId(input.buttonId)) {
    return handleUserManagementButton(
      input.adminPhone,
      input.buttonId,
      input.requesterPermissionLevel
    );
  }

  const session = await getAdminSession(input.adminPhone);

  if (
    session &&
    isUserManagementSessionMode(session.mode) &&
    isUserManagementCancelCommand(input.query)
  ) {
    await clearAdminSession(input.adminPhone);
    return { type: "text", answer: USER_MANAGEMENT_CANCELLED_MESSAGE };
  }

  if (session?.mode === "AWAITING_ADD_USER_DETAILS") {
    const answer = await handleAddUserInput(
      input.adminPhone,
      input.query,
      input.requesterPermissionLevel
    );
    // Always send the handler text (including ADD_FORMAT_RETRY) back to WhatsApp.
    return { type: "text", answer };
  }

  if (session?.mode === "AWAITING_DELETE_USER_DETAILS") {
    const answer = await handleDeleteUserInput(
      input.adminPhone,
      input.query,
      input.requesterPermissionLevel
    );
    return { type: "text", answer };
  }

  await sendUserManagementMenu(input.adminPhone, input.requesterPermissionLevel);
  return { type: "interactive_sent" };
}
