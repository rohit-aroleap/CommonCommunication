// Helpers that look up subscription state / display name from the shared
// ferraSubscriptions/v1 and ferraHabitData/v1/* feeds. These are read-only
// reflections of data the central ferra-sync worker writes; we never write
// to those paths from the mobile app.

import type { FerraUser } from "@/types";

export function normalizeFerraPhone(p: string | null | undefined): string {
  let n = String(p ?? "").replace(/\D/g, "");
  n = n.replace(/^0+/, "");
  if (n.length === 10) n = "91" + n;
  return n;
}

export interface FerraIndex {
  phoneToUid: Record<string, string>;
  cancelledPhones: Set<string>;
  phoneToStatus: Record<string, string>;
}

export function buildFerraIndex(
  habitUsers: Record<string, FerraUser> | FerraUser[] | null,
  cancelledUsers: Record<string, FerraUser> | FerraUser[] | null,
): FerraIndex {
  const phoneToUid: Record<string, string> = {};
  const cancelledPhones = new Set<string>();
  const phoneToStatus: Record<string, string> = {};

  const collect = (
    src: Record<string, FerraUser> | FerraUser[] | null,
    isCancelled: boolean,
  ): void => {
    if (!src) return;
    const list = Array.isArray(src) ? src : Object.values(src);
    for (const u of list) {
      if (!u) continue;
      const norm = normalizeFerraPhone(u.phone || u.phoneNumber || "");
      if (!norm) continue;
      if (isCancelled) cancelledPhones.add(norm);
      const uid = u.uid || u.userId;
      if (uid && !isCancelled) phoneToUid[norm] = uid;
      if (u.subscriptionStatus) {
        phoneToStatus[norm] = String(u.subscriptionStatus).toUpperCase();
      }
    }
  };
  collect(habitUsers, false);
  collect(cancelledUsers, true);
  return { phoneToUid, cancelledPhones, phoneToStatus };
}

// Pull the full Ferra user record for a phone — used by the customer info
// screen to show habit / subscription / acquisition details.
export function getFerraUserByPhone(
  phone: string,
  habitUsers: Record<string, FerraUser> | FerraUser[] | null,
  cancelledUsers: Record<string, FerraUser> | FerraUser[] | null,
  index: FerraIndex,
): FerraUser | null {
  const norm = normalizeFerraPhone(phone);
  if (!norm) return null;
  const uid = index.phoneToUid[norm];
  if (uid && habitUsers) {
    if (Array.isArray(habitUsers)) {
      const found = habitUsers.find(
        (u) => u && (u.uid === uid || u.userId === uid),
      );
      if (found) return found;
    } else if (habitUsers[uid]) {
      return habitUsers[uid];
    }
  }
  // Fall back to a phone-match scan across both maps.
  const scan = (
    src: Record<string, FerraUser> | FerraUser[] | null,
  ): FerraUser | null => {
    if (!src) return null;
    const list = Array.isArray(src) ? src : Object.values(src);
    for (const u of list) {
      if (!u) continue;
      if (normalizeFerraPhone(u.phone || u.phoneNumber || "") === norm) {
        return u;
      }
    }
    return null;
  };
  return scan(habitUsers) || scan(cancelledUsers);
}

export function getFerraDisplayName(
  phone: string,
  habitUsers: Record<string, FerraUser> | FerraUser[] | null,
  cancelledUsers: Record<string, FerraUser> | FerraUser[] | null,
  index: FerraIndex,
): string | null {
  const norm = normalizeFerraPhone(phone);
  if (!norm) return null;
  const uid = index.phoneToUid[norm];
  if (uid && habitUsers) {
    if (Array.isArray(habitUsers)) {
      const found = habitUsers.find(
        (u) => u && (u.uid === uid || u.userId === uid),
      );
      if (found?.name) return found.name;
    } else if (habitUsers[uid]?.name) {
      return habitUsers[uid].name!;
    }
  }
  if (cancelledUsers) {
    const list = Array.isArray(cancelledUsers)
      ? cancelledUsers
      : Object.values(cancelledUsers);
    for (const u of list) {
      if (!u) continue;
      if (normalizeFerraPhone(u.phone || u.phoneNumber || "") === norm) {
        return u.name || null;
      }
    }
  }
  return null;
}
