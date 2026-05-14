// Firebase RTDB keys forbid . # $ [ ] / — replace with underscore. Must match
// encodeKey() in worker.js exactly; otherwise reads / writes disagree about
// where a chat lives in the tree.

export function encodeKey(k: string): string {
  return String(k ?? "").replace(/[.#$\[\]\/]/g, "_");
}

// Reverse the @c.us / @g.us suffix mangling done by encodeKey, so we can
// reconstruct the canonical chat_id Periskope expects.
export function chatKeyToChatId(key: string): string {
  return String(key ?? "")
    .replace(/@c_us$/, "@c.us")
    .replace(/@g_us$/, "@g.us");
}
