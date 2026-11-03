import type { Db } from '../db.js';
import { claudeOffersAuto, getPermissions, runLevel } from '../agents/permissions.js';

/** The autonomy and permission mode an orchestrator's run gets from Settings (PM-419). */
export async function orchestratorRunLevel(db: Db, providerId: string) {
  return runLevel(
    getPermissions(db),
    providerId,
    providerId === 'claude' ? await claudeOffersAuto('claude') : null,
  );
}
