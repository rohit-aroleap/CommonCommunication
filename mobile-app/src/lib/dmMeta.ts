// v1.279: dual-write DM meta to /dms/{pk}/meta/* AND /dmsIndex/{pk}/*.
// The team-DM list now subscribes to the lean /dmsIndex mirror instead
// of the full /dms subtree (which dragged every message of every thread,
// ~9 KB/record). Every DM meta write must go through here so the index
// stays current. Mirrors the web's patchDmMeta and the chatsIndex pattern.
// Fields are written FLAT under /dmsIndex/{pk}/* — no `meta` wrapper —
// matching what the AppDataContext listener wraps back into { meta }.
import { ref, update } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";

export function patchDmMeta(
  pairKey: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    updates[`${ROOT}/dms/${pairKey}/meta/${k}`] = v;
    updates[`${ROOT}/dmsIndex/${pairKey}/${k}`] = v;
  }
  return update(ref(db), updates);
}
