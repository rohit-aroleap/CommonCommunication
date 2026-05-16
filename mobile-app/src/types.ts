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
