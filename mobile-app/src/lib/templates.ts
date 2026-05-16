// Quick-reply template helpers. Templates live at commonComm/config/templates
// and are managed from the desktop dashboard (Templates modal). Mobile reads
// them and inserts via `/` in the composer — see ThreadScreen.tsx.
//
// Variables supported (must match the desktop substituteTemplateVars in
// index.html, minus {tag} which is desktop-only because mobile doesn't load
// the Ferra subscription tag mapping today):
//   {name}        — customer's full display name (contact / Ferra / phone)
//   {firstName}   — first word of {name}
//   {phone}       — customer phone (digits only, from chat meta)
//   {trainerName} — currently signed-in trainer's display name
//
// Keep variable resolution defensive — meta fields are optional, so any
// missing value substitutes to "" rather than printing "{name}" to the
// customer.

import type { ChatMeta, Template } from "@/types";

export interface TemplateContext {
  meta?: ChatMeta | null;
  trainerName?: string;
  // The desktop side resolves contactName via the chat's displayName / Ferra
  // index too; we accept a pre-resolved display name from the caller so the
  // mobile picker can reuse whatever the thread header is already showing.
  resolvedDisplayName?: string;
}

export function substituteTemplateVars(
  text: string,
  ctx: TemplateContext,
): string {
  const meta = ctx.meta || {};
  const fullName =
    ctx.resolvedDisplayName ||
    meta.contactName ||
    meta.displayName ||
    meta.phone ||
    "";
  const firstName = String(fullName).split(/\s+/)[0] || "";
  const phone = meta.phone || "";
  const trainer = ctx.trainerName || "";
  return String(text || "")
    .replace(/\{name\}/g, fullName)
    .replace(/\{firstName\}/g, firstName)
    .replace(/\{phone\}/g, phone)
    .replace(/\{trainerName\}/g, trainer);
}

// Filter + sort templates for the slash picker. Query is the text the user
// typed AFTER the leading `/`, lowercased and trimmed by the caller. Empty
// query → all templates. Match against `name` (the slash keyword) only —
// matching the body text would surface unexpected results when the user is
// trying to type a real message that happens to share words with a template.
export function filterTemplates(
  templates: Record<string, Template>,
  query: string,
): Array<{ id: string } & Template> {
  const all = Object.entries(templates || {}).map(([id, t]) => ({
    id,
    ...(t || ({} as Template)),
  }));
  const q = (query || "").toLowerCase().trim();
  const matches = q
    ? all.filter((t) => (t.name || "").toLowerCase().includes(q))
    : all;
  matches.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return matches;
}
