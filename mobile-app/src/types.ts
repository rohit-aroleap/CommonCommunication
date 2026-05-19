// Shape of records stored under commonComm/* in Firebase RTDB. These mirror
// the writes done by worker.js (handleWebhook, handleSend) and the desktop
// dashboard (createTicket, doSend, etc.). Treat as authoritative for the
// client; the server can write extra fields we don't model here.

export type ChatType = "user" | "group" | "business";

export interface ChatMeta {
  chatId?: string;
  chatType?: ChatType;
  phone?: string;
  contactName?: string | null;
  displayName?: string | null;
  groupName?: string | null;
  private?: boolean;
  lastMsgAt?: number;
  lastMsgPreview?: string;
  lastMsgDirection?: "in" | "out";
  lastMsgSentByName?: string | null;
}

export interface ChatRow {
  chatKey: string;
  chatId: string;
  chatType: ChatType;
  phone: string;
  explicitName: string | null;
  groupName: string | null;
  private: boolean;
  lastMsgAt: number;
  preview: string;
  direction: "in" | "out";
  sentByName: string | null;
}

export interface MediaInfo {
  url?: string;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  caption?: string | null;
}

export interface Message {
  id: string;
  direction: "in" | "out";
  text?: string;
  ts: number;
  sentByUid?: string;
  sentByName?: string | null;
  status?: "sending" | "sent" | "failed";
  periskopeMsgId?: string | null;
  periskopeUniqueId?: string | null;
  messageType?: string;
  senderPhone?: string;
  media?: MediaInfo | null;
  // v1.151 edit/delete support. Worker dual-writes these after Periskope
  // confirms the action. UI renders "edited" tag + "Message deleted"
  // placeholder accordingly.
  editedAt?: number | null;
  editedByUid?: string | null;
  editedByName?: string | null;
  deleted?: boolean | null;
  deletedAt?: number | null;
  deletedByUid?: string | null;
  deletedByName?: string | null;
  // First-edit / pre-delete snapshot kept for audit context. The mobile
  // UI doesn't show this today but the dashboard or a future history view
  // can surface it.
  originalText?: string | null;
  // v1.152 reactions. Keyed by uid (trainer reaction) or customer phone
  // (inbound reaction via webhook). One entry per person — the worker
  // overwrites on subsequent reactions and writes null for "unreact".
  reactions?: Record<
    string,
    {
      emoji: string;
      ts: number;
      byName?: string | null;
      source?: "trainer" | "customer";
    }
  > | null;
  // v1.153 reply / quote. Snapshot of the parent message at the time
  // the reply was sent — keeps the quoted card stable even if the
  // parent is edited later. Worker fills this in (forwarded from
  // mobile's send body). Bubble renders the snapshot as a small
  // quoted card above the reply's text.
  replyTo?: {
    msgKey: string;
    periskopeMsgId?: string | null;
    text: string;
    isFromMe?: boolean;
    senderName?: string | null;
  } | null;
  // v1.154 forward-to-DM. Set on the DM message we wrote when the
  // trainer forwarded a customer message into a team DM. Snapshot of
  // the original message (text-only for v1; no media forwarding yet).
  forwardedFrom?: {
    chatId?: string | null; // source customer chat
    customerName?: string | null;
    customerPhone?: string | null;
    // v1.208: source-message identifier so the recipient can tap the
    // forwarded-header card and land on the exact bubble in the source
    // chat. Historical forwards (pre v1.208) won't have this — the tap
    // still works but lands at the source chat's tail instead.
    originalMsgKey?: string | null;
    originalText: string;
    originalTs: number;
    originalDirection?: "in" | "out"; // "in" = forwarded a customer's message; "out" = forwarded our own reply
  } | null;
  // DM-specific field aliases — DM messages were written before the
  // current Message type existed. The listener inside ThreadScreen
  // normalizes these into the main fields, but we declare them here so
  // the writer doesn't have to cast.
  fromUid?: string;
  fromName?: string | null;
}

export interface Ticket {
  id: string;
  title: string;
  anchorChatId: string;
  anchorMsgKey: string;
  anchorText?: string;
  assignee: string;
  assigneeName: string;
  status: "open" | "resolved";
  createdBy: string;
  createdByName: string;
  createdAt: number;
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: number;
  resolutionNote?: string;
  reassignments?: Array<{
    from: string | null;
    fromName: string | null;
    to: string;
    toName: string;
    at: number;
    byUid: string;
    byName: string;
  }>;
}

export interface TeamUser {
  uid?: string;
  name?: string;
  email?: string;
  photoURL?: string | null;
  lastSeen?: number;
}

// Email-keyed team-member profile. Mirrors commonComm/config/teamMembers from
// the web dashboard. The phones map is the suppression list: any customer
// chat whose phone matches an entry here gets hidden from the customer
// inbox and (when reached via "New chat") redirected to an internal DM.
export interface TeamMember {
  email?: string;
  name?: string;
  phones?: Record<string, boolean>; // phone string → true
  // v1.196: when true, this trainer's chat list starts empty. They unlock
  // customers individually for 14 days via the "Add customer" flow, or
  // a teammate assigns them a ticket which unlocks the customer for the
  // ticket's lifetime. Toggled via the desktop Team modal checkbox.
  limited?: boolean;
}

// v1.196: per-user manual customer-access grants for limited trainers.
// Lives at commonComm/userGrants/{uid}/{chatKey}. grantedAt is the ms
// timestamp; access expires 14 days after that unless an open ticket
// assigned to this user keeps it active.
export interface UserGrant {
  grantedAt: number;
}

// Internal team-to-team DM thread metadata. Lives at
// commonComm/dms/{pairKey}/meta. pairKey = sorted UIDs joined by "_".
export interface DmMeta {
  participants?: Record<string, boolean>; // uid → true
  createdAt?: number;
  lastMsgAt?: number;
  lastMsgPreview?: string;
  lastMsgFromUid?: string | null;
  lastMsgFromName?: string | null;
}

// One message inside a DM thread. Direction is implicit (computed from
// fromUid vs current user). No periscopeMsgId because DMs never leave
// Firebase.
export interface DmMessage {
  id: string;
  text?: string;
  ts: number;
  fromUid?: string;
  fromName?: string | null;
}

export interface DmRow {
  pairKey: string;
  chatKey: string; // "dm:" + pairKey, for use as a navigation key
  otherUid: string;
  name: string;
  email: string;
  photoURL: string | null;
  lastMsgAt: number;
  preview: string;
  lastMsgFromUid: string | null;
  lastMsgFromName: string | null;
  unread: boolean;
}

export interface ContactInfo {
  name?: string;
  source?: string;
  seenAt?: number;
}

export interface FerraUser {
  uid?: string;
  userId?: string;
  name?: string;
  phone?: string;
  phoneNumber?: string;
  subscriptionStatus?: string;
  // Additional fields that show up in ferraHabitData/v1/users.
  // All optional so older / sparser records don't break the type check.
  age?: number;
  gender?: string;
  habitScore?: number;
  segment?: string;
  tier?: number;
  tierLabel?: string;
  streak?: { active: boolean; days: number };
  daysSinceLastSession?: number;
  lastActiveDate?: string;
  trend14d?: number;
  subscriptionDocId?: string;
  subscriptionPlanTier?: string;
  subscriptionSource?: string;
  subscriptionStartDate?: number;
  userAgeDays?: number;
  // Acquisition / UTM data — populated when the customer signed up via a
  // paid ad. Optional because organic signups won't have these.
  adSource?: string;
  adMedium?: string;
  adCampaign?: string;
  adContent?: string;
  adTerm?: string;
  landingPage?: string;
  referrer?: string;
}

// Subset of Ferra subscription columns the ferra-sync worker now writes
// to ferraSubscriptions/v1/customerDetails/{phone}. Address is the headline
// field — the rest is bonus context for the Customer Info panel.
export interface CustomerDetail {
  name?: string;
  address?: string;
  email?: string;
  status?: string;
  planTier?: string;
  startDate?: string;
  lastPaymentStatus?: string;
  lastPaymentDate?: string;
}

export type StageBucket =
  | "setup"
  | "onboarding"
  | "sa"
  | "active"
  | "offboarding";

export const DAILY_SENTINEL = "__daily_groups__";

// Per-user send-activity ping stored at userState/<uid>/sendActivity/<chatKey>.
// Powers the "Pin this?" suggestion when the current user has been actively
// messaging a chat that isn't in their favorites yet.
export interface SendActivity {
  count: number;
  lastAt: number;
}

// Quick-reply template stored at commonComm/config/templates/{id}. Managed
// in the desktop dashboard's Templates modal (admins only). Mobile reads
// them and inserts via the `/` picker in the composer. Variable substitution
// happens at insert time — see lib/templates.ts. Shape mirrors what the
// desktop side writes; "name" is the slash keyword (e.g. "welcome" → "/welcome").
export interface Template {
  name: string;
  text: string;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}
