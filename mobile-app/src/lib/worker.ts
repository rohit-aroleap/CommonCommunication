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
  media?: {
    type: "image" | "video" | "audio" | "document";
    filename: string;
    mimetype: string;
    filedata: string; // base64
  };
}

export async function sendMessage(body: SendBody): Promise<Response> {
  return fetch(`${WORKER_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
export function mediaProxyUrl(url: string): string {
  return `${WORKER_URL}/media?u=${encodeURIComponent(url)}`;
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
// after Whisper. The cleanup prompt is written for trainer-private-notes-
// about-customer, so it's the wrong service for internal team DMs where
// the trainer just wants a raw dictation. ThreadScreen's composer mic
// passes `cleanup: false` for DM threads.
export async function transcribeAudio(
  uri: string,
  options?: { mimeType?: string; cleanup?: boolean },
): Promise<string> {
  const cleanup = options?.cleanup ?? true;
  const { getGroqKey } = await import("@/lib/groqKey");
  const groqKey = await getGroqKey();
  if (groqKey) {
    const raw = await transcribeWithGroq(uri, groqKey, options?.mimeType);
    if (!raw) return "";
    if (!cleanup) return raw;
    return await cleanupTranscript(raw);
  }
  // Legacy path: base64-encode the file for the Worker's JSON-body endpoint.
  const audioB64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return await transcribeViaWorker(audioB64, cleanup);
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

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: "Bearer " + apiKey },
    body: form as any,
  });
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
