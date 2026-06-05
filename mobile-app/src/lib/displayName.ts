// Name resolution: Ferra-known > manually-entered (wrapped in parens unless
// it matches Ferra) > /contacts/<phone>/name > phone fallback. Mirrors
// resolveDisplayName in index.html so a chat shows the same name across web,
// PWA, and the RN app.

import type {
  ChatType,
  ContactInfo,
  CustomerDetail,
  FerraSubscription,
  FerraUser,
} from "@/types";
import { type FerraIndex, getFerraDisplayName } from "./ferra";

export interface NameOpts {
  chatType: ChatType;
  groupName?: string | null;
}

export interface NameResolverDeps {
  habitUsers: Record<string, FerraUser> | FerraUser[] | null;
  cancelledUsers: Record<string, FerraUser> | FerraUser[] | null;
  ferraIndex: FerraIndex;
  contacts: Record<string, ContactInfo>;
  // v1.267: optional — chat list shows brand-new subscribers' names from
  // these even before any habit data lands. Pre-existing callsites that
  // don't pass them still work (name resolution just stops one step
  // earlier than the web build).
  customerDetails?: Record<string, CustomerDetail> | null;
  subsByPhone?: Map<string, FerraSubscription[]> | null;
}

export function resolveDisplayName(
  phone: string,
  explicitName: string | null | undefined,
  opts: NameOpts,
  deps: NameResolverDeps,
): string {
  if (opts.chatType === "group") return opts.groupName || "Unnamed group";

  const ferra = getFerraDisplayName(
    phone,
    deps.habitUsers,
    deps.cancelledUsers,
    deps.ferraIndex,
    deps.customerDetails ?? null,
    deps.subsByPhone ?? null,
  );
  const manual = explicitName && String(explicitName).trim();
  if (manual) {
    if (ferra && manual.toLowerCase() === ferra.toLowerCase()) return ferra;
    return `(${manual})`;
  }
  if (ferra) return ferra;
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits && deps.contacts[digits]?.name) return deps.contacts[digits].name!;
  return phone || "?";
}

export function avatarInitial(name: string): string {
  return (
    String(name || "?")
      .replace(/[()]/g, "")
      .trim()
      .charAt(0)
      .toUpperCase() || "?"
  );
}
