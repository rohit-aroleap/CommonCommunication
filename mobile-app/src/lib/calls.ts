// v1.264: client wrappers for the call worker endpoints. Created in Phase 2
// of the calling project — pairs with the worker endpoints added in Phase 1
// (commit 868edc2).

import { WORKER_URL } from "@/config";

export interface CallRecord {
  initiatorUid: string;
  initiatorName: string | null;
  recipientUid: string;
  recipientName: string | null;
  roomUrl: string;
  roomName: string;
  isVideo: boolean;
  status: "creating" | "ringing" | "accepted" | "declined" | "missed" | "in-progress" | "ended";
  createdAt: number;
  ringAt?: number;
  acceptedAt?: number;
  endedAt?: number;
  durationSec?: number;
}

export async function createCallRoom(body: {
  initiatorUid: string;
  initiatorName: string;
  recipientUid: string;
  recipientName: string;
}): Promise<{ ok: boolean; callId?: string; roomUrl?: string; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/call-create-room`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true, callId: j.callId, roomUrl: j.roomUrl };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function ringCall(callId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/call-ring`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}

export async function updateCallStatus(
  callId: string,
  status: "accepted" | "declined" | "missed" | "in-progress" | "ended",
): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${WORKER_URL}/call-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, status }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message || e) };
  }
}
