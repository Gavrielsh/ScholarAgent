import { MAX_PRIVILEGE_LEVEL, MIN_CORPUS_WRITE_LEVEL } from "@/lib/core/db/accessLevel";
import type { PermissionLevel } from "@/lib/security/auth/types";

export const ADMIN_PERMISSION_LEVEL: PermissionLevel = MAX_PRIVILEGE_LEVEL;
export const MANAGER_PERMISSION_LEVEL: PermissionLevel = MIN_CORPUS_WRITE_LEVEL;
