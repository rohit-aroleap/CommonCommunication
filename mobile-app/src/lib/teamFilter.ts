// v1.188: shared orphan-team-user filter. The Firebase path
// commonComm/users/{uid} keeps records of everyone who has ever signed
// in — including people who were later removed from the team allowlist.
// Anywhere that lists "current teammates" should filter those out using
// the same rule: an email is "current" if it's in /config/teamMembers OR
// it's a hard-coded bootstrap admin.
//
// Used by:
//   - TeamScreen.tsx (Team tab list)
//   - CreateTicketModal.tsx (assignee picker)
//   - ReassignModal.tsx (assignee picker)
//   - ThreadScreen.tsx (@ mention candidate list)

import { BOOTSTRAP_ADMINS } from "@/config";
import type { TeamUser, TeamMember } from "@/types";

export function buildAllowedEmailSet(
  teamMembers: Record<string, TeamMember>,
): Set<string> {
  const out = new Set<string>();
  for (const m of Object.values(teamMembers || {})) {
    if (m?.email) out.add(m.email.toLowerCase());
  }
  for (const a of BOOTSTRAP_ADMINS) out.add(a.toLowerCase());
  return out;
}

export function isAllowedTeamEmail(
  email: string,
  allowed: Set<string>,
): boolean {
  // Empty email = write-race during sign-in; render will reconcile on the
  // next snapshot. Don't drop the row in that case — better a missing name
  // briefly than a dropped teammate forever.
  if (!email) return true;
  return allowed.has(String(email).toLowerCase());
}

// Returns a new teamUsers record with orphan entries removed.
export function filterAllowedTeamUsers(
  teamUsers: Record<string, TeamUser>,
  teamMembers: Record<string, TeamMember>,
): Record<string, TeamUser> {
  const allowed = buildAllowedEmailSet(teamMembers);
  const out: Record<string, TeamUser> = {};
  for (const [uid, u] of Object.entries(teamUsers || {})) {
    if (!u) continue;
    if (isAllowedTeamEmail(u.email || "", allowed)) out[uid] = u;
  }
  return out;
}
