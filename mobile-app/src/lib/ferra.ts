// Helpers that look up subscription state / display name from the shared
// ferraSubscriptions/v1 and ferraHabitData/v1/* feeds. These are read-only
// reflections of data the central ferra-sync worker writes; we never write
// to those paths from the mobile app.

import type { CustomerDetail, FerraSubscription, FerraUser } from "@/types";
// v1.241: phone normalization delegates to the shared canonical helper
// (ferra-periskope-gateway/lib/normalize-phone.js v1.0.0). Same canonical
// 12-digit output for happy-path inputs; more robust on edge cases
// (WhatsApp @c.us suffixes, group chats, null inputs, leading 0s at
// uncertain positions). Re-exported under the legacy `normalizeFerraPhone`
// name so every existing import keeps working without churn.
import { normalizePhone as _canonicalNormalize } from "@/lib/normalizePhone";

export function normalizeFerraPhone(p: string | null | undefined): string {
  return _canonicalNormalize(p);
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
  // v1.267: optional subscription-side fallbacks. New subscribers (paid,
  // ACTIVE, but no workouts yet) are absent from ferraHabitData/v1/users
  // and would otherwise show as just the phone number in the chat list.
  // The Ferra-sync worker writes them to customerDetails immediately on
  // payment, well before first workout — so we fall through to that feed.
  customerDetails?: Record<string, CustomerDetail> | null,
  subsByPhone?: Map<string, FerraSubscription[]> | null,
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
  // v1.267: customerDetails fallback — richer/canonical name field, keyed
  // by canonical phone, populated by ferra-sync from the subscriptions
  // CSV at payment time.
  const detail = customerDetails?.[norm];
  if (detail?.name) return detail.name;
  // v1.267: bySubscription fallback — last resort, useful if customerDetails
  // hasn't been backfilled for an older subscription.
  if (subsByPhone) {
    const subs = subsByPhone.get(norm);
    if (subs && subs.length) {
      for (const s of subs) {
        if (
          s?.customerName &&
          normalizeFerraPhone(s.customerPhone || "") === norm
        ) {
          return s.customerName;
        }
      }
      for (const s of subs) {
        const phones = s?.memberPhones || [];
        const names = s?.memberNames || [];
        for (let i = 0; i < phones.length; i++) {
          if (normalizeFerraPhone(phones[i] || "") === norm && names[i]) {
            return names[i]!;
          }
        }
      }
      if (subs[0]?.customerName) return subs[0].customerName;
    }
  }
  return null;
}
