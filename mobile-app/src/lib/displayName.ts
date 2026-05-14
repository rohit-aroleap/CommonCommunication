// Name resolution: Ferra-known > manually-entered (wrapped in parens unless
// it matches Ferra) > /contacts/<phone>/name > phone fallback. Mirrors
// resolveDisplayName in index.html so a chat shows the same name across web,
// PWA, and the RN app.

import type { ChatType, ContactInfo, FerraUser } from "@/types";
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
