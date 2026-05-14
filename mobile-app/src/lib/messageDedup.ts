// Render-time dedup safety net: the /send write and the webhook echo both
// land in Firebase with the same Periskope unique id, but in different
// fields:
//   - /send-written:   periskopeUniqueId = "3EB052..."
//   - webhook-written: periskopeMsgId    = "true_{chat}_3EB052..."
// We extract the tail token from periskopeMsgId so both shapes collapse onto
// the same key, then prefer the copy that has sentByName (the trainer-
// attributed send) so "— Rohit Patel" doesn't disappear randomly.
//
// Identical logic to renderMessages() in index.html / mobile.html — keep
// them in sync; a divergence would let dupes leak through on one surface
// but not the others.

import type { Message } from "@/types";

function extractInnerId(m: Message): string | null {
  if (m.periskopeUniqueId) return m.periskopeUniqueId;
  if (m.periskopeMsgId) {
    const parts = String(m.periskopeMsgId).split("_");
    return parts[parts.length - 1] || null;
  }
  return null;
}

export function dedupMessages(list: Message[]): Message[] {
  const byId = new Map<string, Message>();
  const noId: Message[] = [];
  for (const m of list) {
    const id = extractInnerId(m);
    if (!id) {
      noId.push(m);
      continue;
    }
    const existing = byId.get(id);
    if (!existing || (m.sentByName && !existing.sentByName)) byId.set(id, m);
  }
  return [...byId.values(), ...noId].sort((a, b) => (a.ts || 0) - (b.ts || 0));
}
