// Thin wrappers over the Cloudflare Worker endpoints. The Worker is the
// single backend — the mobile app calls it for sends, AI summaries, and
// push-token registration. Same surface as the PWA in mobile.html.

// expo-file-system 18+ split into legacy / new APIs. We use the legacy
// readAsStringAsync + EncodingType.Base64 pair to mirror the existing call
// sites in ThreadScreen and CustomerInfoScreen.
import * as FileSystem from "expo-file-system/legacy";

import { WORKER_URL } from "@/config";

export interface SendBody {
  chatId: string;
  phone: string;
  message: string;
  sentByUid: string;
  sentByName: string;
  localMsgId: string;
  // v1.130: UIDs of teammates mentioned in the message body. The worker
  // pings them regardless of ticket/favorite status — @ is an explicit
  // "look at this" signal that overrides the strict targeting rules.
  mentions?: string[];
  // v1.225: media accepts EITHER inline base64 (`filedata`) OR a public
  // URL (`url`). Periskope's /message/send treats both the same way;
  // when `url` is set the worker hands it through and Periskope fetches
  // the file itself. This is how template-media on mobile sends — the
  // R2 URL stored on the template doesn't need to be re-downloaded.
  media?: {
    type: "image" | "video" | "audio" | "document";
    filename: string;
    mimetype: string;
    filedata?: string; // base64 — used by upload-then-send paths
    url?: string;      // public URL — used by template-media path
  };
  // v1.153 reply / quote. When set, the worker passes
  // reply_to_message_id to Periskope and stores a snapshot of the parent
  // on the new message record so the bubble can render a quoted card.
  replyTo?: {
    msgKey: string;
    periskopeMsgId?: string | null;
    text: string;
    isFromMe?: boolean;
    senderName?: string | null;
    // v1.295: cross-chat reply ("Reply privately to customer" from a
    // group). When set, the worker stores it on the new message's
    // replyTo snapshot and skips quoting the parent to Periskope (can't
    // quote across chats), so the bubble can deep-link back to the group.
    sourceChatKey?: string;
  };
}

export async function sendMessage(body: SendBody): Promise<Response> {
  return fetch(`${WORKER_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface WatiTemplate {
  name: string;
  status?: string;
  category?: string;
  language?: string;
  bodyText?: string;
  paramCount?: number;
}

export interface WatiSession {
  isOpen: boolean;
  lastInboundAt?: number | null;
  openUntil?: number | null;
}

export interface WatiMessage {
  id: string;
  channel?: "wati";
  direction: "in" | "out";
  text?: string;
  ts: number;
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  templateName?: string | null;
}

export async function fetchWatiTemplates(): Promise<WatiTemplate[]> {
  const res = await fetch(`${WORKER_URL}/wati/templates`);
  const j = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    templates?: WatiTemplate[];
    error?: string;
  };
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j.templates || [];
}

export async function fetchWatiMessages(phone: string): Promise<{
  messages: WatiMessage[];
  session: WatiSession;
}> {
  const res = await fetch(`${WORKER_URL}/wati/messages?phone=${encodeURIComponent(phone)}&limit=50`);
  const j = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    messages?: WatiMessage[];
    session?: WatiSession;
    error?: string;
  };
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return {
    messages: j.messages || [],
    session: j.session || { isOpen: false },
  };
}

export async function sendWatiTemplate(body: {
  phone: string;
  templateName: string;
  parameters?: Record<string, string>;
  sentByUid?: string;
  sentByName?: string;
}): Promise<Response> {
  return fetch(`${WORKER_URL}/wati/send-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function sendWatiSession(body: {
  phone: string;
  message: string;
  sentByUid?: string;
  sentByName?: string;
}): Promise<Response> {
  return fetch(`${WORKER_URL}/wati/send-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// v1.280: Exotel click-to-call. The worker rings the trainer's own phone
// (looked up server-side from the exotelAgents allowlist) then bridges to
// the customer. No in-app audio — the call lands on the trainer's real
// phone line, so this is just a fire-and-forget trigger.
export async function exotelCall(body: {
  customerPhone: string;
  byUid: string;
  byEmail: string;
  byName: string;
}): Promise<{ ok: boolean; error?: string; ringing?: string }> {
  try {
    const res = await fetch(`${WORKER_URL}/exotel-call`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      const reason =
        j?.error === "exotel_not_configured"
          ? "Calling isn't set up yet."
          : j?.error === "not_authorized"
            ? "Your account isn't enabled for calling."
            : j?.detail
              ? JSON.stringify(j.detail)
              : j?.error || `HTTP ${res.status}`;
      return { ok: false, error: reason };
    }
    return { ok: true, ringing: j.ringing };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// v1.151: edit a previously-sent WhatsApp message. The worker calls
// Periskope's edit endpoint then patches Firebase with the new text +
// editedAt marker. Returns the worker's JSON response so the caller can
// surface a toast on failure (most commonly "edit window expired" from
// Periskope when the message is older than ~15 min).
export interface EditMessageBody {
  chatKey: string;
  msgKey: string;
  periskopeMsgId: string;
  newText: string;
  editedByUid: string;
  editedByName: string;
}
export async function editMessage(body: EditMessageBody): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  details?: unknown;
}> {
  let res: Response;
  try {
    res = await fetch(`${WORKER_URL}/edit-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error)?.message || e) };
  }
  const j = (await res.json().catch(() => ({}))) as {
    error?: string;
    details?: unknown;
  };
  if (!res.ok) return { ok: false, status: res.status, error: j?.error, details: j?.details };
  return { ok: true, status: res.status };
}

// v1.151: delete a previously-sent WhatsApp message ("for everyone").
// Same pattern as editMessage — worker calls Periskope, patches Firebase
// to tombstone the record (sets deleted: true + deletedAt), and the UI
// renders a "Message deleted" placeholder in place of the original.
// v1.152: react to a message (👍 ❤️ 😂 etc.). Empty emoji = remove the
// caller's existing reaction. WhatsApp model — one reaction per person
// per message; sending a new one replaces the prior. Worker calls
// Periskope's reaction endpoint then patches Firebase with the result.
export interface ReactToMessageBody {
  chatKey: string;
  msgKey: string;
  periskopeMsgId: string;
  emoji: string; // empty string to remove
  reactedByUid: string;
  reactedByName: string;
}
export async function reactToMessage(body: ReactToMessageBody): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  details?: unknown;
}> {
  let res: Response;
  try {
    res = await fetch(`${WORKER_URL}/react-to-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error)?.message || e) };
  }
  const j = (await res.json().catch(() => ({}))) as {
    error?: string;
    details?: unknown;
  };
  if (!res.ok) return { ok: false, status: res.status, error: j?.error, details: j?.details };
  return { ok: true, status: res.status };
}

export interface DeleteMessageBody {
  chatKey: string;
  msgKey: string;
  periskopeMsgId: string;
  deletedByUid: string;
  deletedByName: string;
}
export async function deleteMessage(body: DeleteMessageBody): Promise<{
  ok: boolean;
  status: number;
  error?: string;
  details?: unknown;
}> {
  let res: Response;
  try {
    res = await fetch(`${WORKER_URL}/delete-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, status: 0, error: String((e as Error)?.message || e) };
  }
  const j = (await res.json().catch(() => ({}))) as {
    error?: string;
    details?: unknown;
  };
  if (!res.ok) return { ok: false, status: res.status, error: j?.error, details: j?.details };
  return { ok: true, status: res.status };
}

export async function fetchChatInfo(chatId: string): Promise<void> {
  // Best-effort: backfill missing groupName / member names. Failures are
  // non-fatal — the chat list will simply show "Unnamed group" until next try.
  try {
    await fetch(`${WORKER_URL}/fetch-chat-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId }),
    });
  } catch {
    /* swallow */
  }
}

export interface SummaryResponse {
  summary?: string;
  count?: number;
  total?: number;
  error?: string;
}

export async function summarize(chatId: string): Promise<SummaryResponse> {
  const res = await fetch(`${WORKER_URL}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId }),
  });
  const j = (await res.json().catch(() => ({}))) as SummaryResponse;
  if (!res.ok) return { error: j?.error || `HTTP ${res.status}` };
  return j;
}

// Resolves a Periskope-hosted media URL through the Worker proxy so requests
// carry the right auth headers. Used for <Image source={{ uri }}> in bubbles.
//
// v1.176: DM attachments live on the worker itself at /dm-media/<key>
// (R2-backed). Those are already on the worker domain, no proxy hop
// needed — skip them. Old v1.174 firebasestorage URLs still in the DB
// continue to work via the worker /media allow-list.
export function mediaProxyUrl(url: string): string {
  if (url.startsWith(WORKER_URL + "/dm-media/")) return url;
  return `${WORKER_URL}/media?u=${encodeURIComponent(url)}`;
}

// v1.212: Triggers a one-shot Ferra refresh. The Ferra-sync worker pulls
// the latest subscription / habit data from Ferra's backend and rewrites
// ferraSubscriptions/v1 + ferraHabitData/v1 in Firebase. The Firebase
// listener already attached in AppDataContext picks up the new data
// (including the bumped uploadedAt) automatically — caller doesn't need
// to await or refresh anything afterwards.
//
// This is the SAME endpoint the desktop dashboard's ↻ button hits (see
// FERRA_SYNC_WORKER constant in index.html). Idempotent — running it
// twice in a row just refreshes twice in a row. Fire-and-forget from
// the UI's perspective; we still return the response so callers can
// surface "synced" vs "failed" toast if they want.
const FERRA_SYNC_WORKER =
  "https://ferra-sync.rohitpatel-mailid297.workers.dev/";
export async function refreshFerraNow(): Promise<{ ok: boolean }> {
  try {
    const r = await fetch(FERRA_SYNC_WORKER, { method: "POST" });
    const j = await r.json().catch(() => ({}));
    return { ok: !!(r.ok && j?.ok !== false) };
  } catch {
    return { ok: false };
  }
}

// v1.236: upload an SA session recording captured on the phone. Posts the
// audio file to the worker's existing /sa-upload endpoint (same one used
// by the desktop dashboard), which creates the saSession Firebase record,
// stores the audio in R2, and kicks off the Groq Whisper transcription
// job in the background. The trainer doesn't need to wait — the
// transcript flips into the saSession panel via the existing Firebase
// listener when it's ready.
//
// File size: with the 48 kbps mono AAC recording options + 60-min
// auto-split, every individual upload is well under Groq's 25 MB cap.
// No multipart / chunking complexity needed on the mobile side.
export async function uploadSaRecording(body: {
  fileUri: string;
  chatKey: string;
  uploadedByUid: string;
  uploadedByName: string;
  fileName?: string;
}): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const form = new FormData();
    // expo-audio writes to a file:// path. FormData on React Native
    // accepts the { uri, name, type } shape and uploads as multipart.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form.append("file", {
      uri: body.fileUri,
      name: body.fileName || "sa-session.m4a",
      type: "audio/mp4",
    } as any);
    form.append("chatKey", body.chatKey);
    form.append("uploadedByUid", body.uploadedByUid);
    form.append("uploadedByName", body.uploadedByName);
    const r = await fetch(`${WORKER_URL}/sa-upload`, {
      method: "POST",
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) {
      return { ok: false, error: j?.error || `HTTP ${r.status}` };
    }
    return { ok: true, sessionId: j?.sessionId };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// v1.256: meetings — internal team recording with transcription + Dropbox.
// Mobile uses a simpler single-file upload path than the web (no chunking),
// which caps mobile recordings at ~25 MB (≈3 hr at 24 kbps). For longer
// meetings, recommend the web flow which splits browser-side.
export async function createMeeting(body: {
  name: string;
  attendees: Array<{ uid: string; name: string; email: string }>;
  createdByUid: string;
  createdByName: string;
}): Promise<{ ok: boolean; meetingId?: string; name?: string; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/meeting-create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true, meetingId: j.meetingId, name: j.name };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function uploadMeetingSingleChunk(body: {
  meetingId: string;
  fileUri: string;
  fileName: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const form = new FormData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form.append("file", {
      uri: body.fileUri,
      name: body.fileName,
      type: "audio/m4a",
    } as any);
    form.append("meetingId", body.meetingId);
    form.append("chunkIndex", "0");
    form.append("totalChunks", "1");
    const r = await fetch(`${WORKER_URL}/meeting-upload-chunk`, {
      method: "POST",
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// v1.256: get a temporary Dropbox upload link for a meeting. Mobile uses
// the returned URL to upload the recorded audio directly to Dropbox,
// then calls setMeetingDropbox to register the path.
export async function getMeetingDropboxUrl(body: {
  meetingId: string;
  fileExt: string;
}): Promise<{ ok: boolean; url?: string; path?: string; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/meeting-dropbox-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true, url: j.url, path: j.path };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function setMeetingDropbox(body: {
  meetingId: string;
  dropboxPath: string;
  sizeBytes?: number;
  durationSec?: number;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/meeting-set-dropbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function deleteMeeting(meetingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/meeting-delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function summarizeMeeting(meetingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/meeting-summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// v1.259: retry transcription on a meeting whose original transcription
// died mid-way (worker isolate killed by a deploy). Looks up chunks in
// R2 and re-runs the transcription routine.
export async function retryMeetingTranscribe(meetingId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/meeting-retry-transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ meetingId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// v1.249: local-only SA transcription. Audio file stays on the tablet —
// this just hands the bytes to the worker for one transcription pass.
// Idempotent on clientSessionId, so a queue-driven retry pings the same
// endpoint until it succeeds without creating duplicate saSession records.
//
// v1.251: added customerName + dropboxFolderName + dropboxFileName so the
// worker can build the per-customer Dropbox path and denormalize the
// customer name onto the saSession record.
export async function transcribeSaRecordingLocal(body: {
  fileUri: string;
  chatKey: string;
  uploadedByUid: string;
  uploadedByName: string;
  clientSessionId: string;
  fileName?: string;
  durationSec?: number | null;
  customerName?: string;
  dropboxFolderName?: string;
  dropboxFileName?: string;
}): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  try {
    const form = new FormData();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    form.append("file", {
      uri: body.fileUri,
      name: body.fileName || `sa-${body.clientSessionId}.m4a`,
      type: "audio/m4a",
    } as any);
    form.append("chatKey", body.chatKey);
    form.append("uploadedByUid", body.uploadedByUid);
    form.append("uploadedByName", body.uploadedByName);
    form.append("clientSessionId", body.clientSessionId);
    if (body.durationSec != null) {
      form.append("durationSec", String(body.durationSec));
    }
    if (body.customerName) form.append("customerName", body.customerName);
    if (body.dropboxFolderName) form.append("dropboxFolderName", body.dropboxFolderName);
    if (body.dropboxFileName) form.append("dropboxFileName", body.dropboxFileName);
    const r = await fetch(`${WORKER_URL}/sa-transcribe-local`, {
      method: "POST",
      body: form,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.ok === false) {
      return { ok: false, error: j?.error || `HTTP ${r.status}` };
    }
    return { ok: true, sessionId: j?.sessionId };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

// v1.205: notify a teammate that they've just been assigned a ticket.
// Called from CreateTicketModal (type: "created") and ReassignModal
// (type: "reassigned"). The worker skips the push if assigneeUid ===
// fromUid (no self-pinging). Best-effort; failures swallowed.
export async function notifyTicketAssignee(body: {
  ticketId: string;
  assigneeUid: string;
  assigneeName: string;
  fromUid: string;
  fromName: string;
  chatId: string;
  customerName: string;
  title: string;
  type: "created" | "reassigned";
}): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/notify-ticket-assignee`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* swallow — push is best-effort */
  }
}

// Fire a push notification for a freshly-sent DM. The message itself is
// already in Firebase by the time we call this — the worker just fans out
// to the recipient's Expo tokens. Best-effort; failures don't roll back.
export async function notifyDm(body: {
  pairKey: string;
  fromUid: string;
  fromName: string;
  toUid: string;
  text: string;
}): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/dm-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    /* swallow — push is best-effort */
  }
}

// Registers an Expo push token against the signed-in user's uid so the Worker
// knows where to deliver inbound-message pings. The Worker stores at
// commonComm/pushTokens/{uid}/{tokenKey}.
export async function registerPushToken(
  uid: string,
  token: string,
  platform: "ios" | "android",
): Promise<void> {
  try {
    await fetch(`${WORKER_URL}/register-push-token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid, token, platform }),
    });
  } catch {
    /* swallow — push will reconnect on next sign-in */
  }
}

// Voice-note transcription. Two paths depending on whether the user has set
// their own Groq key in Settings (v1.133):
//
//  - Groq path (preferred):  phone → Groq Whisper → Worker /cleanup
//    Multipart upload from the device; ~2× faster than the Worker fallback
//    and each user has their own free quota (8 hrs audio/day).
//
//  - Worker fallback:        phone → /transcribe (Workers AI Whisper)
//    Used when no Groq key is set yet. Slower, all team traffic shares one
//    Cloudflare account's quota.
//
// Caller passes the file:// URI from expo-audio's recorder. The function
// picks the right path based on whether a Groq key is set, and only reads
// the file as base64 on the legacy path (Groq streams the file via fetch's
// multipart, no base64 round-trip needed).
//
// `cleanup` (default true) controls whether the Claude tidy-up pass runs
// after Whisper. Two layers can disable it:
//   1. The caller — e.g. the composer mic always passes `cleanup: false`
//      because it's drafting an outgoing message, not a private note.
//   2. The user — the Settings screen exposes a "Clean up transcripts"
//      toggle stored under cc.voiceCleanup. When off, no path cleans up,
//      regardless of what the caller asked for.
// Whichever layer is more restrictive wins.
export async function transcribeAudio(
  uri: string,
  options?: { mimeType?: string; cleanup?: boolean },
): Promise<string> {
  const tIn = Date.now();
  const callerCleanup = options?.cleanup ?? true;
  const [{ getGroqKey }, { getVoiceCleanupEnabled }] = await Promise.all([
    import("@/lib/groqKey"),
    import("@/lib/voiceCleanupPref"),
  ]);
  const [groqKey, prefAllowsCleanup] = await Promise.all([
    getGroqKey(),
    getVoiceCleanupEnabled(),
  ]);
  const cleanup = callerCleanup && prefAllowsCleanup;
  const tPrefsReady = Date.now();
  console.log("[stt]", "prefs-ready", { ms: tPrefsReady - tIn, groqKey: !!groqKey, cleanup });
  if (groqKey) {
    const raw = await transcribeWithGroq(uri, groqKey, options?.mimeType);
    const tGroqDone = Date.now();
    console.log("[stt]", "groq-done", { ms: tGroqDone - tPrefsReady, chars: raw.length });
    if (!raw) return "";
    if (!cleanup) return raw;
    const cleaned = await cleanupTranscript(raw);
    const tCleanDone = Date.now();
    console.log("[stt]", "cleanup-done", { ms: tCleanDone - tGroqDone, total_ms: tCleanDone - tIn });
    return cleaned;
  }
  // Legacy path: base64-encode the file for the Worker's JSON-body endpoint.
  const audioB64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const tB64 = Date.now();
  console.log("[stt]", "b64-ready", { ms: tB64 - tPrefsReady, bytes: audioB64.length });
  const text = await transcribeViaWorker(audioB64, cleanup);
  console.log("[stt]", "worker-done", { ms: Date.now() - tB64, total_ms: Date.now() - tIn });
  return text;
}

// Upload the recorded file straight to Groq's OpenAI-compatible Whisper.
// On React Native, FormData accepts { uri, name, type } and the runtime
// streams the file body without us having to base64-decode it.
async function transcribeWithGroq(
  uri: string,
  apiKey: string,
  mimeType?: string,
): Promise<string> {
  const mt = mimeType || guessMimeFromUri(uri);
  const ext = mt.includes("mp4") || mt.includes("aac") || mt.includes("m4a") ? "m4a"
            : mt.includes("webm") ? "webm"
            : mt.includes("ogg") ? "ogg"
            : mt.includes("wav") ? "wav"
            : "m4a";
  const form = new FormData();
  // RN's FormData allows this { uri, name, type } shape — the type cast is
  // because the DOM lib's FormData typing doesn't accept it.
  form.append("file", { uri, name: `voice.${ext}`, type: mt } as any);
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "json");

  const tReq = Date.now();
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    body: form as any,
  });
  console.log("[stt]", "groq-http", { ms: Date.now() - tReq, status: res.status });
  const j = (await res.json().catch(() => ({}))) as {
    text?: string;
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const errMsg =
      typeof j.error === "string"
        ? j.error
        : j.error?.message || `Groq HTTP ${res.status}`;
    // 401 surfaces all the way up so the caller can route the user back to
    // Settings to fix their key. Other errors are wrapped with the same
    // "transcribe " prefix the legacy path used, so existing alert text
    // patterns still match.
    if (res.status === 401) throw new Error("groq_unauthorized: " + errMsg);
    throw new Error(errMsg);
  }
  return String(j?.text || "").trim();
}

// Worker-side Claude cleanup pass. Best-effort: on any failure, returns the
// raw text unchanged so the trainer still has something to edit/save.
async function cleanupTranscript(rawText: string): Promise<string> {
  try {
    const res = await fetch(`${WORKER_URL}/cleanup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: rawText }),
    });
    const j = (await res.json().catch(() => ({}))) as { text?: string };
    if (!res.ok) return rawText;
    return (j.text || rawText).trim();
  } catch {
    return rawText;
  }
}

// Legacy path — Workers-AI Whisper on the Cloudflare side, with the Claude
// cleanup already baked in. Kept so new devices work before the user sets
// their personal Groq key. Passing `cleanup: false` skips the Claude pass
// on the worker so internal-DM dictation is returned raw.
async function transcribeViaWorker(
  audioB64: string,
  cleanup: boolean,
): Promise<string> {
  const res = await fetch(`${WORKER_URL}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: audioB64, cleanup }),
  });
  const j = (await res.json()) as { text?: string; error?: string };
  if (!res.ok || j.error) {
    throw new Error(j.error || `transcribe HTTP ${res.status}`);
  }
  return j.text || "";
}

function guessMimeFromUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".m4a")) return "audio/m4a";
  if (lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "audio/m4a"; // expo-audio HIGH_QUALITY default on iOS and Android
}
