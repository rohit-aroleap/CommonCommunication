// ──────────────────────────────────────────────────────────────────
// Shared phone normalizer (copied from
// https://github.com/rohit-aroleap/ferra-periskope-gateway/blob/main/lib/normalize-phone.js
// — version 1.0.0). DO NOT EDIT HERE. Update upstream, bump VERSION
// there, then copy this block again.
//
// Canonical format: E.164 without the leading `+` sign.
//   Indian customer:  "919876543210"
//
// Matches:
//   • ferra-periskope-gateway → /periskopeSendLog/v1/byChatKind/{chatKey}/
//   • ferra-sync               → /ferraSubscriptions/v1/byPhone keys
//
// All Aroleap customers today are Indian (+91). The 10-digit-prefix
// shortcut assumes that.
// ──────────────────────────────────────────────────────────────────

export const PHONE_NORMALIZER_VERSION = "1.0.0";

/**
 * Normalize a raw phone string to canonical E.164-without-+ format.
 *
 * Best-effort: strips formatting, removes the WhatsApp "@c.us" DM
 * suffix, drops leading 0s in front of a country code, prepends "91"
 * to 10-digit Indian numbers. Returns "" if input is unrecoverable.
 *
 * Group chat IDs (anything ending @g.us or @broadcast) intentionally
 * return "". Use normalizeChatKey() if you want to dedup-key across
 * DMs and groups uniformly.
 */
export function normalizePhone(raw: string | null | undefined): string {
  if (raw == null) return "";
  let s = String(raw).trim();

  // Group chats and broadcast lists are not phones.
  if (/@g\.us$/i.test(s) || /@broadcast$/i.test(s)) return "";

  // Strip WhatsApp DM-style suffix ("@c.us", "@s.whatsapp.net", etc.)
  s = s.replace(/@[a-z0-9.]+$/i, "");

  // Keep only digits
  s = s.replace(/\D/g, "");

  // Strip leading 0(s) that prefix a country code, e.g. "091..." → "91..."
  while (s.startsWith("0") && s.length > 10) {
    s = s.slice(1);
  }

  // Indian 10-digit shortcut → prepend country code
  if (s.length === 10) s = "91" + s;

  // Plausible E.164 length: 11–15 digits. Anything outside is junk.
  if (s.length < 11 || s.length > 15) return "";

  return s;
}

/**
 * Normalize a chat key (DM phone OR group ID OR broadcast list).
 *   "919876543210@c.us"    → "919876543210"
 *   "120363xxx@g.us"       → "120363xxx"
 *   "+91 98765-43210"      → "919876543210"
 */
export function normalizeChatKey(raw: string | null | undefined): string {
  if (raw == null) return "";
  const s = String(raw).trim();

  // Groups + broadcasts: strip suffix, keep digits.
  if (/@g\.us$/i.test(s) || /@broadcast$/i.test(s)) {
    return s.replace(/@.*$/, "").replace(/\D/g, "");
  }

  // Otherwise treat as a phone.
  return normalizePhone(s);
}

/**
 * Strict validity check. Returns true only if the input normalizes to
 * a 12-digit Indian number (starts with 91, 12 total digits).
 */
export function isValidPhone(raw: string | null | undefined): boolean {
  const p = normalizePhone(raw);
  return p.length === 12 && p.startsWith("91");
}

/**
 * Multiple useful representations of a canonical phone, for compatibility
 * with code that stores phones in different shapes.
 */
export function phoneVariants(raw: string | null | undefined): {
  canonical: string;
  withPlus: string;
  last10: string;
  k10: string;
  chatId_c: string;
} | null {
  const c = normalizePhone(raw);
  if (!c) return null;
  const last10 = c.length >= 10 ? c.slice(-10) : c;
  return {
    canonical: c,
    withPlus: "+" + c,
    last10,
    k10: last10,
    chatId_c: c + "@c.us",
  };
}

/**
 * Format a canonical phone for human display.
 *   formatPhoneDisplay("919876543210") = "+91 98765-43210"
 */
export function formatPhoneDisplay(raw: string | null | undefined): string {
  const c = normalizePhone(raw);
  if (!c) return "";
  if (c.length === 12 && c.startsWith("91")) {
    return `+91 ${c.slice(2, 7)}-${c.slice(7)}`;
  }
  return "+" + c;
}

/**
 * Return true if two raw phone strings refer to the same person,
 * regardless of their storage format. Useful for cross-dashboard joins.
 */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizePhone(a);
  if (!na) return false;
  return na === normalizePhone(b);
}
