// Pure predicates over chat rows. Kept here (instead of inside the context
// file) so they're easy to unit-test without spinning up a React tree.

import { DAILY_GROUP_PREFIX } from "@/config";
import type { ChatRow } from "@/types";

export function isDailyGroup(r: ChatRow): boolean {
  return (
    r.chatType === "group" &&
    String(r.groupName || "").startsWith(DAILY_GROUP_PREFIX)
  );
}
