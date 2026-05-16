// Thin wrappers over the Cloudflare Worker endpoints. The Worker is the
// single backend — the mobile app calls it for sends, AI summaries, and
// push-token registration. Same surface as the PWA in mobile.html.

import { WORKER_URL } from "@/config";

export interface SendBody {
  chatId: string;
  phone: string;
  message: string;
  sentByUid: string;
  sentByName: string;
  localMsgId: string;
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
