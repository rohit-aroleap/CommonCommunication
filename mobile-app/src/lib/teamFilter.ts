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

// v1.195: shared name resolver used everywhere we display a teammate's
// label. Priority:
//   1. Admin-curated name in /config/teamMembers/{emailKey}/name (set
//      via the desktop Team modal). Authoritative — if an admin set
//      it, that's the name we want.
//   2. /users/{uid}/name from Firebase Auth (displayName at sign-in
//      time, falls back to email itself when no displayName set).
//   3. Raw email.
//   4. uid as last resort.
//
// Trims whitespace and treats empty/whitespace-only strings as unset.
// teamMembers keys aren't predictable by uid → email lookup is by
// email scan, but the map is small (single-digit teammates) so this
// stays O(n) trivially.
export function resolveTeammateName(
  uid: string,
  email: string | undefined | null,
  teamUsers: Record<string, TeamUser>,
  teamMembers: Record<string, TeamMember>,
): string {
  const emailLower = (email || "").toLowerCase();
  if (emailLower) {
    for (const m of Object.values(teamMembers || {})) {
      if (!m?.email) continue;
      if (m.email.toLowerCase() !== emailLower) continue;
      const n = (m.name || "").trim();
      if (n) return n;
      break;
    }
  }
  const u = teamUsers[uid];
  const authName = (u?.name || "").trim();
  if (authName) return authName;
  if (email) return email;
  return uid || "(unknown)";
}

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

// Returns a new teamUsers record with orphan entries removed AND duplicate
// emails collapsed (v1.191).
//
// Why dedupe by email: when a Firebase Auth user is deleted then recreated
// with the same email, you end up with two /users/{uid} records sharing an
// email. Both pass the allowlist check, so both showed in the assignee
// pickers (trainer reported "Rohit Patel + rohit@aroleap.com (me)" for
// what should have been a single self-entry).
//
// Tiebreaker for duplicates:
//   1. preferUid wins (so the currently-signed-in user's record always
//      survives over its own orphan)
//   2. Otherwise the entry with a non-empty trimmed name wins (assumed to
//      be the "real" record vs. a half-initialized one)
//   3. Otherwise the lexicographically-smaller uid wins (stable arbitrary)
export function filterAllowedTeamUsers(
  teamUsers: Record<string, TeamUser>,
  teamMembers: Record<string, TeamMember>,
  options?: { preferUid?: string },
): Record<string, TeamUser> {
  const allowed = buildAllowedEmailSet(teamMembers);
  const preferUid = options?.preferUid;

  // First pass — drop orphans (records whose email is no longer allowlisted).
  const filtered: Array<[string, TeamUser]> = [];
  for (const [uid, u] of Object.entries(teamUsers || {})) {
    if (!u) continue;
    if (isAllowedTeamEmail(u.email || "", allowed)) filtered.push([uid, u]);
  }

  // Sort so the preferred entries come first — first-seen-email then wins.
  filtered.sort(([uidA, uA], [uidB, uB]) => {
    if (uidA === preferUid && uidB !== preferUid) return -1;
    if (uidB === preferUid && uidA !== preferUid) return 1;
    const aHasName = !!(uA.name && uA.name.trim());
    const bHasName = !!(uB.name && uB.name.trim());
    if (aHasName !== bHasName) return aHasName ? -1 : 1;
    return uidA.localeCompare(uidB);
  });

  const seenEmails = new Set<string>();
  const out: Record<string, TeamUser> = {};
  for (const [uid, u] of filtered) {
    const email = (u.email || "").toLowerCase();
    if (email) {
      if (seenEmails.has(email)) continue;
      seenEmails.add(email);
    }
    out[uid] = u;
  }
  return out;
}
