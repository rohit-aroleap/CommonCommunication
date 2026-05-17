// Best-effort connection warming for the voice-transcription path. The first
// fetch of a session to api.groq.com pays a cold TCP+TLS handshake (200-500ms
// on cellular, less on Wi-Fi). Firing a no-cost ping on ThreadScreen mount
// lets the underlying OkHttp / NSURLSession pool the connection so the real
// /audio/transcriptions POST that follows reuses an already-warm socket.
//
// All failures are swallowed — prewarming is purely an optimization; if the
// network is down or Groq is rate-limiting us, the actual transcription call
// will surface the error with proper UI.
//
// Also warms the Cloudflare Worker even when cleanup is disabled, because the
// legacy /transcribe fallback path uses the same host — if the user later
// clears their Groq key the Worker call still benefits from the pool.

import { WORKER_URL } from "@/config";

let lastPrewarmAt = 0;
const PREWARM_MIN_INTERVAL_MS = 60_000; // don't re-ping more than once a minute

export function prewarmTranscription(groqKey: string | null | undefined): void {
  const now = Date.now();
  if (now - lastPrewarmAt < PREWARM_MIN_INTERVAL_MS) return;
  lastPrewarmAt = now;

  // Groq: an auth'd GET on /models is the cheapest endpoint that confirms
  // both the TLS handshake AND the key works. We don't read the body; just
  // touching the socket is enough to pool it for the upcoming POST.
  if (groqKey) {
    fetch("https://api.groq.com/openai/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer " + groqKey },
    }).catch(() => {});
  } else {
    // No key yet — still warm the TLS to api.groq.com so the first real call
    // after the user pastes a key is fast. Auth will fail (401) but the
    // socket gets pooled either way.
    fetch("https://api.groq.com/openai/v1/models", { method: "GET" }).catch(
      () => {},
    );
  }

  // Worker /health: zero-cost endpoint that opens a connection to the
  // worker so the legacy /transcribe path (used when no Groq key is set) is
  // also instant on first use.
  fetch(`${WORKER_URL}/health`, { method: "GET" }).catch(() => {});
}
