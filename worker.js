// Cloudflare Worker: Periskope <-> Firebase bridge for CommonCommunication
// Secrets required (wrangler secret put / dashboard):
//   PERISKOPE_API_KEY   - Bearer JWT from Periskope console
//   PERISKOPE_PHONE     - org WhatsApp phone, digits only, e.g. 919187651332
//   FIREBASE_DB_SECRET  - Firebase RTDB legacy database secret
//   CLAUDE_API_KEY      - Anthropic API key (for /summarize, /suggest-reply)
//   EXPO_ACCESS_TOKEN   - optional, raises Expo Push rate limits
//
// Vars (wrangler.toml):
//   FIREBASE_DB_URL     - https://motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app
//   ALLOWED_ORIGIN      - dashboard origin (e.g. https://rohit-aroleap.github.io)
// AI binding (wrangler.toml [ai] binding = "AI"): Workers AI Whisper for /transcribe

const PERISKOPE_BASE = "https://api.periskope.app/v1";
const ROOT = "commonComm";

// Admin emails always receive push pings, even when a chat has a targeted
// ticket assignee. Mirror the dashboard's BOOTSTRAP_ADMINS list — if the
// dashboard learns a new admin, bump this list too.
const ADMIN_EMAILS = new Set([
  "rohit@aroleap.com",
]);

// v1.177: R2 budget guards. These constants gate every DM upload so a
// runaway bug or compromised account can't burn through the R2 free tier.
// Tune freely — the per-user limit should comfortably cover real use
// (a chatty trainer at 5/hr × 10hr = 50/day), and the global limit is
// well under the 1M Class A ops/month free tier even at peak.
const DM_MEDIA_USER_DAILY_LIMIT = 50;
const DM_MEDIA_GLOBAL_DAILY_LIMIT = 1000;
const DM_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
// Retention. Scheduled handler deletes R2 objects older than this. The
// Firebase RTDB message record stays (so the chat history reads OK with
// the "📎 filename" placeholder), only the blob is gone.
const DM_MEDIA_RETENTION_DAYS = 90;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));

    try {
      if (url.pathname === "/send" && request.method === "POST") {
        return cors(env, await handleSend(request, env));
      }
      if (url.pathname === "/webhook" && request.method === "POST") {
        return cors(env, await handleWebhook(request, env));
      }
      if (url.pathname === "/health") {
        return cors(env, json({ ok: true, ts: Date.now() }));
      }
      if (url.pathname === "/" || url.pathname === "") {
        return cors(env, json({
          service: "CommonCommunication Worker",
          status: "ok",
          endpoints: ["/health", "/send (POST)", "/edit-message (POST)", "/delete-message (POST)", "/webhook (POST)", "/messages?chatId=... (GET)", "/transcribe (POST)", "/cleanup (POST)", "/register-push-token (POST)", "/ai-inbox (POST)"],
        }));
      }
      if (url.pathname === "/messages" && request.method === "GET") {
        return cors(env, await handleFetchMessages(request, env));
      }
      if (url.pathname === "/backfill-batch" && request.method === "POST") {
        return cors(env, await handleBackfillBatch(request, env));
      }
      if (url.pathname === "/fetch-chat-info" && request.method === "POST") {
        return cors(env, await handleFetchChatInfo(request, env));
      }
      if (url.pathname === "/summarize" && request.method === "POST") {
        return cors(env, await handleSummarize(request, env));
      }
      if (url.pathname === "/ai-query" && request.method === "POST") {
        return cors(env, await handleAiQuery(request, env));
      }
      if (url.pathname === "/suggest-reply" && request.method === "POST") {
        return cors(env, await handleSuggestReply(request, env));
      }
      if (url.pathname === "/transcribe" && request.method === "POST") {
        return cors(env, await handleTranscribe(request, env));
      }
      if (url.pathname === "/cleanup" && request.method === "POST") {
        return cors(env, await handleCleanup(request, env));
      }
      if (url.pathname === "/media" && request.method === "GET") {
        return cors(env, await handleMediaProxy(request, env));
      }
      if (url.pathname === "/register-push-token" && request.method === "POST") {
        return cors(env, await handleRegisterPushToken(request, env));
      }
      if (url.pathname === "/search-messages" && request.method === "GET") {
        return cors(env, await handleSearchMessages(request, env));
      }
      if (url.pathname === "/dm-notify" && request.method === "POST") {
        return cors(env, await handleDmNotify(request, env));
      }
      // v1.210: one-click ack-webhook subscription. POSTs to Periskope's
      // /v1/webhooks endpoint using the existing PERISKOPE_API_KEY +
      // PERISKOPE_PHONE secrets to register this worker's /webhook URL for
      // `message.ack.updated` events (delivered / read receipts).
      // Idempotent on Periskope's side as far as we know — if the hook is
      // already registered it just returns the existing entry.
      if (url.pathname === "/subscribe-ack-webhook" && request.method === "POST") {
        return cors(env, await handleSubscribeAckWebhook(request, env));
      }
      // v1.210: convenience GET so an admin can hit this from the browser
      // (no curl needed). Body-less; identical logic to the POST path.
      if (url.pathname === "/subscribe-ack-webhook" && request.method === "GET") {
        return cors(env, await handleSubscribeAckWebhook(request, env));
      }
      if (url.pathname === "/dm-search" && request.method === "GET") {
        return cors(env, await handleDmSearch(request, env));
      }
      if (url.pathname === "/triage-backfill" && request.method === "POST") {
        return cors(env, await handleTriageBackfill(request, env));
      }
      if (url.pathname === "/backfill-resolution-notes" && request.method === "POST") {
        return cors(env, await handleBackfillResolutionNotes(request, env));
      }
      if (url.pathname === "/backfill-chats-index" && request.method === "POST") {
        return cors(env, await handleBackfillChatsIndex(request, env));
      }
      if (url.pathname === "/edit-message" && request.method === "POST") {
        return cors(env, await handleEditMessage(request, env));
      }
      if (url.pathname === "/delete-message" && request.method === "POST") {
        return cors(env, await handleDeleteMessage(request, env));
      }
      if (url.pathname === "/react-to-message" && request.method === "POST") {
        return cors(env, await handleReactToMessage(request, env));
      }
      // v1.203: cross-chat AI assistant. Replaces the old "Triage all"
      // one-shot batch labeller. Modes:
      //   "attention"   — surface chats needing the team's attention
      //   "freeform"    — answer a custom question over the inbox
      //   "daily-brief" — start-of-shift overview paragraph
      if (url.pathname === "/ai-inbox" && request.method === "POST") {
        return cors(env, await handleAiInbox(request, env));
      }
      // v1.205: push notification on ticket assignment. Called by the
      // client right after a /tickets create or reassign write — Firebase
      // RTDB writes don't trigger any server-side hook of their own.
      if (url.pathname === "/notify-ticket-assignee" && request.method === "POST") {
        return cors(env, await handleNotifyTicketAssignee(request, env));
      }
      // v1.176: internal-DM attachments via Cloudflare R2. Upload is a
      // multipart POST; download is a GET on the path we returned at
      // upload-time. R2 doesn't expose public URLs by default (and r2.dev
      // is rate-limited), so the worker serves the bytes itself.
      if (url.pathname === "/dm-media/upload" && request.method === "POST") {
        return cors(env, await handleDmMediaUpload(request, env));
      }
      // v1.224: template-media endpoints. Uploads go to R2 under
      // "templates/{templateId}/{filename}"; reads stream from the same
      // bucket. Templates are admin-curated team assets so we skip the
      // per-user daily quota that dm-media enforces. URLs are
      // publicly fetchable (no auth) so Periskope can pull the file when
      // forwarding the message to the customer's WhatsApp.
      if (url.pathname === "/template-media/upload" && request.method === "POST") {
        return cors(env, await handleTemplateMediaUpload(request, env));
      }
      if (url.pathname.startsWith("/template-media/") && request.method === "GET") {
        return cors(env, await handleTemplateMediaGet(request, env));
      }
      // v1.226: strength-assessment session endpoints. Upload an MP3 →
      // worker writes to R2 + Firebase, returns sessionId, then runs the
      // Groq transcription in the background via ctx.waitUntil so the
      // browser doesn't have to hold the connection open for what could
      // be several minutes of audio. Reads are public so the in-app
      // player can stream from the URL without auth. Retry/delete are
      // separate endpoints for failed-state recovery.
      if (url.pathname === "/sa-upload" && request.method === "POST") {
        return cors(env, await handleSaUpload(request, env, ctx));
      }
      // v1.249: local-only SA transcription. Mobile-app flow where the
      // audio file stays on the recording device and is NOT stored in R2.
      // The worker JUST transcribes via Groq + writes the transcript to
      // Firebase RTDB. Idempotent on clientSessionId so the phone's
      // retry queue can hit this endpoint repeatedly without creating
      // duplicate saSession records. See handleSaTranscribeLocal for
      // the request shape.
      if (url.pathname === "/sa-transcribe-local" && request.method === "POST") {
        return cors(env, await handleSaTranscribeLocal(request, env, ctx));
      }
      // v1.233: chunked-upload path. Used by the browser when the source
      // file exceeds 25 MB. Browser splits the file into WAV chunks
      // (one full PCM decode + re-wrap, no compression) and uploads
      // each chunk here in order. The final chunk's arrival triggers
      // background transcribeMultipart() which iterates Groq calls
      // and stitches transcripts into one.
      if (url.pathname === "/sa-upload-chunk" && request.method === "POST") {
        return cors(env, await handleSaUploadChunk(request, env, ctx));
      }
      // v1.254: meetings — internal team recording feature. Same chunked-
      // upload pattern as SA, but stored under /commonComm/meetings/{id}
      // instead of /chats/{chatKey}/saSessions/{id}. See meeting handlers
      // for the request shapes.
      if (url.pathname === "/meeting-create" && request.method === "POST") {
        return cors(env, await handleMeetingCreate(request, env));
      }
      if (url.pathname === "/meeting-dropbox-url" && request.method === "POST") {
        return cors(env, await handleMeetingDropboxUrl(request, env));
      }
      if (url.pathname === "/meeting-set-dropbox" && request.method === "POST") {
        return cors(env, await handleMeetingSetDropbox(request, env));
      }
      if (url.pathname === "/meeting-upload-chunk" && request.method === "POST") {
        return cors(env, await handleMeetingUploadChunk(request, env, ctx));
      }
      if (url.pathname === "/meeting-delete" && request.method === "POST") {
        return cors(env, await handleMeetingDelete(request, env));
      }
      if (url.pathname === "/meeting-update" && request.method === "POST") {
        return cors(env, await handleMeetingUpdate(request, env));
      }
      if (url.pathname === "/meeting-summarize" && request.method === "POST") {
        return cors(env, await handleMeetingSummarize(request, env, ctx));
      }
      if (url.pathname === "/meeting-retry-transcribe" && request.method === "POST") {
        return cors(env, await handleMeetingRetryTranscribe(request, env, ctx));
      }
      // v1.260: self-chain endpoint. transcribeMeetingNext fires a fetch
      // here after finishing each chunk to kick off the next one. Each
      // invocation processes exactly one chunk + chains to itself for
      // the next. Survives isolate eviction since no single run is long.
      if (url.pathname === "/meeting-transcribe-next" && request.method === "POST") {
        return cors(env, await handleMeetingTranscribeNext(request, env, ctx));
      }
      // v1.264: CALLING — Daily.co 1:1 audio calls between teammates.
      // Phase 1 ships the worker plumbing only; mobile UI follows in
      // Phase 2 once the new EAS Builds are in. iOS VoIP push waits for
      // the user's VoIP cert to land.
      if (url.pathname === "/call-create-room" && request.method === "POST") {
        return cors(env, await handleCallCreateRoom(request, env));
      }
      if (url.pathname === "/call-ring" && request.method === "POST") {
        return cors(env, await handleCallRing(request, env, ctx));
      }
      if (url.pathname === "/call-status" && request.method === "POST") {
        return cors(env, await handleCallStatusUpdate(request, env));
      }
      if (url.pathname === "/daily-webhook" && request.method === "POST") {
        return cors(env, await handleDailyWebhook(request, env, ctx));
      }
      if (url.pathname === "/sa-retranscribe" && request.method === "POST") {
        return cors(env, await handleSaRetranscribe(request, env, ctx));
      }
      if (url.pathname === "/sa-delete" && request.method === "POST") {
        return cors(env, await handleSaDelete(request, env));
      }
      if (url.pathname.startsWith("/sa-media/") && request.method === "GET") {
        return cors(env, await handleSaMediaGet(request, env));
      }
      if (url.pathname.startsWith("/dm-media/") && request.method === "GET") {
        return cors(env, await handleDmMediaGet(request, env));
      }
      // v1.182: manual trigger for the cleanup that used to run on cron.
      // Idempotent — safe to hit on a schedule (uptime monitor) or
      // ad-hoc. Returns the number of objects deleted.
      if (url.pathname === "/cleanup-dm-media" && request.method === "POST") {
        const deleted = await cleanupOldDmMedia(env);
        return cors(env, json({ ok: true, deleted, retentionDays: DM_MEDIA_RETENTION_DAYS }));
      }
      return cors(env, json({ error: "not_found" }, 404));
    } catch (err) {
      return cors(env, json({ error: String(err && err.message || err) }, 500));
    }
  },

  // v1.177: scheduled cleanup. Wrangler's [triggers] crons = ["0 3 * * *"]
  // wakes this every day at 03:00 UTC. Deletes R2 objects whose `uploaded`
  // timestamp is older than DM_MEDIA_RETENTION_DAYS. Cheap to run: each
  // list() call is 1 Class A op and returns 1000 objects; even a busy
  // team will be done in a handful of list+delete cycles.
  async scheduled(event, env, ctx) {
    try {
      await cleanupOldDmMedia(env);
    } catch (e) {
      console.warn("scheduled cleanup failed:", e?.message || e);
    }
  },
};

// v1.177: walk R2 in pages, delete objects older than the retention window.
// Returns count for log visibility (wrangler tail shows it).
async function cleanupOldDmMedia(env) {
  if (!env.DM_MEDIA) return 0;
  const cutoffMs = Date.now() - DM_MEDIA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cursor = undefined;
  let deleted = 0;
  // Cap iterations as a safety belt — even at 1000 objects/page, 50 pages
  // is 50k files which is way more than this app could ever have.
  for (let i = 0; i < 50; i++) {
    const listed = await env.DM_MEDIA.list({ prefix: "dms/", cursor, limit: 1000 });
    const stale = listed.objects
      .filter((o) => o.uploaded && o.uploaded.getTime() < cutoffMs)
      .map((o) => o.key);
    if (stale.length > 0) {
      // R2 delete accepts an array.
      await env.DM_MEDIA.delete(stale);
      deleted += stale.length;
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  if (deleted > 0) console.log(`cleanupOldDmMedia: deleted ${deleted} objects`);
  return deleted;
}

// v1.177: per-user + global daily upload caps. Counters live in Firebase
// at commonComm/rateLimits/... keyed by YYYY-MM-DD so old days roll off
// naturally. Non-atomic read-then-write is fine — a 1-2 over-count under
// concurrent load is harmless given the cap is a safety net, not a hard
// billing line.
async function checkAndIncrementDmUploadQuota(env, fromUid) {
  const today = new Date().toISOString().slice(0, 10);
  const safeUid = String(fromUid || "anon").replace(/[.#$\[\]\/]/g, "_");
  const userKey = `${ROOT}/rateLimits/dmUploads/${today}/perUser/${safeUid}`;
  const globalKey = `${ROOT}/rateLimits/dmUploads/${today}/global`;

  const auth = env.FIREBASE_DB_SECRET ? `?auth=${env.FIREBASE_DB_SECRET}` : "";
  const userUrl = `${env.FIREBASE_DB_URL}/${userKey}.json${auth}`;
  const globalUrl = `${env.FIREBASE_DB_URL}/${globalKey}.json${auth}`;

  const [uVal, gVal] = await Promise.all([
    fetch(userUrl).then((r) => r.json()).catch(() => 0),
    fetch(globalUrl).then((r) => r.json()).catch(() => 0),
  ]);
  const userCount = Number(uVal) || 0;
  const globalCount = Number(gVal) || 0;

  if (userCount >= DM_MEDIA_USER_DAILY_LIMIT) {
    return {
      ok: false,
      status: 429,
      reason: `daily upload limit reached for this account (${DM_MEDIA_USER_DAILY_LIMIT}/day). Resets at 00:00 UTC.`,
    };
  }
  if (globalCount >= DM_MEDIA_GLOBAL_DAILY_LIMIT) {
    return {
      ok: false,
      status: 429,
      reason: `team-wide daily upload limit reached (${DM_MEDIA_GLOBAL_DAILY_LIMIT}/day). Try again tomorrow or ping admin.`,
    };
  }

  // Fire-and-forget the increments — the user shouldn't wait on the write.
  fetch(userUrl, { method: "PUT", body: JSON.stringify(userCount + 1) }).catch(() => {});
  fetch(globalUrl, { method: "PUT", body: JSON.stringify(globalCount + 1) }).catch(() => {});

  return { ok: true };
}

// ---------- /send ----------
async function handleSend(request, env) {
  const body = await request.json();
  const { chatId, phone, message, sentByUid, sentByName, localMsgId } = body || {};
  // v1.130: optional list of mentioned teammate UIDs. When present, fire a
  // push to those UIDs after Periskope accepts the message, regardless of
  // ticket/favorite rules. Mentions are also stored on the message record
  // so the dashboard can highlight them later.
  const mentions = Array.isArray(body?.mentions)
    ? body.mentions.filter((u) => typeof u === "string" && u.length > 0)
    : [];

  if (!chatId && !phone) {
    return json({ error: "missing chatId/phone" }, 400);
  }
  // Allow media-only sends (no caption). Reject only when BOTH message and
  // media are missing.
  const hasMedia = !!(body.media && (body.media.filedata || body.media.url));
  if (!message && !hasMedia) {
    return json({ error: "missing message or media" }, 400);
  }
  if (!sentByUid || !sentByName) {
    return json({ error: "missing sentByUid/sentByName" }, 400);
  }

  const resolvedChatId = chatId || phoneToChatId(phone);
  const resolvedPhone = phone || chatIdToPhone(resolvedChatId);

  // v1.239: route through the shared ferra-periskope-gateway instead of
  // hitting Periskope directly. Phase 5 of the gateway consolidation
  // (other Aroleap dashboards migrated in earlier phases). The gateway
  // centralizes the Periskope API key + rate-limit + cross-dashboard
  // dedup + observability under a single URL.
  //
  // v1.240: use a Cloudflare SERVICE BINDING (env.PERISKOPE_GATEWAY)
  // instead of fetching the gateway's public URL. CF's edge returns
  // error 1042 when one *.workers.dev worker fetches another via public
  // URL on the same account — service bindings route internally, free
  // and faster.
  //
  // Request shape:
  //   { phone OR chatId, text, kind, dashboard, media?, replyTo?,
  //     idempotencyKey? } — gateway translates to Periskope's
  //   { chat_id, message, media, reply_to_message_id }.
  //
  // Response shape:
  //   success: { ok: true, messageId, sentAt, dashboard, kind, chatId }
  //   failure: { error, httpStatus, detail } with non-2xx
  //
  // kind: "trainer-reply" because every CommonComm /send is a trainer
  // typing into the customer chat composer. dedupWindowMin is 0 for
  // trainer-reply (per gateway DEDUP_WINDOWS config), so every send
  // actually fires through — explicit dedupWindowMin: 0 in the body
  // belt-and-suspenders against future gateway config drift.
  const gatewayBody = {
    chatId: resolvedChatId,
    text: message || "",
    kind: "trainer-reply",
    dashboard: "commoncomm",
    dedupWindowMin: 0,
  };
  if (body.media && (body.media.filedata || body.media.url)) {
    gatewayBody.media = body.media;
  }
  // v1.232 carry-over: skip replyTo for cross-chat replies (the
  // "Reply privately to customer" group→1:1 flow). WhatsApp can't quote
  // a message that lives in a different chat — Periskope would either
  // reject or silently drop it. The reply context lives only on our
  // own bubble's replyTo snapshot in that case.
  if (body.replyTo?.periskopeMsgId && !body.replyTo?.sourceChatKey) {
    gatewayBody.replyTo = { periskopeMsgId: body.replyTo.periskopeMsgId };
  }

  const periskopeRes = await env.PERISKOPE_GATEWAY.fetch(
    new Request("https://gateway/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(gatewayBody),
    }),
  );

  const periskopeJson = await safeJson(periskopeRes);
  // Map gateway's messageId back to the unique_id name used everywhere
  // downstream in this file (saves a wider rename — every "uniqueId"
  // reference still means the same thing semantically).
  const ok = periskopeRes.ok && periskopeJson?.ok === true;
  const uniqueId = periskopeJson?.messageId || null;
  // v1.267: when ok=false, surface the actual gateway response in worker
  // logs so `wrangler tail` can see WHY the send was marked failed. Until
  // now this was silently swallowed — a trainer would see "✗ failed" with
  // no way to debug. The reported PDF case (v1.266 Hemant Murthy 90s Lab
  // Report) was Periskope-accepted but gateway-rejected back to us; this
  // log gives us the gateway's exact response shape for next time.
  if (!ok) {
    console.error("send-not-ok", {
      gatewayHttpStatus: periskopeRes.status,
      gatewayResponse: periskopeJson,
      chatId: resolvedChatId,
      hasMedia: !!body.media,
      mediaType: body.media?.type || body.media?.mimetype || null,
      mediaFileName: body.media?.filename || null,
    });
  }

  // Predict the message_id format that Periskope's webhook will use for
  // the from_me=true echo of this send: "true_{chat_id}_{unique_id}". By
  // pre-writing the byPeriskopeId dedup entry, we prevent the webhook from
  // duplicating the message when it arrives a moment later.
  //
  // v1.267: include the dedup entry even when ok=false BUT a uniqueId is
  // present in the gateway response. Observed failure mode: Periskope
  // accepts the send (the message reaches the customer) yet the gateway
  // returns ok=false to us due to a downstream gateway-side issue. Without
  // the dedup entry, the from_me=true echo a few seconds later creates a
  // SECOND bubble and the original stays stuck at "failed". With it, the
  // webhook recognizes the echo and patches the failed bubble to "sent"
  // (see handleWebhook dedup branch). If Periskope truly rejected the
  // send, no echo ever arrives, so the bubble correctly stays "failed".
  const expectedWebhookMsgId = uniqueId ? `true_${resolvedChatId}_${uniqueId}` : null;

  const ts = Date.now();
  const msgRecord = {
    direction: "out",
    text: message,
    ts,
    sentByUid,
    sentByName,
    status: ok ? "sent" : "failed",
    periskopeUniqueId: uniqueId,
    periskopeMsgId: expectedWebhookMsgId, // matches the field the webhook will use
    periskopeTrackBy: periskopeJson?.track_by || null,
    periskopeResp: periskopeJson || null,
  };
  // Optimistic media metadata: filename/mime is known immediately even though
  // the Periskope-hosted URL only arrives via the from_me=true webhook echo.
  // The webhook will fill in media.url via the dedup-update path.
  if (body.media && (body.media.filename || body.media.mimetype)) {
    msgRecord.media = {
      fileName: body.media.filename || null,
      mimeType: body.media.mimetype || null,
    };
    msgRecord.messageType = body.media.type || "media";
  }
  if (mentions.length > 0) {
    msgRecord.mentions = mentions;
  }
  // v1.153: stash reply snapshot so the bubble can render the quoted
  // card without an extra read of the parent (which may have been
  // edited or deleted since). Only fields we'll actually render get
  // persisted — keep the record lean.
  if (body.replyTo?.msgKey) {
    msgRecord.replyTo = {
      msgKey: body.replyTo.msgKey,
      periskopeMsgId: body.replyTo.periskopeMsgId || null,
      text: String(body.replyTo.text || "").slice(0, 500),
      isFromMe: !!body.replyTo.isFromMe,
      senderName: body.replyTo.senderName || null,
      // v1.232: cross-chat reply context. When set, the bubble renderer
      // deep-links the quoted card to this chat key instead of trying to
      // scroll within the current thread. Origin is the "Reply privately
      // to customer from group" flow.
      ...(body.replyTo.sourceChatKey ? { sourceChatKey: body.replyTo.sourceChatKey } : {}),
    };
  }

  let msgKey = localMsgId;
  if (localMsgId) {
    await fbPatch(env, `${ROOT}/chats/${encodeKey(resolvedChatId)}/messages/${localMsgId}`, msgRecord);
  } else {
    const pushed = await fbPush(env, `${ROOT}/chats/${encodeKey(resolvedChatId)}/messages`, msgRecord);
    msgKey = pushed?.name || null;
  }
  // Preview: caption if provided, else a media-aware placeholder. Avoids the
  // empty preview that results from a media-only send.
  let preview = (message || "").slice(0, 120);
  if (!preview && body.media) {
    const mt = String(body.media.type || body.media.mimetype || "").toLowerCase();
    const name = body.media.filename || "";
    preview = mt.startsWith("image") ? `📷 ${name || "Photo"}`
            : mt.startsWith("video") ? `🎥 ${name || "Video"}`
            : mt.startsWith("audio") ? `🎤 ${name || "Voice note"}`
            : `📎 ${name || "Attachment"}`;
    preview = preview.slice(0, 120);
  }
  await patchChatMeta(env, encodeKey(resolvedChatId), {
    phone: resolvedPhone,
    chatId: resolvedChatId,
    lastMsgAt: ts,
    lastMsgPreview: preview,
    lastMsgDirection: "out",
    lastMsgSentByName: sentByName,
  });
  if (expectedWebhookMsgId && msgKey) {
    await fbPut(env, `${ROOT}/byPeriskopeId/${encodeKey(expectedWebhookMsgId)}`, {
      chatId: resolvedChatId,
      msgKey,
    });
  }

  // v1.130: mention push override. If the send succeeded AND we have a
  // mentions list, ping those teammates regardless of ticket/favorite
  // status. Don't ping the sender even if they accidentally @-mentioned
  // themselves. Fire-and-forget — the trainer's send shouldn't block on
  // notification delivery.
  if (ok && mentions.length > 0) {
    const uidSet = new Set(mentions.filter((u) => u !== sentByUid));
    if (uidSet.size > 0 && typeof globalThis.queueMicrotask === "function") {
      const previewBody = (message || preview || "").slice(0, 160);
      globalThis.queueMicrotask(() => {
        sendPushToUids(env, uidSet, {
          title: `${sentByName} mentioned you`,
          body: previewBody,
          data: {
            chatKey: encodeKey(resolvedChatId),
            chatId: resolvedChatId,
            mention: true,
          },
        }).catch((e) => console.warn("[mention push] failed:", e));
      });
    }
  }

  return json({ ok, periskope: periskopeJson }, ok ? 200 : 502);
}

// ---------- /edit-message ----------
// Edits a previously-sent WhatsApp message through Periskope, then patches
// the Firebase record so every connected client sees the new text (plus
// the `editedAt` marker that lets the UI render the "edited" tag).
//
// Body: {
//   chatKey, msgKey         — Firebase paths to patch on success
//   periskopeMsgId          — Periskope's message identifier (we pass this
//                             through to their API)
//   newText                 — replacement message body
//   editedByUid, editedByName — for the audit trail on the message record
// }
//
// Periskope's documented edit window is ~15 min on WhatsApp. If the window
// has expired their API returns an error which we surface verbatim — we
// don't pre-check on our side because the rule is theirs to enforce.
async function handleEditMessage(request, env) {
  const body = await request.json();
  const { chatKey, msgKey, periskopeMsgId, newText, editedByUid, editedByName } = body || {};

  if (!periskopeMsgId) return json({ error: "missing periskopeMsgId" }, 400);
  if (!chatKey || !msgKey) return json({ error: "missing chatKey/msgKey" }, 400);
  const trimmed = String(newText || "").trim();
  if (!trimmed) return json({ error: "missing newText" }, 400);

  // v1.239 → v1.240: route through ferra-periskope-gateway's /edit
  // endpoint via service binding (NOT public URL fetch — that returns
  // CF error 1042). Same effective Periskope call happens on the other
  // side; the gateway just centralizes the API key + adds observability.
  // The frontend keeps calling `/edit-message` on THIS worker; we just
  // swap the inner call.
  let periskopeRes;
  try {
    periskopeRes = await env.PERISKOPE_GATEWAY.fetch(
      new Request("https://gateway/edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periskopeMsgId,
          text: trimmed,
          dashboard: "commoncomm",
        }),
      }),
    );
  } catch (e) {
    return json({ error: "periskope_unreachable", details: String(e) }, 502);
  }
  const periskopeJson = await safeJson(periskopeRes);
  if (!periskopeRes.ok || periskopeJson?.ok !== true) {
    // Gateway surfaces Periskope's verbatim error under `detail` (e.g.
    // "edit window expired"). Pass it through with the original status
    // code so the mobile UI's toast logic keeps working unchanged.
    return json(
      {
        error: "periskope_edit_failed",
        details: periskopeJson?.detail ?? periskopeJson,
        status: periskopeRes.status,
      },
      periskopeRes.status === 200 ? 502 : periskopeRes.status,
    );
  }

  // Patch the Firebase message record so connected clients update. Keep
  // the original text in `originalText` for the audit trail / dashboard
  // edit-history view we may build later.
  const editedAt = Date.now();
  const prior = await fbGet(env, `${ROOT}/chats/${chatKey}/messages/${msgKey}`);
  const patch = {
    text: trimmed,
    editedAt,
    editedByUid: editedByUid || null,
    editedByName: editedByName || null,
  };
  // Only stash originalText the FIRST time a message is edited — subsequent
  // edits preserve the truly-original text rather than overwriting with
  // the second-most-recent.
  if (prior && !prior.originalText && prior.text) {
    patch.originalText = prior.text;
  }
  await fbPatch(env, `${ROOT}/chats/${chatKey}/messages/${msgKey}`, patch);

  // Update the chat-list preview if this was the latest message. Cheaper
  // than a full meta read — just compare against lastMsgAt; if our ts
  // matches, the preview is for this exact message and should refresh.
  if (prior?.ts) {
    const meta = await fbGet(env, `${ROOT}/chats/${chatKey}/meta`);
    if (meta?.lastMsgAt === prior.ts) {
      const preview = trimmed.slice(0, 120);
      const metaPatch = {
        lastMsgPreview: preview,
        // Mirror the dual-write that handleSend / handleWebhook do, so
        // chatsIndex (mobile's chat-list source) stays in sync.
      };
      await fbPatch(env, `${ROOT}/chats/${chatKey}/meta`, metaPatch);
      await fbPatch(env, `${ROOT}/chatsIndex/${chatKey}`, { lastMsgPreview: preview });
    }
  }

  return json({ ok: true, editedAt });
}

// ---------- /delete-message ----------
// Deletes a previously-sent WhatsApp message through Periskope, then marks
// the Firebase record as deleted. We DON'T remove the record outright —
// the UI shows a "Message deleted" placeholder in its place (WhatsApp
// pattern), which matters for ticket-anchor records and audit context.
//
// Body: {
//   chatKey, msgKey
//   periskopeMsgId
//   deletedByUid, deletedByName
// }
async function handleDeleteMessage(request, env) {
  const body = await request.json();
  const { chatKey, msgKey, periskopeMsgId, deletedByUid, deletedByName } = body || {};

  if (!periskopeMsgId) return json({ error: "missing periskopeMsgId" }, 400);
  if (!chatKey || !msgKey) return json({ error: "missing chatKey/msgKey" }, 400);

  // v1.239 → v1.240: route through ferra-periskope-gateway's /delete
  // endpoint via service binding.
  let periskopeRes;
  try {
    periskopeRes = await env.PERISKOPE_GATEWAY.fetch(
      new Request("https://gateway/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periskopeMsgId,
          dashboard: "commoncomm",
        }),
      }),
    );
  } catch (e) {
    return json({ error: "periskope_unreachable", details: String(e) }, 502);
  }
  const periskopeJson = await safeJson(periskopeRes);
  if (!periskopeRes.ok || periskopeJson?.ok !== true) {
    // Most likely cause: "delete-for-everyone window expired" (~2 days
    // on WhatsApp). Gateway surfaces Periskope's verbatim error under
    // `detail`. Pass through so the mobile UI's toast keeps working.
    return json(
      {
        error: "periskope_delete_failed",
        details: periskopeJson?.detail ?? periskopeJson,
        status: periskopeRes.status,
      },
      periskopeRes.status === 200 ? 502 : periskopeRes.status,
    );
  }

  // Tombstone the Firebase record. We keep media metadata (filename only,
  // no URL) for audit context but clear the text and any media URLs.
  const deletedAt = Date.now();
  const prior = await fbGet(env, `${ROOT}/chats/${chatKey}/messages/${msgKey}`);
  const patch = {
    deleted: true,
    deletedAt,
    deletedByUid: deletedByUid || null,
    deletedByName: deletedByName || null,
  };
  // Preserve originalText if this is the first state change.
  if (prior && !prior.originalText && prior.text) {
    patch.originalText = prior.text;
  }
  await fbPatch(env, `${ROOT}/chats/${chatKey}/messages/${msgKey}`, patch);

  // Refresh chat-list preview if this was the latest message.
  if (prior?.ts) {
    const meta = await fbGet(env, `${ROOT}/chats/${chatKey}/meta`);
    if (meta?.lastMsgAt === prior.ts) {
      const preview = "🚫 Message deleted";
      await fbPatch(env, `${ROOT}/chats/${chatKey}/meta`, { lastMsgPreview: preview });
      await fbPatch(env, `${ROOT}/chatsIndex/${chatKey}`, { lastMsgPreview: preview });
    }
  }

  return json({ ok: true, deletedAt });
}

// ---------- /react-to-message ----------
// Adds (or replaces) a reaction on a previously-exchanged WhatsApp message.
// WhatsApp's model is one-reaction-per-person-per-message — sending a new
// reaction REPLACES the prior one from that user. Sending an empty string
// REMOVES the user's reaction.
//
// Body: {
//   chatKey, msgKey, periskopeMsgId
//   emoji                — the reaction. Empty string ("") removes our reaction.
//   reactedByUid, reactedByName
// }
//
// Firebase model: commonComm/chats/{k}/messages/{m}/reactions/{uid} =
//   { emoji, ts, byName, source: "trainer" | "customer" }
// Keyed by uid for trainers, by customer phone for inbound reactions
// (those come in via the webhook — see handleWebhook). One-reaction-per-
// person enforced by the key.
async function handleReactToMessage(request, env) {
  const body = await request.json();
  const { chatKey, msgKey, periskopeMsgId, emoji, reactedByUid, reactedByName } = body || {};

  if (!periskopeMsgId) return json({ error: "missing periskopeMsgId" }, 400);
  if (!chatKey || !msgKey) return json({ error: "missing chatKey/msgKey" }, 400);
  if (!reactedByUid) return json({ error: "missing reactedByUid" }, 400);
  // Allow empty emoji as the "remove my reaction" signal.
  const emojiTrimmed = String(emoji || "");

  // v1.239 → v1.240: route through ferra-periskope-gateway's /react
  // endpoint via service binding. Translation: the local "" convention
  // for "remove my reaction" becomes `null` on the gateway (per gateway
  // docs — reaction: null forwards as the unreact signal to Periskope).
  let periskopeRes;
  try {
    periskopeRes = await env.PERISKOPE_GATEWAY.fetch(
      new Request("https://gateway/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          periskopeMsgId,
          reaction: emojiTrimmed ? emojiTrimmed : null,
          dashboard: "commoncomm",
        }),
      }),
    );
  } catch (e) {
    return json({ error: "periskope_unreachable", details: String(e) }, 502);
  }
  const periskopeJson = await safeJson(periskopeRes);
  if (!periskopeRes.ok || periskopeJson?.ok !== true) {
    return json(
      {
        error: "periskope_react_failed",
        details: periskopeJson?.detail ?? periskopeJson,
        status: periskopeRes.status,
      },
      periskopeRes.status === 200 ? 502 : periskopeRes.status,
    );
  }

  // Patch Firebase to reflect the reaction (or its removal). null = delete
  // the key entirely, which is how RTDB's PATCH semantics handle "unreact".
  const reactionPath = `${ROOT}/chats/${chatKey}/messages/${msgKey}/reactions/${reactedByUid}`;
  if (!emojiTrimmed) {
    await fbPut(env, reactionPath, null);
  } else {
    await fbPut(env, reactionPath, {
      emoji: emojiTrimmed,
      ts: Date.now(),
      byName: reactedByName || null,
      source: "trainer",
    });
  }

  return json({ ok: true });
}

// ---------- /webhook (inbound from Periskope) ----------
async function handleWebhook(request, env) {
  const payload = await request.json();

  // Always log raw payloads so we can debug shape mismatches later.
  const debugKey = Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await fbPut(env, `${ROOT}/_debug/webhook/${debugKey}`, { payload, receivedAt: Date.now() });

  // Periskope event shape: { event: "message.created", data: { ...message } }
  const evtType = payload?.event || payload?.type || "unknown";
  const msg = payload?.data || payload?.message || payload;

  if (!msg) return json({ ok: true, skipped: "no message" });

  // Tenant guard: a Periskope webhook carries the org's own WhatsApp number
  // (the account the event belongs to). If it doesn't match PERISKOPE_PHONE,
  // some OTHER account is posting to our endpoint — drop the message so it
  // never lands in /commonComm/chats and leaks across accounts.
  const expectedPhone = digitsOnly(env.PERISKOPE_PHONE);
  const accountPhone = extractAccountPhone(payload, msg);
  if (expectedPhone && accountPhone && accountPhone !== expectedPhone) {
    await fbPut(env, `${ROOT}/_debug/webhook_rejected/${debugKey}`, {
      reason: "account_phone_mismatch",
      expected: expectedPhone,
      got: accountPhone,
      receivedAt: Date.now(),
    });
    return json({ ok: true, rejected: "account_phone_mismatch" });
  }

  const rawChatId = msg.chat_id || msg.chatId;
  if (!rawChatId) return json({ ok: true, skipped: "no chat_id" });
  const chatId = String(rawChatId);
  const isGroup = chatId.endsWith("@g.us");

  // v1.152: detect reaction events and route them to the reactions
  // updater instead of storing as a regular message. Periskope's event
  // shape isn't documented for reactions specifically, so we look at
  // several plausible signals (event type, message_type, presence of a
  // reaction body) and parse defensively. If we recognize it as a
  // reaction, write to the parent message's reactions/{phone} entry and
  // return — never let a reaction become its own message bubble.
  const isReactionEvent =
    /reaction/i.test(String(evtType)) ||
    /reaction/i.test(String(msg.message_type || "")) ||
    !!msg.reaction ||
    !!msg.reacted_message_id;
  if (isReactionEvent) {
    try {
      const parentMsgId =
        msg.reacted_message_id ||
        msg.parent_message_id ||
        msg.in_reply_to_message_id ||
        msg.reply_to_message_id ||
        null;
      const emojiRaw =
        (typeof msg.reaction === "string" ? msg.reaction : null) ||
        msg.reaction?.emoji ||
        msg.reaction?.text ||
        msg.body ||
        msg.message ||
        "";
      const reactorPhone = msg.sender_phone
        ? String(msg.sender_phone).split("@")[0].replace(/\D/g, "")
        : chatIdToPhone(chatId).replace(/\D/g, "");
      // Stash the raw payload so we can iterate on the parser without
      // losing data; the next paragraph attempts the actual patch.
      await fbPut(env, `${ROOT}/_debug/reactions/${debugKey}`, {
        evtType,
        parentMsgId,
        emoji: emojiRaw,
        reactorPhone,
        isFromMe: msg.from_me === true || msg.fromMe === true,
        receivedAt: Date.now(),
      });
      if (parentMsgId && reactorPhone) {
        const parentRef = await fbGet(
          env,
          `${ROOT}/byPeriskopeId/${encodeKey(parentMsgId)}`,
        );
        if (parentRef?.chatId && parentRef?.msgKey) {
          const reactionPath = `${ROOT}/chats/${encodeKey(parentRef.chatId)}/messages/${parentRef.msgKey}/reactions/${reactorPhone}`;
          if (!emojiRaw) {
            // Empty reaction == customer removed their reaction.
            await fbPut(env, reactionPath, null);
          } else {
            await fbPut(env, reactionPath, {
              emoji: emojiRaw,
              ts: parseTs(msg.timestamp),
              byName: msg.sender_name || msg.contact_name || null,
              source: "customer",
            });
          }
        }
      }
    } catch (e) {
      console.warn("[reaction-event] failed:", e);
    }
    return json({ ok: true, kind: "reaction" });
  }

  // v1.210: WhatsApp-style delivery / read receipts. Periskope publishes a
  // `message.ack.updated` event when WhatsApp confirms delivery / read for a
  // message we previously sent.
  //
  // v1.213 HOTFIX: detection MUST be strict on the event type. Regular
  // `message.created` payloads include an `ack` field on the message
  // itself (the current ack level — usually `1` for a freshly-sent
  // message), so any heuristic that fires on `msg.ack != null` would
  // misclassify every inbound message as an ack event and drop it on
  // the floor. Trainers reported customers' messages not appearing live
  // — backfill was the only way to see them. Now we only treat a
  // payload as ack-only when the EVENT NAME itself says so.
  const isAckEvent = /ack\.updated/i.test(String(evtType));
  if (isAckEvent) {
    try {
      const ackPeriskopeMsgId =
        msg.message_id || msg.unique_id || msg.id?.serialized || msg.id || null;
      const ackNum =
        typeof msg.ack === "number"
          ? msg.ack
          : typeof msg.ack === "string"
            ? parseInt(msg.ack, 10)
            : null;
      const ackName = String(msg.ack_name || msg.status || "").toLowerCase();
      // Map to the WhatsApp ladder. We collapse 4 (played, voice notes)
      // down to "read" — same blue tick, no separate icon planned.
      let newStatus = null;
      if (ackName === "read" || ackNum === 3 || ackNum === 4) newStatus = "read";
      else if (ackName === "delivered" || ackNum === 2) newStatus = "delivered";
      else if (ackName === "sent" || ackName === "server" || ackNum === 1) newStatus = "sent";
      await fbPut(env, `${ROOT}/_debug/ack/${debugKey}`, {
        evtType,
        ackPeriskopeMsgId,
        ackNum,
        ackName,
        mappedTo: newStatus,
        receivedAt: Date.now(),
      });
      if (newStatus && ackPeriskopeMsgId) {
        const parentRef = await fbGet(
          env,
          `${ROOT}/byPeriskopeId/${encodeKey(ackPeriskopeMsgId)}`,
        );
        if (parentRef?.chatId && parentRef?.msgKey) {
          // Only ever ratchet status FORWARD. If we already saw "read",
          // don't downgrade to "delivered" because of a late event.
          const RANK = { sending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };
          const existing = await fbGet(
            env,
            `${ROOT}/chats/${encodeKey(parentRef.chatId)}/messages/${parentRef.msgKey}/status`,
          );
          const cur = typeof existing === "string" ? existing : "sent";
          if ((RANK[newStatus] ?? 0) > (RANK[cur] ?? 0)) {
            const patch = { status: newStatus };
            if (newStatus === "delivered") patch.deliveredAt = Date.now();
            if (newStatus === "read") patch.readAt = Date.now();
            await fbPatch(
              env,
              `${ROOT}/chats/${encodeKey(parentRef.chatId)}/messages/${parentRef.msgKey}`,
              patch,
            );
          }
        }
      }
    } catch (e) {
      console.warn("[ack-event] failed:", e);
    }
    return json({ ok: true, kind: "ack" });
  }

  const isFromMe = msg.from_me === true || msg.fromMe === true;
  const text = msg.body || msg.message || msg.text || "";
  const ts = parseTs(msg.timestamp);
  const periskopeMsgId = msg.message_id || msg.unique_id || msg.id?.serialized || msg.id || null;
  const senderName = msg.sender_name || msg.contact_name || null;
  // Periskope's sender_phone often comes as "919876543210@c.us" - strip the suffix
  const senderPhone = (msg.sender_phone ? String(msg.sender_phone).split("@")[0] : chatIdToPhone(chatId));
  const messageType = msg.message_type || "text";

  // Dedup: if we already stored this periskopeMsgId, skip.
  if (periskopeMsgId) {
    const existing = await fbGet(env, `${ROOT}/byPeriskopeId/${encodeKey(periskopeMsgId)}`);
    if (existing) {
      // If this echo carries media (Periskope-hosted URL we couldn't have at
      // /send time), patch the existing message so receivers see the image.
      const echoMedia = extractMedia(msg);
      // v1.267: self-heal a false-failed status. /send writes the dedup
      // entry even when the gateway returned ok=false (as long as a
      // uniqueId came back). If we now see Periskope's from_me=true echo
      // for that same uniqueId, the send actually succeeded — patch the
      // bubble's status from "failed" → "sent" so the trainer sees the
      // truth instead of a misleading red cross. Read the existing
      // message first so we only touch records currently in the failed
      // state (no point writing the same status back, and don't
      // overwrite a more advanced state like "delivered" or "read").
      const patch = {};
      if (echoMedia) patch.media = echoMedia;
      if (existing.chatId && existing.msgKey) {
        const existingMsg = await fbGet(env, `${ROOT}/chats/${encodeKey(existing.chatId)}/messages/${existing.msgKey}`);
        if (existingMsg?.status === "failed") {
          patch.status = "sent";
          patch.healedAt = ts;
          patch.error = null;
        }
        if (Object.keys(patch).length > 0) {
          await fbPatch(env, `${ROOT}/chats/${encodeKey(existing.chatId)}/messages/${existing.msgKey}`, patch);
        }
      }
      return json({ ok: true, dedup: true });
    }
  }

  const media = extractMedia(msg);
  // v1.265: parse shared WhatsApp contacts (vCard messages) into a structured
  // form the bubble can render. Periskope sends message_type="vcard" with
  // body="N contacts" and a vcards: [...] array of vCard 3.0 strings.
  const contacts = parseVcards(msg?.vcards);
  const record = {
    direction: isFromMe ? "out" : "in",
    text: media?.caption || text,
    ts,
    periskopeMsgId,
    messageType,
    senderPhone,
    raw: msg,
  };
  if (media) record.media = media;
  if (contacts) record.contacts = contacts;

  const pushed = await fbPush(env, `${ROOT}/chats/${encodeKey(chatId)}/messages`, record);
  if (periskopeMsgId && pushed?.name) {
    await fbPut(env, `${ROOT}/byPeriskopeId/${encodeKey(periskopeMsgId)}`, {
      chatId,
      msgKey: pushed.name,
    });
  }
  // meta.phone always derives from the chat_id, which IS the customer (1-on-1)
  // or the group. For outbound messages sent OUTSIDE this dashboard (e.g.
  // directly from Periskope's UI), the webhook's sender_phone/sender_name are
  // the ORG's identity — never write that as chat-level meta.
  const metaUpdate = {
    chatId,
    chatType: isGroup ? "group" : "user",
    phone: chatIdToPhone(chatId),
    lastMsgAt: ts,
    lastMsgPreview: mediaPreview(media, messageType, text).slice(0, 120),
    lastMsgDirection: isFromMe ? "out" : "in",
  };
  // contactName: only learn from inbound senders on 1-on-1 chats. Outbound
  // sender info is OUR org, not the customer.
  if (!isGroup && !isFromMe && senderName) {
    metaUpdate.contactName = senderName;
  }
  await patchChatMeta(env, encodeKey(chatId), metaUpdate);

  // Record every group sender's phone in contacts/, even when sender_name is
  // missing (Periskope only knows the name if the org's WhatsApp has the
  // contact saved). The empty entry lets the dashboard's name-manager modal
  // surface this phone for manual labelling. Don't clobber an existing name.
  if (isGroup && senderPhone) {
    const phoneDigits = String(senderPhone).replace(/\D/g, "");
    if (phoneDigits) {
      const upd = { seenAt: Date.now() };
      if (senderName) { upd.name = senderName; upd.source = "webhook_sender"; }
      await fbPatch(env, `${ROOT}/contacts/${phoneDigits}`, upd);
    }
  }

  // Best-effort: if this is a group we haven't named yet, fetch the group name
  // from Periskope and write it. Webhook payloads don't include chat_name.
  if (isGroup) {
    try {
      const existingMeta = await fbGet(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`);
      if (!existingMeta?.groupName) {
        const cr = await fetch(`${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}`, {
          headers: periskopeHeaders(env),
        });
        if (cr.ok) {
          const cj = await safeJson(cr);
          const chat = cj?.chat || cj;
          if (chat?.chat_name) {
            await patchChatMeta(env, encodeKey(chatId), { groupName: chat.chat_name });
          }
        }
      }
    } catch { /* swallow — webhook should still succeed even if name lookup fails */ }
  }

  // AUTO-ROUTE for first-touch unowned chats (v1.125). When a brand-new
  // customer messages in and no chat-level meta existed before this webhook
  // (i.e., truly first contact), auto-create a ticket assigned to the
  // catch-all admin so somebody is on the hook. Without this, the strict
  // push rules from v1.120 would let first messages sit silent forever
  // (no tickets and no favorites yet, so nobody gets pinged).
  // Strictly first-touch — existing chats with prior activity skip this;
  // adding/removing tickets on those is a manual decision.
  if (!isFromMe && !isGroup) {
    try {
      // We read existingMeta ONLY in the group-name lookup below today;
      // duplicate the read here so the order is clear and we can branch
      // before the meta update overwrites lastMsgAt.
      const priorMeta = await fbGet(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`);
      const isFirstTouch = !priorMeta || !priorMeta.lastMsgAt;
      if (isFirstTouch) {
        const users = await fbGet(env, `${ROOT}/users`);
        let adminUid = null, adminName = "Admin";
        if (users && typeof users === "object") {
          for (const [uid, u] of Object.entries(users)) {
            if (String(u?.email || "").toLowerCase() === "rohit@aroleap.com") {
              adminUid = uid;
              adminName = u?.name || u?.email || "Admin";
              break;
            }
          }
        }
        if (adminUid) {
          const ticketId = generatePushKey(Date.now());
          const customerLabel = senderName || chatIdToPhone(chatId);
          await fbPut(env, `${ROOT}/tickets/${ticketId}`, {
            id: ticketId,
            title: `New customer — ${customerLabel} — needs triage`,
            anchorChatId: chatId,
            anchorMsgKey: pushed?.name || null,
            anchorText: (text || "").slice(0, 200),
            assignee: adminUid,
            assigneeName: adminName,
            status: "open",
            createdBy: "auto",
            createdByName: "Auto-route",
            createdAt: ts || Date.now(),
          });
          await fbPut(env, `${ROOT}/chats/${encodeKey(chatId)}/tickets/${ticketId}`, true);
        }
      }
    } catch (e) {
      // Swallow — auto-route is best-effort. Don't let a bad day for /users
      // or /tickets break webhook ACK.
      console.warn("[auto-route] failed:", e);
    }
  }

  // Push notification fan-out. Only ping mobile devices for INBOUND messages
  // (not for our own outbound echoes). Fire-and-forget so we don't slow the
  // webhook ACK that Periskope is waiting on. Targeting follows v1.120
  // strict rules: ticket assignees + favorites only. Auto-route above
  // ensures first-touch chats now have a ticket assigned to the admin
  // before this fanout fires.
  if (!isFromMe) {
    const senderLabel = (!isGroup && senderName) ? senderName :
                        (isGroup ? `Group ${chatIdToPhone(chatId)}` : chatIdToPhone(chatId));
    const bodyText = mediaPreview(media, messageType, text);
    if (typeof globalThis.queueMicrotask === "function") {
      globalThis.queueMicrotask(() => {
        fanoutPush(env, {
          title: senderLabel,
          body: bodyText.slice(0, 200),
          data: { chatKey: encodeKey(chatId), chatId },
          chatId,
        }).catch(e => console.warn("[push] fanout failed:", e));
      });
    }
  }

  // Best-effort AI triage — tag urgency/intent on inbound (1-on-1) messages
  // so the dashboard can surface urgent chats. Fire-and-forget; don't block
  // the webhook ACK. Skip groups (too noisy) and our own outbound echoes.
  if (!isFromMe && !isGroup && (text || media)) {
    if (typeof globalThis.queueMicrotask === "function") {
      globalThis.queueMicrotask(() => {
        triageInbound(env, { chatId, text, media, messageType }).catch(() => {});
      });
    }
  }

  return json({ ok: true, event: evtType });
}

// ---------- /register-push-token (mobile clients) ----------
// Mobile clients call this once per sign-in. We stamp the token under
// commonComm/pushTokens/{uid}/{tokenKey} so handleWebhook can broadcast.
async function handleRegisterPushToken(request, env) {
  const body = await request.json().catch(() => ({}));
  const { uid, token, platform } = body || {};
  if (!uid || !token) return json({ error: "missing uid/token" }, 400);
  const tokenKey = encodeKey(token);
  await fbPatch(env, `${ROOT}/pushTokens/${uid}/${tokenKey}`, {
    token,
    platform: platform || "unknown",
    lastSeen: Date.now(),
  });
  return json({ ok: true });
}

// ---------- Push fan-out (Expo Push Service) ----------
// Reads every registered token across the org and POSTs to Expo's push API.
// Expo accepts up to 100 notifications per request; we batch accordingly.
//
// Targeting (v1.120 strict rules — see resolvePushTargetUids):
//   - Open-ticket assignees on this chat get pinged
//   - Anyone who starred this chat gets pinged
//   - Nobody else. No broadcast. No admin safety net. New unticketed
//     chats are silent until someone takes ownership or stars them.
//
// Trade-off: a new customer's first message can sit unread if nobody is
// watching the dashboard. The pre-v1.120 broadcast was the worse option —
// every trainer's phone buzzed on every inbound, trained people to mute
// the app entirely.
async function fanoutPush(env, { title, body, data, chatId }) {
  const targetUids = await resolvePushTargetUids(env, chatId);
  // v1.120: targetUids is always a Set. If empty (no tickets, no stars),
  // nobody is pinged. No broadcast fallback — silence by design.
  if (targetUids.size === 0) return;
  return sendPushToUids(env, targetUids, { title, body, data });
}

// Push to an explicit set of UIDs. Bypasses the strict ticket/favorite
// targeting rules. Used by:
//   - fanoutPush (after it resolves targets via the strict rules)
//   - /send when a mention list is present (v1.130) — the mentioned UIDs
//     get pinged regardless of ticket or star, because @ is an explicit
//     "hey, you, look at this" signal that shouldn't be silenced.
async function sendPushToUids(env, uidSet, { title, body, data }) {
  if (!uidSet || uidSet.size === 0) return;
  const all = await fbGet(env, `${ROOT}/pushTokens`);
  if (!all || typeof all !== "object") return;

  const messages = [];
  for (const [uid, userMap] of Object.entries(all)) {
    if (!userMap || typeof userMap !== "object") continue;
    if (!uidSet.has(uid)) continue;
    for (const entry of Object.values(userMap)) {
      if (!entry || !entry.token) continue;
      // Expo tokens look like "ExponentPushToken[...]" — skip anything that
      // doesn't match so we never POST garbage upstream.
      if (!/^ExponentPushToken\[.+\]$/.test(entry.token)) continue;
      messages.push({
        to: entry.token,
        title,
        body,
        data,
        sound: "default",
        priority: "high",
        channelId: "default",
      });
    }
  }
  if (!messages.length) return;
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (env.EXPO_ACCESS_TOKEN) headers["Authorization"] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });
    } catch (e) { /* swallow — push is best-effort */ }
  }
}

// Returns a Set of uids to push to. v1.120 strict rules — no more broadcast,
// no more admin safety net. Notify only:
//   1. Users with an open ticket assigned to them on this chat
//   2. Users who have starred (favorited) this chat
// Otherwise: empty set → fanoutPush sends to nobody.
//
// Two reads per inbound: chat tickets + userState (favorites). Both are
// small (<= a few KB combined for a typical org). Fine on every webhook.
async function resolvePushTargetUids(env, chatId) {
  if (!chatId) return new Set();
  const chatKey = encodeKey(chatId);

  const targets = new Set();

  // 1. Open ticket assignees on this chat.
  const ticketIdsMap = await fbGet(env, `${ROOT}/chats/${chatKey}/tickets`);
  if (ticketIdsMap && typeof ticketIdsMap === "object") {
    for (const id of Object.keys(ticketIdsMap)) {
      const t = await fbGet(env, `${ROOT}/tickets/${id}`);
      if (t && t.status === "open" && t.assignee) {
        targets.add(String(t.assignee));
      }
    }
  }

  // 2. Users who have starred this chat. userState is keyed by uid; each
  // user's favorites map is a flat { chatKey: true } object. We iterate
  // every user once and check whether they've starred *this* chatKey.
  const userState = await fbGet(env, `${ROOT}/userState`);
  if (userState && typeof userState === "object") {
    for (const [uid, st] of Object.entries(userState)) {
      if (st && st.favorites && st.favorites[chatKey] === true) {
        targets.add(uid);
      }
    }
  }

  return targets;
}

// AI triage: classify an inbound message into { urgency, intent } and stamp
// it on chat meta so the dashboard can highlight urgent chats. Best-effort —
// failures return null and the message is still delivered normally.
const TRIAGE_SYSTEM_PROMPT = `Classify a single inbound WhatsApp message from a fitness/wellness customer.

Reply with ONE LINE of compact JSON, no markdown, no commentary, exactly this shape:
{"urgency":"urgent|normal|low","intent":"complaint|question|booking|chitchat|other"}

Rules:
- urgent: angry tone, refund requests, cancellations, injuries, today/tomorrow-deadline asks, safety, no-show callouts
- normal: ordinary questions, scheduling, status updates that need a reply
- low: chitchat, thanks, emoji-only, "ok", read-receipts, automated text
- complaint: explicit dissatisfaction, problem reports
- question: asking how/what/when/why
- booking: scheduling, rescheduling, location/time confirmation
- chitchat: greetings, thanks, casual banter
- other: anything else`;

async function classifyTriage(env, body) {
  if (!env.CLAUDE_API_KEY) return null;
  const trimmed = String(body || "").trim().slice(0, 500);
  if (!trimmed) return null;

  let claudeJson;
  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 60,
        system: TRIAGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: trimmed }],
      }),
    });
    if (!claudeRes.ok) return null;
    claudeJson = await safeJson(claudeRes);
  } catch { return null; }

  const raw = claudeJson?.content?.[0]?.text || "";
  let parsed;
  try {
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    parsed = JSON.parse(cleaned);
  } catch { return null; }

  const allowedUrgency = new Set(["urgent", "normal", "low"]);
  const allowedIntent = new Set(["complaint", "question", "booking", "chitchat", "other"]);
  const urgency = allowedUrgency.has(parsed?.urgency) ? parsed.urgency : "normal";
  const intent = allowedIntent.has(parsed?.intent) ? parsed.intent : "other";
  return { urgency, intent };
}

async function triageInbound(env, { chatId, text, media, messageType }) {
  const chatKey = encodeKey(chatId);
  const body = (text || "").trim() || (media ? `[${messageType || "media"}: ${media.fileName || ""}]` : "");
  const result = await classifyTriage(env, body);
  if (!result) return;
  await patchChatMeta(env, chatKey, {
    triageUrgency: result.urgency,
    triageIntent: result.intent,
    triageAt: Date.now(),
  });
}

// ---------- /triage-backfill (one-shot pass over existing chats) ----------
// Chunked admin endpoint: pass { offset, limit, sinceDays }. Processes a
// window of chats whose latest message is INBOUND and within sinceDays.
// Returns { processed, total, nextOffset, done, triaged: [...] }. Dashboard
// loops until done.
//
// Why chunked: Cloudflare worker requests have a CPU budget; running Haiku
// on 500 chats in a single request would time out. Caller controls chunk
// size (default 20).
async function handleTriageBackfill(request, env) {
  if (!env.CLAUDE_API_KEY) return json({ error: "CLAUDE_API_KEY not configured" }, 500);
  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(40, Math.max(1, Number(body.limit) || 20));
  const sinceDays = Math.max(1, Number(body.sinceDays) || 30);
  const force = body.force === true; // re-triage even if triageAt is already newer than the message

  const cutoff = Date.now() - sinceDays * 24 * 60 * 60 * 1000;

  // Single Firebase read of all chat metas. Cheap relative to the AI calls.
  const chats = await fbGet(env, `${ROOT}/chats`);
  if (!chats || typeof chats !== "object") {
    return json({ processed: 0, total: 0, nextOffset: null, done: true, triaged: [] });
  }

  // Filter to "candidate" chats: latest message is inbound + recent.
  // Skip groups (we don't triage groups in handleWebhook either).
  // Skip already-triaged unless force=true.
  const candidates = [];
  for (const [chatKey, chat] of Object.entries(chats)) {
    const meta = chat?.meta || {};
    if (meta.chatType === "group" || String(meta.chatId || "").endsWith("@g.us")) continue;
    if (meta.lastMsgDirection !== "in") continue;
    if (!meta.lastMsgAt || meta.lastMsgAt < cutoff) continue;
    const preview = String(meta.lastMsgPreview || "").trim();
    if (!preview) continue;
    if (!force && meta.triageAt && meta.triageAt >= meta.lastMsgAt) continue;
    candidates.push({ chatKey, meta });
  }
  // Stable order by lastMsgAt desc so chunking is deterministic across requests.
  candidates.sort((a, b) => (b.meta.lastMsgAt || 0) - (a.meta.lastMsgAt || 0));

  const slice = candidates.slice(offset, offset + limit);
  const triaged = [];

  for (const { chatKey, meta } of slice) {
    const result = await classifyTriage(env, meta.lastMsgPreview);
    if (!result) {
      triaged.push({ chatKey, error: "classify_failed" });
      continue;
    }
    await patchChatMeta(env, chatKey, {
      triageUrgency: result.urgency,
      triageIntent: result.intent,
      triageAt: Date.now(),
    });
    triaged.push({ chatKey, ...result });
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= candidates.length;
  return json({
    processed: slice.length,
    total: candidates.length,
    nextOffset: done ? null : nextOffset,
    done,
    triaged,
  });
}

// ---------- /backfill-chats-index (one-shot migration) ----------
// Copies every existing /chats/{k}/meta into /chatsIndex/{k} so the phone app
// can subscribe to the meta-only index path on cold start (instead of pulling
// every message of every chat through the /chats subtree). Run once after
// deploying the dual-write change; idempotent — safe to re-run, and only
// writes when the index entry is missing or out of date.
//
// Chunked the same way /triage-backfill is: caller passes { offset, limit },
// loops until done=true. We sort chatKeys deterministically so chunks line up
// across requests.
async function handleBackfillChatsIndex(request, env) {
  const body = await request.json().catch(() => ({}));
  const offset = Math.max(0, Number(body.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(body.limit) || 200));

  const chats = await fbGet(env, `${ROOT}/chats`);
  if (!chats || typeof chats !== "object") {
    return json({ processed: 0, total: 0, nextOffset: null, done: true, written: 0 });
  }
  const existingIndex = (await fbGet(env, `${ROOT}/chatsIndex`)) || {};

  const chatKeys = Object.keys(chats).sort();
  const slice = chatKeys.slice(offset, offset + limit);

  const updates = {};
  let written = 0;
  for (const chatKey of slice) {
    const meta = chats[chatKey]?.meta;
    if (!meta || typeof meta !== "object") continue;
    const existing = existingIndex[chatKey];
    // Skip when the index already has equal-or-newer lastMsgAt — a concurrent
    // dual-write may have moved ahead of the /chats snapshot we read; we must
    // never downgrade the index with stale data.
    const metaTs = meta.lastMsgAt || 0;
    const existingTs = (existing && existing.lastMsgAt) || 0;
    if (existing && existingTs >= metaTs) {
      continue;
    }
    // Field-level paths (not a subtree replacement) so a concurrent live
    // dual-write that adds a NEW field to chatsIndex/{k} doesn't get clobbered
    // by this write.
    for (const [field, value] of Object.entries(meta)) {
      updates[`${ROOT}/chatsIndex/${chatKey}/${field}`] = value;
    }
    written++;
  }

  if (Object.keys(updates).length > 0) {
    await fbPatchRoot(env, updates);
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= chatKeys.length;
  return json({
    processed: slice.length,
    total: chatKeys.length,
    nextOffset: done ? null : nextOffset,
    done,
    written,
  });
}

// ---------- /backfill-resolution-notes (one-shot migration) ----------
// For every ticket where status=resolved AND resolutionNote is non-empty AND
// anchorChatId is set, mirror the resolution into the chat's notes feed —
// same shape the live resolveTicket flow now writes (v1.090). Idempotent:
// scans existing notes for source=ticket_resolution + matching ticketId, and
// skips any ticket whose mirror is already present. Safe to re-run.
async function handleBackfillResolutionNotes(request, env) {
  const tickets = await fbGet(env, `${ROOT}/tickets`);
  if (!tickets || typeof tickets !== "object") {
    return json({ scanned: 0, mirrored: 0, skipped: 0, results: [] });
  }

  // Build a set of ticketIds that already have a mirror so we don't dup.
  const chats = await fbGet(env, `${ROOT}/chats`);
  const alreadyMirrored = new Set();
  if (chats && typeof chats === "object") {
    for (const chat of Object.values(chats)) {
      const notes = chat?.notes;
      if (!notes || typeof notes !== "object") continue;
      for (const n of Object.values(notes)) {
        if (n && n.source === "ticket_resolution" && n.ticketId) {
          alreadyMirrored.add(String(n.ticketId));
        }
      }
    }
  }

  const updates = {};
  let scanned = 0, mirrored = 0, skipped = 0;
  const results = [];

  for (const [id, t] of Object.entries(tickets)) {
    scanned++;
    if (!t || t.status !== "resolved") { skipped++; continue; }
    const note = (t.resolutionNote || "").trim();
    if (!note) { skipped++; continue; }
    if (!t.anchorChatId) { skipped++; continue; }
    if (alreadyMirrored.has(String(id))) {
      skipped++;
      results.push({ ticketId: id, status: "already_mirrored" });
      continue;
    }

    // Generate a Firebase push key client-side so the multi-path PATCH stays
    // a single subrequest. Push keys are lexicographically ordered by time;
    // we anchor them to resolvedAt so the mirrored notes sort naturally
    // alongside any manually-added notes from the same period.
    const chatKey = encodeKey(t.anchorChatId);
    const noteKey = generatePushKey(t.resolvedAt || Date.now());
    const titleHint = t.title ? ` "${t.title}"` : "";
    updates[`${ROOT}/chats/${chatKey}/notes/${noteKey}`] = {
      text: `🎫 Resolved ticket${titleHint}: ${note}`,
      authorUid: t.resolvedBy || null,
      authorName: t.resolvedByName || "(unknown)",
      createdAt: t.resolvedAt || Date.now(),
      source: "ticket_resolution",
      ticketId: id,
      backfilled: true,
    };
    mirrored++;
    results.push({ ticketId: id, chatKey, status: "mirrored" });
  }

  if (Object.keys(updates).length > 0) {
    await fbPatchRoot(env, updates);
  }

  return json({ scanned, mirrored, skipped, results });
}

// Firebase RTDB push-key generator. Same algorithm as the JS SDK: 8 chars
// of timestamp + 12 chars of randomness, all in a 64-char alphabet that
// preserves lex order. Used by the one-shot migration so we can write all
// the mirror notes in a single multi-path PATCH without one push() per note.
const PUSH_CHARS = "-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz";
function generatePushKey(now) {
  let ts = now;
  const timeChars = new Array(8);
  for (let i = 7; i >= 0; i--) {
    timeChars[i] = PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  let id = timeChars.join("");
  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(Math.floor(Math.random() * 64));
  }
  return id;
}

// ---------- /messages?chatId=...  (reconciliation poller fallback) ----------
// ---------- /backfill-batch (admin-triggered import from Periskope) ----------
// Two modes:
//   1. Existing chats only — pass { chatIds: [...], msgsPerChat }. Skips Periskope chat-list.
//   2. All Periskope chats — pass { chatOffset, chatLimit, msgsPerChat, chatType? }.
//      chatType: "user" (default) | "group" | "" for both.
async function handleBackfillBatch(request, env) {
  const body = await request.json().catch(() => ({}));
  const msgsPerChat = Math.min(500, Math.max(1, Number(body.msgsPerChat) || 100));

  let chats = [];
  let total = 0;
  let nextOffset = null;
  let done = false;

  if (Array.isArray(body.chatIds) && body.chatIds.length > 0) {
    // Mode 1: explicit chat list from dashboard
    chats = body.chatIds.map(id => ({ chat_id: id, chat_name: null }));
    total = chats.length;
    done = true; // dashboard chunks its own batches; no pagination on our side
  } else {
    // Mode 2: full Periskope list
    const chatOffset = Math.max(0, Number(body.chatOffset) || 0);
    const chatLimit = Math.min(10, Math.max(1, Number(body.chatLimit) || 3));
    const allowedTypes = new Set(["user", "group", "business"]);
    const rawType = body.chatType === undefined ? "user" : String(body.chatType || "");
    const typeQs = (rawType && allowedTypes.has(rawType)) ? `&chat_type=${rawType}` : "";
    const chatsRes = await fetch(
      `${PERISKOPE_BASE}/chats?offset=${chatOffset}&limit=${chatLimit}${typeQs}`,
      { headers: periskopeHeaders(env) }
    );
    const chatsJson = await safeJson(chatsRes);
    if (!chatsRes.ok) return json({ error: "list_chats_failed", details: chatsJson }, 502);
    chats = chatsJson?.chats || [];
    total = chatsJson?.count || 0;
    nextOffset = chatOffset + chats.length;
    done = chats.length === 0 || nextOffset >= total;
  }

  const processed = [];
  for (const c of chats) {
    try {
      processed.push(await backfillOneChat(env, c, msgsPerChat));
    } catch (e) {
      processed.push({ chatId: c.chat_id, error: String(e && e.message || e) });
    }
  }

  return json({ processed, total, nextOffset, done });
}

async function backfillOneChat(env, chat, msgsPerChat) {
  const chatId = chat.chat_id;
  if (!chatId) return { error: "no chatId" };
  const chatKey = encodeKey(chatId);
  const isGroup = chatId.endsWith("@g.us");

  // (1) Fetch messages from Periskope
  const msgsRes = await fetch(
    `${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}/messages?offset=0&limit=${msgsPerChat}`,
    { headers: periskopeHeaders(env) }
  );
  const msgsJson = await safeJson(msgsRes);
  if (!msgsRes.ok) return { chatId, error: "msgs_fetch_failed" };
  const messages = msgsJson?.messages || [];

  // (2) Fetch existing in-chat messages. Build TWO maps:
  //   existingById: periskopeMsgId -> { msgKey, existing record }
  //   This lets us either (a) skip if already complete, or (b) UPGRADE the
  //   existing record when Periskope now returns media we previously failed
  //   to extract. The upgrade path is what repairs records written by older
  //   worker versions whose extractMedia returned null.
  const existingMsgs = await fbGet(env, `${ROOT}/chats/${chatKey}/messages`);
  const existingById = new Map();
  if (existingMsgs && typeof existingMsgs === "object") {
    for (const [key, m] of Object.entries(existingMsgs)) {
      if (m && m.periskopeMsgId) existingById.set(m.periskopeMsgId, { msgKey: key, record: m });
    }
  }

  // (3) Fetch existing meta
  const existingMeta = await fbGet(env, `${ROOT}/chats/${chatKey}/meta`);

  // Build multi-path update
  const updates = {};
  let written = 0, upgraded = 0, latestTs = 0, latestPreview = "", latestDir = "in";

  for (const m of messages) {
    const id = m.message_id || m.unique_id || m.id?.serialized || null;
    if (!id) continue;

    const isFromMe = m.from_me === true;
    const text = m.body || "";
    const ts = parseTs(m.timestamp);
    const senderPhone = m.sender_phone ? String(m.sender_phone).split("@")[0] : chatIdToPhone(chatId);
    const media = extractMedia(m);

    const prior = existingById.get(id);
    if (prior) {
      // Already imported. If Periskope now has media AND the stored record
      // is missing the URL (older worker / optimistic-send write), patch it.
      const priorMediaUrl = prior.record?.media?.url || null;
      if (media && media.url && !priorMediaUrl) {
        updates[`${ROOT}/chats/${chatKey}/messages/${prior.msgKey}/media`] = media;
        if (m.message_type) {
          updates[`${ROOT}/chats/${chatKey}/messages/${prior.msgKey}/messageType`] = m.message_type;
        }
        upgraded++;
      }
      continue;
    }

    const msgKey = encodeKey(id);
    const msgRecord = {
      direction: isFromMe ? "out" : "in",
      text: media?.caption || text,
      ts,
      periskopeMsgId: id,
      messageType: m.message_type || "text",
      senderPhone,
      backfilled: true,
    };
    if (media) msgRecord.media = media;
    // v1.265: same vCard extraction as the webhook path so backfilled
    // contact-share messages also render properly.
    const backfillContacts = parseVcards(m?.vcards);
    if (backfillContacts) msgRecord.contacts = backfillContacts;
    updates[`${ROOT}/chats/${chatKey}/messages/${msgKey}`] = msgRecord;
    updates[`${ROOT}/byPeriskopeId/${msgKey}`] = { chatId, msgKey };
    written++;

    if (ts > latestTs) {
      latestTs = ts;
      latestPreview = mediaPreview(media, m.message_type, text).slice(0, 120);
      latestDir = isFromMe ? "out" : "in";
    }
  }

  // Identity meta (chatId/phone/chatType/groupName/contactName) is written every
  // time we successfully hit Periskope for this chat — even if no new messages
  // were imported. This is what fixes "Unnamed group" rows that exist in Firebase
  // (from old webhook events) but never get new messages.
  updates[`${ROOT}/chats/${chatKey}/meta/chatId`] = chatId;
  updates[`${ROOT}/chats/${chatKey}/meta/phone`] = chatIdToPhone(chatId);
  updates[`${ROOT}/chats/${chatKey}/meta/chatType`] = isGroup ? "group" : "user";

  // For group chats: record every sender's phone in contacts/ so the dashboard
  // can list them for manual naming. Dedup within this batch with a Set.
  if (isGroup) {
    const seenSenders = new Set();
    for (const m of messages) {
      const sp = m.sender_phone ? String(m.sender_phone).split("@")[0].replace(/\D/g, "") : null;
      if (sp && !seenSenders.has(sp)) {
        seenSenders.add(sp);
        // Only set seenAt (not name) here — we may not have it from message data.
        // /fetch-chat-info populates names from the chat's members map.
        updates[`${ROOT}/contacts/${sp}/seenAt`] = Date.now();
      }
    }
  }
  if (chat.chat_name) {
    if (isGroup) {
      if (!existingMeta?.groupName) {
        updates[`${ROOT}/chats/${chatKey}/meta/groupName`] = chat.chat_name;
      }
    } else if (!existingMeta?.contactName) {
      updates[`${ROOT}/chats/${chatKey}/meta/contactName`] = chat.chat_name;
    }
  }
  // lastMsg* only updates when we actually have a newer message — never clobber
  // real activity with stale data.
  if (written > 0 && latestTs > 0 && (!existingMeta?.lastMsgAt || latestTs > existingMeta.lastMsgAt)) {
    updates[`${ROOT}/chats/${chatKey}/meta/lastMsgAt`] = latestTs;
    updates[`${ROOT}/chats/${chatKey}/meta/lastMsgPreview`] = latestPreview;
    updates[`${ROOT}/chats/${chatKey}/meta/lastMsgDirection`] = latestDir;
  }

  // (4) Atomic multi-path PATCH at root - one subrequest for all writes.
  // Mirror any chats/{k}/meta/* fields to chatsIndex/{k}/* in the same patch
  // so the phone app's list listener sees the latest meta without diving
  // into the messages subtree.
  if (Object.keys(updates).length > 0) {
    mirrorChatsMetaToIndex(updates);
    await fbPatchRoot(env, updates);
  }

  return {
    chatId,
    name: chat.chat_name || chatIdToPhone(chatId),
    written,
    upgraded,
    skipped: messages.length - written - upgraded,
    fetched: messages.length,
  };
}

// ---------- /fetch-chat-info (single-chat name/meta refresh from Periskope) ----------
// Used when we know a chat exists in Firebase but its name is missing (typically
// groups created from webhook events, since the webhook payload doesn't include
// the group's chat_name). Caller passes { chatId }. We fetch GET /chats/{id} and
// write the chat_name into meta.groupName (for groups) or meta.contactName (for users).
async function handleFetchChatInfo(request, env) {
  const body = await request.json().catch(() => ({}));
  const chatId = body?.chatId;
  if (!chatId) return json({ error: "missing chatId" }, 400);

  const r = await fetch(`${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}`, {
    headers: periskopeHeaders(env),
  });
  const j = await safeJson(r);
  if (!r.ok) return json({ error: "fetch_failed", details: j }, 502);

  // Response can be the chat object directly or wrapped { chat: {...} }
  const chat = j?.chat || j;
  const chatName = chat?.chat_name || null;
  const isGroup = String(chatId).endsWith("@g.us");

  // Multi-path update so it's a single Firebase request.
  const updates = {};
  updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/chatId`] = chatId;
  updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/chatType`] = isGroup ? "group" : "user";
  updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/phone`] = chatIdToPhone(chatId);
  if (chatName) {
    if (isGroup) updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/groupName`] = chatName;
    else        updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/contactName`] = chatName;
  }
  let membersWritten = 0;
  // v1.244: also write a phone-set under meta/memberPhones for group chats so
  // the dashboard can build a phone → daily-group-code reverse index without
  // re-querying Periskope. Always overwrite (not patch) — Periskope's
  // chat.members IS the source of truth for current membership, and we want
  // removed members to disappear from our index. Skip for user chats (1:1).
  const memberPhonesMap = {};
  if (chat?.members && typeof chat.members === "object") {
    for (const m of Object.values(chat.members)) {
      if (!m) continue;
      const phone = String(m.contact_id || "").split("@")[0].replace(/\D/g, "");
      if (!phone) continue;
      memberPhonesMap[phone] = true;
      const name = m.contact_name;
      if (!name) continue;
      updates[`${ROOT}/contacts/${phone}/name`] = name;
      updates[`${ROOT}/contacts/${phone}/source`] = "group_members";
      updates[`${ROOT}/contacts/${phone}/seenAt`] = Date.now();
      membersWritten++;
    }
  }
  if (isGroup) {
    // Always write — even an empty {} signals "we've checked and found none"
    // so the client doesn't keep retrying the backfill in a loop.
    updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/memberPhones`] = memberPhonesMap;
    updates[`${ROOT}/chats/${encodeKey(chatId)}/meta/memberPhonesAt`] = Date.now();
  }
  mirrorChatsMetaToIndex(updates);
  await fbPatchRoot(env, updates);
  return json({ ok: true, chatId, chatName, isGroup, membersWritten });
}

// Pull a normalized media descriptor out of a Periskope message payload.
// Returns null for plain-text messages. Periskope's real shape uses:
//   media.path     (the URL — NOT media.url)
//   media.mimetype (NOT mime_type)
//   media.filename (NOT file_name)
//   media.size     (NOT file_size)
// We also check the camelCase / snake_case alternatives just in case the API
// shape evolves or differs between event types.
function extractMedia(msg) {
  if (!msg) return null;
  const mediaObj = msg.media || msg.attachment || null;
  if (!mediaObj || typeof mediaObj !== "object") return null;
  const url = mediaObj.path || mediaObj.url || mediaObj.media_url || mediaObj.link || mediaObj.href || null;
  if (!url) return null;
  return {
    url,
    mimeType: mediaObj.mimetype || mediaObj.mime_type || mediaObj.mimeType || mediaObj.contentType || null,
    fileName: mediaObj.filename || mediaObj.file_name || mediaObj.fileName || mediaObj.name || null,
    fileSize: mediaObj.size || mediaObj.file_size || mediaObj.fileSize || null,
    caption:  mediaObj.caption  || null,
  };
}

// v1.265: parse a single vCard 3.0 string into { name, phones }. Periskope
// sends shared WhatsApp contacts as message_type="vcard" with a `vcards`
// array of vCard strings. Sample line shapes:
//   FN:Night Watchmen SR Residency Gunjur
//   N:Gunjur;Night Watchmen SR;Residency;;
//   item1.TEL;waid=918083152313:+91 80831 52313
//   item1.X-ABLabel:Other
//   X-WA-BIZ-NAME:...
// Returns null if neither name nor phone can be extracted.
function parseVcard(text) {
  if (!text || typeof text !== "string") return null;
  const lines = text.split(/\r?\n/);
  let fn = null;
  let nFallback = null;
  const phones = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const head = line.slice(0, colon);
    const val = line.slice(colon + 1).trim();
    // Strip any "itemN." property-group prefix and parameter list after ;
    const key = head.replace(/^item\d+\./i, "").split(";")[0].toUpperCase();
    if (key === "FN" && !fn) {
      fn = val;
    } else if (key === "N" && !nFallback) {
      // N is structured "Family;Given;Middle;Prefix;Suffix". Use as
      // fallback display name if FN is missing.
      const parts = val.split(";").filter((p) => p && p.trim());
      if (parts.length) nFallback = parts.join(" ").trim();
    } else if (key === "TEL") {
      // val might be "+91 80831 52313" or "918083152313" or similar.
      // Keep the display form for rendering; also derive a digits-only
      // canonical form for tel: links.
      const display = val;
      const digits = val.replace(/[^\d+]/g, "");
      if (digits) phones.push({ display, digits });
    }
  }
  const name = fn || nFallback || null;
  if (!name && phones.length === 0) return null;
  return { name, phones };
}

// Parse Periskope's vcards array. Returns null if nothing usable.
function parseVcards(arr) {
  if (!Array.isArray(arr)) return null;
  const out = [];
  for (const v of arr) {
    const c = parseVcard(v);
    if (c) out.push(c);
  }
  return out.length > 0 ? out : null;
}

// Pretty preview string for the chat list when a message is media-only.
function mediaPreview(media, messageType, fallbackText) {
  if (fallbackText) return fallbackText;
  if (media?.caption) return media.caption;
  const mt = (media?.mimeType || messageType || "").toLowerCase();
  if (mt.startsWith("image") || mt === "image") return "📷 Photo";
  if (mt.startsWith("video") || mt === "video") return "🎥 Video";
  if (mt.startsWith("audio") || mt === "audio" || mt === "ptt") return "🎤 Voice note";
  if (mt.startsWith("document") || mt === "document") return `📎 ${media?.fileName || "Document"}`;
  if (mt === "sticker") return "🖼 Sticker";
  return `📎 ${media?.fileName || "Attachment"}`;
}

// ---------- /media (proxy media from Periskope through the worker) ----------
// Periskope media URLs often require the same Bearer + x-phone auth that the
// REST API uses, so the dashboard can't <img src=> them directly. We proxy
// the fetch here, attach the auth headers, and stream the bytes back.
async function handleMediaProxy(request, env) {
  const url = new URL(request.url);
  const u = url.searchParams.get("u");
  if (!u) return new Response("missing ?u", { status: 400 });
  // Only allow Periskope-hosted URLs (and a sensible CDN allow-list) so this
  // can't be abused as an open proxy. Periskope stores attachments on Google
  // Cloud Storage — googleapis / googleusercontent — so those are in the
  // allow-list even though they aren't periskope.app domains.
  let host;
  try { host = new URL(u).hostname; } catch { return new Response("bad url", { status: 400 }); }
  const ok = (
    host.endsWith(".periskope.app") ||
    host.endsWith("periskope.app") ||
    host.endsWith(".whatsapp.net") ||
    host.endsWith(".cdninstagram.com") ||
    host.endsWith(".fbcdn.net") ||
    host.endsWith(".supabase.co") ||
    host.endsWith("amazonaws.com") ||
    host === "storage.googleapis.com" ||
    host.endsWith(".storage.googleapis.com") ||
    host.endsWith(".googleusercontent.com") ||
    // v1.174: DM attachments live in motherofdashboard's Firebase Storage
    // bucket. Both renderers now skip the proxy for these URLs (they're
    // publicly fetchable with the ?alt=media&token=... query), but keep
    // the host allow-listed in case any older client still routes through
    // here — better a working render than a 403.
    host === "firebasestorage.googleapis.com"
  );
  if (!ok) return new Response("host not allowed: " + host, { status: 403 });

  // Forward Range header so <video>/<audio> tags can stream + seek. Without
  // this the proxy always returns 200 with the whole body; Chrome's video
  // element will refuse to play larger files and shows an empty 0:00 player.
  const range = request.headers.get("Range");
  const upstreamHeaders = { ...periskopeHeaders(env) };
  if (range) upstreamHeaders["Range"] = range;

  let r = await fetch(u, { headers: upstreamHeaders });
  // Public resources reject the Periskope Authorization header with 401; retry
  // without auth in that case.
  if (!r.ok && r.status === 401) {
    const retryHeaders = range ? { Range: range } : {};
    r = await fetch(u, { headers: retryHeaders });
  }
  if (!r.ok && r.status !== 206) return new Response(`upstream ${r.status}`, { status: 502 });

  // Pass through the headers a browser needs for ranged streaming. The body
  // is streamed by passing r.body through — no buffering in worker memory.
  const respHeaders = {
    "Content-Type": r.headers.get("Content-Type") || "application/octet-stream",
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes",
  };
  const cl = r.headers.get("Content-Length");
  if (cl) respHeaders["Content-Length"] = cl;
  const cr = r.headers.get("Content-Range");
  if (cr) respHeaders["Content-Range"] = cr;
  return new Response(r.body, { status: r.status, headers: respHeaders });
}

// ---------- /dm-media/upload (R2 upload for internal-DM attachments) -------
// Multipart upload. Form fields:
//   file     — the blob
//   pairKey  — DM pair key (uidA_uidB, sorted)
//   msgId    — Firebase RTDB message key (for namespacing)
// Returns: { ok: true, url: "<WORKER_ORIGIN>/dm-media/<key>", key: "<key>" }.
// Caps the file at 25 MB to match MAX_MEDIA_BYTES on the client.
async function handleDmMediaUpload(request, env) {
  if (!env.DM_MEDIA) {
    return json({ error: "R2 bucket DM_MEDIA not bound" }, 500);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "bad multipart: " + String(e?.message || e) }, 400);
  }
  const file = form.get("file");
  const pairKey = String(form.get("pairKey") || "");
  const msgId = String(form.get("msgId") || "");
  // v1.177: callers identify themselves with fromUid so we can rate-limit
  // per-user. Spoofable, but the global cap still applies so worst case
  // a malicious client just consumes their share of the global pool.
  const fromUid = String(form.get("fromUid") || "");
  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  if (!pairKey || !msgId) return json({ error: "missing pairKey or msgId" }, 400);
  // Path sanity — both pairKey and msgId are caller-provided so guard against
  // ".." or "/" walking us out of the namespace.
  if (/[\/\\.]/.test(pairKey.replace(/_/g, "")) || /[\/\\.]/.test(msgId)) {
    return json({ error: "bad pairKey or msgId" }, 400);
  }
  // file.size is available on the File object Cloudflare exposes.
  if (file.size > DM_MEDIA_MAX_BYTES) {
    return json({ error: `file too large (>${DM_MEDIA_MAX_BYTES / 1024 / 1024} MB)` }, 413);
  }

  // v1.177: daily quota gate. Rejects before we touch R2 so a rate-limited
  // call doesn't burn a Class A operation either.
  const quota = await checkAndIncrementDmUploadQuota(env, fromUid);
  if (!quota.ok) {
    return json({ error: quota.reason }, quota.status);
  }
  // v1.180: aggressively sanitize the filename. Anything outside the
  // URL-safe set becomes "_". This avoids the v1.176 bug where desktop
  // uploads like "Screenshot 2025-05-18.png" stored fine but the URL
  // we returned wasn't encoded — browsers fetched with %20 in the path,
  // R2 key still had a literal space, mismatch → 404 → broken image.
  // Sanitizing at upload means the key, the URL, and the request path
  // are all the same string regardless of encoding/decoding round-trips.
  const safeName =
    String(file.name || "file")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 200) || "file";
  const key = `dms/${pairKey}/${msgId}/${safeName}`;
  try {
    // arrayBuffer rather than stream() — small (≤25 MB) and avoids any
    // platform quirks with multipart File.stream() consumption inside
    // Workers. Memory is bounded by the size cap.
    const bytes = await file.arrayBuffer();
    await env.DM_MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return json({ error: "r2 put failed: " + String(e?.message || e) }, 500);
  }
  const origin = new URL(request.url).origin;
  return json({ ok: true, url: `${origin}/dm-media/${key}`, key });
}

// ---------- /dm-media/<key> (R2 read for internal-DM attachments) ---------
// Streams the bytes back. Supports Range so <video>/<audio> in browsers can
// seek without downloading the whole file. Anyone who has the URL gets the
// bytes — the URL itself is a capability (the random msgId is enough entropy
// that guessing is infeasible).
async function handleDmMediaGet(request, env) {
  if (!env.DM_MEDIA) {
    return new Response("R2 bucket DM_MEDIA not bound", { status: 500 });
  }
  const url = new URL(request.url);
  // Strip the leading "/dm-media/" prefix; rest is the R2 key.
  // v1.180: decode the path so any legacy URLs with %20 etc. round-trip
  // back to the stored key. New uploads sanitize names so the path is
  // always plain ASCII, but old DB rows could still hold the encoded form.
  let key;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/dm-media\//, ""));
  } catch {
    key = url.pathname.replace(/^\/dm-media\//, "");
  }
  if (!key) return new Response("missing key", { status: 400 });

  // Range support — parse a single "bytes=A-B" range. Multi-range isn't worth
  // the complexity for a chat-attachment use case.
  const rangeHeader = request.headers.get("Range");
  let r2Options;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      r2Options = { range: end !== undefined ? { offset, length: end - offset + 1 } : { offset } };
    }
  }

  const object = r2Options
    ? await env.DM_MEDIA.get(key, r2Options)
    : await env.DM_MEDIA.get(key);
  if (!object) return new Response("not found", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", object.httpMetadata?.cacheControl || "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  // R2's `range` field tells us what was actually returned.
  if (object.range) {
    const start = object.range.offset || 0;
    const len = object.range.length ?? (object.size - start);
    const endByte = start + len - 1;
    headers.set("Content-Range", `bytes ${start}-${endByte}/${object.size}`);
    headers.set("Content-Length", String(len));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// ---------- /template-media/upload (R2 upload for template assets) ---------
// v1.224. Multipart upload. Form fields:
//   file        — the blob
//   templateId  — the Firebase template key (for namespacing)
// Returns: { ok: true, url: "<WORKER_ORIGIN>/template-media/templates/<id>/<name>", key }
// Caps at the same 25 MB limit as dm-media. No per-user quota — templates
// are admin-only assets curated for the team, and Periskope itself enforces
// a ~16 MB per-message ceiling downstream, so abuse risk is low.
// Public read URLs so Periskope can fetch the media when relaying to
// the customer's WhatsApp; the random templateId is enough entropy that
// guessing other tenants' files is infeasible.
async function handleTemplateMediaUpload(request, env) {
  if (!env.DM_MEDIA) {
    return json({ error: "R2 bucket DM_MEDIA not bound" }, 500);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "bad multipart: " + String(e?.message || e) }, 400);
  }
  const file = form.get("file");
  const templateId = String(form.get("templateId") || "");
  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  if (!templateId) return json({ error: "missing templateId" }, 400);
  if (/[\/\\.]/.test(templateId)) {
    return json({ error: "bad templateId" }, 400);
  }
  if (file.size > DM_MEDIA_MAX_BYTES) {
    return json({ error: `file too large (>${DM_MEDIA_MAX_BYTES / 1024 / 1024} MB)` }, 413);
  }
  const safeName =
    String(file.name || "file")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 200) || "file";
  const key = `templates/${templateId}/${safeName}`;
  try {
    const bytes = await file.arrayBuffer();
    await env.DM_MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return json({ error: "r2 put failed: " + String(e?.message || e) }, 500);
  }
  const origin = new URL(request.url).origin;
  return json({
    ok: true,
    url: `${origin}/template-media/${key}`,
    key,
    mimeType: file.type || "application/octet-stream",
    fileName: safeName,
    sizeBytes: file.size,
  });
}

// ---------- /template-media/<key> (R2 read for template assets) ----------
// Mirrors handleDmMediaGet but strips "/template-media/" instead.
async function handleTemplateMediaGet(request, env) {
  if (!env.DM_MEDIA) {
    return new Response("R2 bucket DM_MEDIA not bound", { status: 500 });
  }
  const url = new URL(request.url);
  let key;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/template-media\//, ""));
  } catch {
    key = url.pathname.replace(/^\/template-media\//, "");
  }
  if (!key) return new Response("missing key", { status: 400 });
  const rangeHeader = request.headers.get("Range");
  let r2Options;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      r2Options = { range: end !== undefined ? { offset, length: end - offset + 1 } : { offset } };
    }
  }
  const object = r2Options
    ? await env.DM_MEDIA.get(key, r2Options)
    : await env.DM_MEDIA.get(key);
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", object.httpMetadata?.cacheControl || "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  if (object.range) {
    const start = object.range.offset || 0;
    const len = object.range.length ?? (object.size - start);
    const endByte = start + len - 1;
    headers.set("Content-Range", `bytes ${start}-${endByte}/${object.size}`);
    headers.set("Content-Length", String(len));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// ---------- /sa-upload, /sa-retranscribe, /sa-delete, /sa-media ----------
// v1.226. Strength-Assessment session recordings. Trainer uploads an MP3
// (or other audio) of a customer SA → worker stores it in R2 and writes
// a Firebase saSession record with status="queued" → then transcribes
// the audio in the BACKGROUND (ctx.waitUntil) so the browser doesn't
// hold the connection open for what could be minutes of audio. The UI
// watches /commonComm/chats/{chatKey}/saSessions via a regular onValue
// listener; the status field flips queued → transcribing → ready/failed
// and the transcript appears when the work completes.
//
// Why server-side transcription instead of browser-side (which is what
// the voice-note flow uses today): voice notes are short (≤30s) and the
// browser is happy to wait. SA sessions are 30–60 min. If the trainer
// closes the tab mid-transcription, browser-side would lose the work.
// Server-side keeps going even after the browser leaves.
//
// File size cap: 25 MB (Groq Whisper's per-request ceiling). At
// 64 kbps mono MP3 that's roughly 50 minutes of speech. Longer sessions
// need to be recorded at lower bitrate or split into chunks — a chunked
// transcription path is a v2 add when someone hits the limit.

const SA_MEDIA_MAX_BYTES = 25 * 1024 * 1024; // matches Groq Whisper cap
const SA_GROQ_MODEL = "whisper-large-v3";

// Multipart upload. Form fields:
//   file               — the audio blob
//   chatKey            — Firebase chat key the session belongs to
//   uploadedByUid      — trainer's UID (for the audit record)
//   uploadedByName     — trainer's display name (denormalized)
//   sessionAt          — optional epoch-ms when the SA actually happened
//                        (defaults to now)
// Returns: { ok, sessionId, audioUrl, key }
async function handleSaUpload(request, env, ctx) {
  if (!env.DM_MEDIA) {
    return json({ error: "R2 bucket DM_MEDIA not bound" }, 500);
  }
  if (!env.GROQ_API_KEY) {
    return json({
      error: "GROQ_API_KEY not set",
      hint: "Run: wrangler secret put GROQ_API_KEY",
    }, 500);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "bad multipart: " + String(e?.message || e) }, 400);
  }
  const file = form.get("file");
  const chatKey = String(form.get("chatKey") || "");
  const uploadedByUid = String(form.get("uploadedByUid") || "");
  const uploadedByName = String(form.get("uploadedByName") || "");
  const sessionAtRaw = form.get("sessionAt");
  const sessionAt = sessionAtRaw ? Number(sessionAtRaw) : Date.now();

  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  if (!chatKey) return json({ error: "missing chatKey" }, 400);
  if (!uploadedByUid) return json({ error: "missing uploadedByUid" }, 400);
  // Path-walk guard.
  if (/[\/\\.]/.test(chatKey.replace(/_/g, ""))) {
    return json({ error: "bad chatKey" }, 400);
  }
  if (file.size > SA_MEDIA_MAX_BYTES) {
    return json({
      error: `file too large (>${SA_MEDIA_MAX_BYTES / 1024 / 1024} MB). For longer recordings, export at 64 kbps mono MP3 or split into smaller chunks.`,
    }, 413);
  }

  // Generate a sessionId via Firebase push so it sorts chronologically
  // when listed (Firebase push keys are timestamp-prefixed). Doing it via
  // an actual push gives us a globally-unique key without any client
  // coordination.
  const pushed = await fbPush(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions`, {
    placeholder: true,
  });
  const sessionId = pushed?.name;
  if (!sessionId) {
    return json({ error: "couldn't allocate sessionId" }, 500);
  }

  const safeName =
    String(file.name || "session.mp3")
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 200) || "session.mp3";
  const key = `sa-sessions/${chatKey}/${sessionId}/${safeName}`;

  // Buffer the bytes here so we can both (a) put to R2 and (b) hand them
  // to the background transcribe task without re-fetching from R2.
  let bytes;
  try {
    bytes = await file.arrayBuffer();
    await env.DM_MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: file.type || "audio/mpeg",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    // Roll back the placeholder record we just created so the UI doesn't
    // show a phantom "queued" row that never moves.
    await fbPut(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`, null);
    return json({ error: "r2 put failed: " + String(e?.message || e) }, 500);
  }

  const origin = new URL(request.url).origin;
  const audioUrl = `${origin}/sa-media/${key}`;
  const audioFileName = safeName;
  const sizeBytes = file.size;
  const mimeType = file.type || "audio/mpeg";

  // Overwrite the placeholder with the real record. status="queued" is
  // the contract with the UI listener — render the row in "uploading…"
  // state until it flips to "transcribing" → "ready" / "failed".
  const record = {
    audioUrl,
    audioFileName,
    sizeBytes,
    mimeType,
    sessionAt,
    uploadedAt: Date.now(),
    uploadedByUid,
    uploadedByName: uploadedByName || null,
    status: "queued",
    groqModel: SA_GROQ_MODEL,
  };
  await fbPut(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`, record);

  // Fire-and-forget background transcription. ctx.waitUntil keeps the
  // worker alive past the response return so the Groq call can finish.
  ctx.waitUntil(transcribeSaSession(env, chatKey, sessionId, bytes, mimeType, audioFileName));

  return json({ ok: true, sessionId, audioUrl, key });
}

// v1.250: Dropbox auto-backup. After successful transcription, the worker
// uploads the audio bytes to the team's Dropbox account (app folder scoped
// → only the CommonComm app can read/write under /Apps/CommonComm/). This
// gives trainers an off-tablet backup + a humane file-browser UI without
// CommonComm having to write its own file management screens.
//
// Auth: refresh-token flow. The refresh token in env.DROPBOX_REFRESH_TOKEN
// never expires (app-folder-scoped apps issue long-lived refresh tokens).
// We trade it for a 4-hour access token on demand, cached in-isolate so
// repeat uploads within the cache window skip the refresh.
let _dropboxAccessTokenCache = { token: null, expiresAt: 0 };

async function getDropboxAccessToken(env) {
  // 60-second safety margin so we don't hand out a token that expires
  // mid-upload.
  if (
    _dropboxAccessTokenCache.token &&
    _dropboxAccessTokenCache.expiresAt > Date.now() + 60_000
  ) {
    return _dropboxAccessTokenCache.token;
  }
  if (!env.DROPBOX_REFRESH_TOKEN || !env.DROPBOX_APP_KEY || !env.DROPBOX_APP_SECRET) {
    throw new Error("Dropbox secrets not configured (DROPBOX_REFRESH_TOKEN / APP_KEY / APP_SECRET)");
  }
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.DROPBOX_REFRESH_TOKEN,
      client_id: env.DROPBOX_APP_KEY,
      client_secret: env.DROPBOX_APP_SECRET,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Dropbox token refresh ${res.status}: ${text.slice(0, 300)}`);
  }
  const j = await res.json();
  _dropboxAccessTokenCache = {
    token: j.access_token,
    expiresAt: Date.now() + (Number(j.expires_in) || 14400) * 1000,
  };
  return j.access_token;
}

// Upload `bytes` to Dropbox at `path` (path is RELATIVE to the app's
// sandbox root, e.g. "/sa-recordings/2026-05/sa-foo.m4a" lands at
// "/Apps/CommonComm/sa-recordings/2026-05/sa-foo.m4a" in the actual
// Dropbox UI). Returns { path, shareUrl } where shareUrl is a public
// link anyone can use to view/listen — useful for surfacing in the
// SA Sessions row on web + mobile.
async function dropboxUpload(env, path, bytes, contentType) {
  const accessToken = await getDropboxAccessToken(env);

  // Upload step. mode=add + autorename=true means an existing file at the
  // same path doesn't get overwritten — Dropbox appends " (1)" etc.
  // safer than mode=overwrite for a backup flow.
  const uploadRes = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": JSON.stringify({
        path,
        mode: "add",
        autorename: true,
        mute: true,
      }),
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => "");
    throw new Error(`Dropbox upload ${uploadRes.status}: ${text.slice(0, 300)}`);
  }
  const uploadJson = await uploadRes.json();
  const actualPath = uploadJson.path_display || path;

  // Shareable-link step. Optional — failure here doesn't fail the whole
  // upload, the file is still safely stored.
  let shareUrl = null;
  try {
    const shareRes = await fetch(
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: actualPath,
          settings: {
            requested_visibility: { ".tag": "public" },
            audience: { ".tag": "public" },
            access: { ".tag": "viewer" },
          },
        }),
      },
    );
    if (shareRes.ok) {
      const shareJson = await shareRes.json();
      shareUrl = shareJson.url || null;
    } else if (shareRes.status === 409) {
      // Conflict — a link for this path already exists (rare race; the
      // file was just uploaded with autorename so this shouldn't happen
      // unless we retry an idempotent transcribe). Look up the existing
      // link instead.
      const listRes = await fetch(
        "https://api.dropboxapi.com/2/sharing/list_shared_links",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: actualPath, direct_only: true }),
        },
      );
      if (listRes.ok) {
        const listJson = await listRes.json();
        shareUrl = listJson?.links?.[0]?.url || null;
      }
    }
  } catch (e) {
    // Swallow — shareUrl stays null, file is still uploaded.
    console.warn("[dropbox] share link failed:", String(e?.message || e));
  }

  // Convert the ?dl=0 default in Dropbox share URLs to ?raw=1 so the
  // audio player can stream the file directly without bouncing through
  // Dropbox's HTML preview page. Optional — both work in a browser,
  // but ?raw=1 is what an <audio> tag wants.
  let directUrl = shareUrl;
  if (directUrl) {
    directUrl = directUrl.replace(/\?dl=0$/, "?raw=1").replace(/\?dl=1$/, "?raw=1");
  }

  return { path: actualPath, shareUrl, directUrl };
}

// Strip filesystem-illegal characters but preserve Unicode (so Hindi /
// Kannada names survive). Cap length so paths don't explode.
function sanitizeNameForFs(s) {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// Background job that mirrors a freshly-transcribed local SA up to
// Dropbox and patches the RTDB record with the resulting share URL.
// Fire-and-forget via ctx.waitUntil from handleSaTranscribeLocal.
//
// v1.251: signature accepts optional dropboxFolderName + dropboxFileName
// from the mobile client. When supplied, file lands at
//   /sa-recordings/{folderName}/{fileName}
// (per-customer folders: "917760800366 - Priyanka Mishra"). When NOT
// supplied (older mobile clients still on v1.250 OTA), falls back to
// the legacy year-month layout so older builds keep working.
async function dropboxBackupSaSession(env, chatKey, sessionId, bytes, mimeType, fileName, dropboxFolderName, dropboxFileName) {
  const fbPath = `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`;
  try {
    let dropboxPath;
    if (dropboxFolderName && dropboxFileName) {
      // v1.251 path: per-customer folder + date-time filename.
      // Sanitize again worker-side — defense in depth in case the mobile
      // string contains anything Dropbox would reject.
      const safeFolder = sanitizeNameForFs(dropboxFolderName);
      const safeFile = sanitizeNameForFs(dropboxFileName);
      if (!safeFolder || !safeFile) {
        throw new Error("invalid dropboxFolderName/dropboxFileName after sanitize");
      }
      dropboxPath = `/sa-recordings/${safeFolder}/${safeFile}`;
    } else {
      // v1.250 fallback path.
      const yyyymm = new Date().toISOString().slice(0, 7);
      dropboxPath = `/sa-recordings/${yyyymm}/${fileName}`;
    }
    const result = await dropboxUpload(env, dropboxPath, bytes, mimeType);
    await fbPatch(env, fbPath, {
      dropboxPath: result.path,
      dropboxShareUrl: result.shareUrl,
      dropboxDirectUrl: result.directUrl,
      dropboxUploadedAt: Date.now(),
    });
  } catch (e) {
    await fbPatch(env, fbPath, {
      dropboxError: String(e?.message || e).slice(0, 500),
      dropboxErrorAt: Date.now(),
    });
  }
}

// v1.249: local-only SA transcription. Audio file STAYS on the recording
// tablet — the worker only does the transcription pass and writes the
// transcript to RTDB. No R2 write. Designed for the mobile flow where
// the trainer's tablet holds the source of truth and a persistent
// AsyncStorage queue retries this endpoint until success.
//
// Multipart form fields:
//   file              — audio blob (≤ 25 MB for Groq)
//   chatKey           — chat anchor
//   uploadedByUid     — trainer uid (audit)
//   uploadedByName    — trainer display name
//   sessionAt         — optional epoch-ms; defaults to now
//   clientSessionId   — REQUIRED on retries; phone-side UUID for idempotency.
//                       Worker uses it as the saSession key directly so
//                       a retry hits the same record. On the first attempt
//                       the phone generates this via uuidv4().
//   durationSec       — optional total recording duration (display only)
//
// Returns: { ok: true, sessionId } — sessionId == clientSessionId.
//
// Idempotency: if /commonComm/chats/{chatKey}/saSessions/{sessionId} already
// exists with status="ready", returns ok immediately without re-transcribing
// (rare race-with-completion case). If it exists with status="transcribing",
// also returns ok early (another worker invocation is already on it). Only
// status in {null, queued, failed} triggers a new transcription pass.
async function handleSaTranscribeLocal(request, env, ctx) {
  if (!env.GROQ_API_KEY) {
    return json({
      error: "GROQ_API_KEY not set",
      hint: "Run: wrangler secret put GROQ_API_KEY",
    }, 500);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "bad multipart: " + String(e?.message || e) }, 400);
  }
  const file = form.get("file");
  const chatKey = String(form.get("chatKey") || "");
  const uploadedByUid = String(form.get("uploadedByUid") || "");
  const uploadedByName = String(form.get("uploadedByName") || "");
  const clientSessionId = String(form.get("clientSessionId") || "");
  const sessionAtRaw = form.get("sessionAt");
  const sessionAt = sessionAtRaw ? Number(sessionAtRaw) : Date.now();
  const durationSec = form.get("durationSec")
    ? Number(form.get("durationSec"))
    : null;
  // v1.251: new optional fields. mobile clients on v1.251+ supply
  // customerName + dropboxFolderName + dropboxFileName so the worker
  // can write a customer-folder path to Dropbox AND store the
  // customer name on the saSession record. Older clients omit them
  // and we fall back to the legacy year-month Dropbox layout.
  const customerName = String(form.get("customerName") || "");
  const dropboxFolderName = String(form.get("dropboxFolderName") || "");
  const dropboxFileName = String(form.get("dropboxFileName") || "");

  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  if (!chatKey) return json({ error: "missing chatKey" }, 400);
  if (!uploadedByUid) return json({ error: "missing uploadedByUid" }, 400);
  if (!clientSessionId) return json({ error: "missing clientSessionId" }, 400);
  // chatKey path-walk guard, mirroring handleSaUpload.
  if (/[\/\\.]/.test(chatKey.replace(/_/g, ""))) {
    return json({ error: "bad chatKey" }, 400);
  }
  // clientSessionId path-walk guard — phone-generated UUID, should be safe
  // but defense-in-depth: forbid path-traversal characters.
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientSessionId)) {
    return json({ error: "bad clientSessionId" }, 400);
  }
  if (file.size > SA_MEDIA_MAX_BYTES) {
    return json({
      error: `file too large (>${SA_MEDIA_MAX_BYTES / 1024 / 1024} MB). The phone should record at ≤24 kbps so 2-hour SAs fit Groq's limit.`,
    }, 413);
  }

  const path = `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${clientSessionId}`;

  // Idempotency check — if the record already exists in a terminal or
  // in-flight state, don't re-transcribe.
  const existing = await fbGet(env, path);
  if (existing && existing.status === "ready") {
    return json({ ok: true, sessionId: clientSessionId, alreadyDone: true });
  }
  if (existing && existing.status === "transcribing") {
    // Another invocation is mid-transcription. Don't double-fire — but do
    // return success so the phone's queue marks it as in-flight.
    return json({ ok: true, sessionId: clientSessionId, inFlight: true });
  }

  // Buffer the bytes once — Groq's API call needs them, and we want the
  // mimeType for the transcribe helper.
  const mimeType = file.type || "audio/m4a";
  const fileName = String(file.name || `sa-${clientSessionId}.m4a`);
  let bytes;
  try {
    bytes = await file.arrayBuffer();
  } catch (e) {
    return json({ error: "buffer failed: " + String(e?.message || e) }, 500);
  }

  // Write the queued record. audioUrl is null since the audio stays on
  // the tablet — the saSession list on web/mobile renders the play button
  // conditionally on audioUrl, so it'll be hidden for these records.
  await fbPut(env, path, {
    audioUrl: null,
    audioFileName: fileName,
    sizeBytes: bytes.byteLength,
    mimeType,
    durationSec,
    sessionAt,
    uploadedAt: Date.now(),
    uploadedByUid,
    uploadedByName: uploadedByName || null,
    // v1.251: customer name denormalized onto the saSession record so
    // admin views / future cross-chat queries don't have to re-join.
    customerName: customerName || null,
    status: "queued",
    storageMode: "local-only",   // marks this as a no-R2-backup session
    groqModel: SA_GROQ_MODEL,
  });

  // Background transcription — reuses the existing helper that updates the
  // RTDB record's status field as it progresses (queued → transcribing →
  // ready/failed). Mobile's queue watches the status field via onValue and
  // resolves the queue item when it flips to ready or failed.
  ctx.waitUntil(transcribeSaSession(env, chatKey, clientSessionId, bytes, mimeType, fileName));

  // v1.250: ALSO fan out the bytes to Dropbox as an off-tablet backup.
  // v1.251: pass dropboxFolderName + dropboxFileName so the file lands in
  // the per-customer folder. Falls back to the legacy year-month layout
  // when those fields are missing (older mobile clients).
  ctx.waitUntil(dropboxBackupSaSession(
    env,
    chatKey,
    clientSessionId,
    bytes,
    mimeType,
    fileName,
    dropboxFolderName,
    dropboxFileName,
  ));

  return json({ ok: true, sessionId: clientSessionId });
}

// ============================================================
// v1.254: MEETINGS — internal team recording with transcription
// ============================================================
//
// Flow:
//   1. POST /meeting-create   — caller sends { name, attendees, createdByUid,
//                                createdByName }. Worker allocates a Firebase
//                                push key as meetingId, writes a placeholder
//                                RTDB record at /commonComm/meetings/{id} with
//                                status="recording". Returns { meetingId }.
//   2. (browser records, then stops)
//   3. POST /meeting-dropbox-url — caller sends { meetingId, fileName }. Worker
//                                  mints a single-use Dropbox temporary upload
//                                  link via Dropbox's API; returns { url, path }.
//                                  Browser PUTs the recorded blob to that URL
//                                  directly — no big upload through worker.
//   4. POST /meeting-set-dropbox — after the direct-to-Dropbox upload, browser
//                                  reports the Dropbox path back. Worker creates
//                                  a shareable link and patches the RTDB record
//                                  with dropboxPath + dropboxShareUrl.
//   5. POST /meeting-upload-chunk — browser splits the audio via Web Audio API
//                                   into ~23 MB WAV chunks and uploads each.
//                                   Worker stores in R2 at
//                                   meetings/{meetingId}/chunk-NNN.wav. The last
//                                   chunk's arrival kicks off background
//                                   transcription (transcribeMultipartMeeting)
//                                   which iterates Groq /translations calls and
//                                   stitches the chunk transcripts into one.
//                                   Status flips queued → transcribing 1/N →
//                                   ready / failed via RTDB patches the UI
//                                   listens to via onValue.
//
// Storage:
//   - Audio file (full meeting):   Dropbox /Apps/CommonComm/meetings/{filename}
//   - Transcript + metadata:       Firebase /commonComm/meetings/{meetingId}
//   - Chunks (transcription only): R2 commoncomm-dm-media meetings/{id}/...
//                                  (deleted after successful transcription)

async function handleMeetingCreate(request, env) {
  const body = await request.json().catch(() => ({}));
  let name = String(body?.name || "").trim().slice(0, 200);
  const attendees = Array.isArray(body?.attendees) ? body.attendees : [];
  const createdByUid = String(body?.createdByUid || "");
  const createdByName = String(body?.createdByName || "");
  if (!name) return json({ error: "missing name" }, 400);
  if (!createdByUid) return json({ error: "missing createdByUid" }, 400);

  // v1.256: auto-number duplicate names. If "Retention meeting" already
  // exists, the next one becomes "Retention meeting (1)", then "(2)", etc.
  // We compare on a normalized form (collapse whitespace, lowercase, strip
  // any existing "(N)" suffix on the base) so re-typing the same base name
  // — even with a stray space or odd capitalization — still picks up the
  // next number.
  name = await assignNextMeetingName(env, name);

  // Allocate a Firebase push key — chronologically sortable, globally unique.
  const startedAt = Date.now();
  const pushed = await fbPush(env, `${ROOT}/meetings`, {
    name,
    attendees,
    createdByUid,
    createdByName: createdByName || null,
    startedAt,
    durationSec: null,
    status: "recording",
    transcript: null,
    dropboxPath: null,
    dropboxShareUrl: null,
  });
  const meetingId = pushed?.name;
  if (!meetingId) return json({ error: "couldn't allocate meetingId" }, 500);
  return json({ ok: true, meetingId, name });
}

// Strip a trailing " (N)" suffix off a meeting name and normalize the
// remainder for case-insensitive comparison. Used by the auto-numbering
// scan to figure out the "base name" + the highest existing suffix.
function meetingNameBase(name) {
  const stripped = String(name || "").replace(/\s*\(\d+\)\s*$/, "").trim();
  return stripped.toLowerCase().replace(/\s+/g, " ");
}
function meetingNameSuffix(name) {
  const m = String(name || "").match(/\((\d+)\)\s*$/);
  return m ? Number(m[1]) : 0;
}
async function assignNextMeetingName(env, desiredName) {
  const base = meetingNameBase(desiredName);
  if (!base) return desiredName;
  const all = await fbGet(env, `${ROOT}/meetings`);
  if (!all || typeof all !== "object") return desiredName;
  let maxSuffix = -1; // -1 = no match; 0 = unsuffixed match; N = "(N)" match
  for (const m of Object.values(all)) {
    if (!m || !m.name) continue;
    if (meetingNameBase(m.name) !== base) continue;
    const s = meetingNameSuffix(m.name);
    if (s > maxSuffix) maxSuffix = s;
  }
  if (maxSuffix === -1) return desiredName.trim(); // no conflict — use as-is
  // Conflict — append the next number. The bare base (no suffix) counts
  // as "0", so the next collision becomes "(1)".
  const baseDisplay = String(desiredName).replace(/\s*\(\d+\)\s*$/, "").trim();
  return `${baseDisplay} (${maxSuffix + 1})`;
}

// v1.256: edit a meeting's name and/or attendee list. Body: { meetingId,
// name?, attendees? }. Doesn't touch transcript / Dropbox / audio.
async function handleMeetingUpdate(request, env) {
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }
  const fbPath = `${ROOT}/meetings/${meetingId}`;
  const existing = await fbGet(env, fbPath);
  if (!existing) return json({ error: "meeting not found" }, 404);

  const patch = {};
  if (typeof body.name === "string") {
    const newName = body.name.trim().slice(0, 200);
    if (!newName) return json({ error: "name cannot be empty" }, 400);
    // Only run the auto-number scan if the BASE name changed. Editing the
    // suffix or fixing typos within the same base shouldn't re-collide.
    if (meetingNameBase(newName) !== meetingNameBase(existing.name)) {
      patch.name = await assignNextMeetingName(env, newName);
    } else {
      patch.name = newName;
    }
  }
  if (Array.isArray(body.attendees)) {
    patch.attendees = body.attendees;
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: "nothing to update" }, 400);
  }
  patch.updatedAt = Date.now();
  await fbPatch(env, fbPath, patch);
  return json({ ok: true, name: patch.name || existing.name });
}

// v1.256: AI summary of a meeting's transcript. Calls Claude Haiku (the
// same model used by /summarize, /ai-query, etc.) with a meeting-flavored
// prompt. Stores the summary on the meeting record at .summary. Trainer
// hits "✨ Generate summary" on a ready meeting row and the result lands
// in RTDB within ~10-20s.
async function handleMeetingSummarize(request, env, ctx) {
  if (!env.CLAUDE_API_KEY) {
    return json({ error: "CLAUDE_API_KEY not set" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }
  const fbPath = `${ROOT}/meetings/${meetingId}`;
  const meeting = await fbGet(env, fbPath);
  if (!meeting) return json({ error: "meeting not found" }, 404);
  if (!meeting.transcript) {
    return json({ error: "meeting has no transcript yet" }, 400);
  }

  await fbPatch(env, fbPath, { summaryStatus: "generating" });

  // Long-running task — run via waitUntil so the caller doesn't have to
  // hold the request open for 20+ seconds.
  ctx.waitUntil((async () => {
    try {
      const prompt = `You are summarizing an internal team meeting transcript. Produce:
1. A two-sentence overview of what the meeting was about.
2. Up to 5 bullet points of key decisions or topics discussed.
3. Up to 5 bullet points of explicit action items (who needs to do what by when, if mentioned).
4. Open questions or things to follow up on, if any.

Be concise. If a section has nothing, write "None mentioned." Don't invent details that aren't in the transcript.

Attendees: ${(meeting.attendees || []).map((a) => a.name).join(", ") || "(unknown)"}
Meeting name: ${meeting.name}
Duration: ${meeting.durationSec ? Math.round(meeting.durationSec / 60) + " minutes" : "(unknown)"}

Transcript:
${meeting.transcript}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`Claude ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
      }
      const summary = String(j?.content?.[0]?.text || "").trim();
      if (!summary) throw new Error("Claude returned empty summary");
      await fbPatch(env, fbPath, {
        summary,
        summaryStatus: "ready",
        summaryGeneratedAt: Date.now(),
      });
    } catch (e) {
      await fbPatch(env, fbPath, {
        summaryStatus: "failed",
        summaryError: String(e?.message || e).slice(0, 500),
      });
    }
  })());

  return json({ ok: true, status: "generating" });
}

// Returns a one-time Dropbox upload URL for the browser to PUT the recorded
// audio blob to directly. Path is computed from the meeting's name + start
// time. Single-use, expires after ~4 hours.
async function handleMeetingDropboxUrl(request, env) {
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  const fileExt = String(body?.fileExt || "webm");
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }

  // Read the meeting record to compute the Dropbox path (name + startedAt).
  const meeting = await fbGet(env, `${ROOT}/meetings/${meetingId}`);
  if (!meeting) return json({ error: "meeting not found" }, 404);
  const startedAt = Number(meeting.startedAt) || Date.now();
  const cleanName = sanitizeNameForFs(meeting.name || "meeting");
  const d = new Date(startedAt);
  // ISO-ish local-time path: 2026-05-26 14-30 - Q1 Planning.webm
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  // Worker runs in UTC. Trainers are in IST. Shift forward 5h30m for display.
  const ist = new Date(startedAt + 5.5 * 60 * 60 * 1000);
  const istYyyy = ist.getUTCFullYear();
  const istMm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const istDd = String(ist.getUTCDate()).padStart(2, "0");
  const istHh = String(ist.getUTCHours()).padStart(2, "0");
  const istMin = String(ist.getUTCMinutes()).padStart(2, "0");
  const dropboxPath = `/meetings/${istYyyy}-${istMm}-${istDd} ${istHh}-${istMin} - ${cleanName}.${fileExt}`;

  const accessToken = await getDropboxAccessToken(env);
  const res = await fetch("https://api.dropboxapi.com/2/files/get_temporary_upload_link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commit_info: {
        path: dropboxPath,
        mode: "add",
        autorename: true,
        mute: true,
      },
      duration: 14400, // 4 hours — enough for a slow upload of a long file
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return json({ error: `dropbox link failed ${res.status}: ${text.slice(0, 300)}` }, 502);
  }
  const j = await res.json();
  return json({ ok: true, url: j.link, path: dropboxPath });
}

// After the browser-to-Dropbox direct upload completes, the browser pings
// this endpoint with the actual Dropbox path (Dropbox may have appended a
// " (1)" suffix via autorename). Worker creates a shareable link and
// patches the RTDB record.
async function handleMeetingSetDropbox(request, env) {
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  const dropboxPath = String(body?.dropboxPath || "");
  const sizeBytes = Number(body?.sizeBytes) || null;
  const durationSec = Number(body?.durationSec) || null;
  if (!meetingId || !dropboxPath) {
    return json({ error: "missing meetingId or dropboxPath" }, 400);
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }

  // Mint a shareable link for the freshly-uploaded file.
  const accessToken = await getDropboxAccessToken(env);
  let shareUrl = null;
  let directUrl = null;
  try {
    const r = await fetch(
      "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: dropboxPath,
          settings: {
            requested_visibility: { ".tag": "public" },
            audience: { ".tag": "public" },
            access: { ".tag": "viewer" },
          },
        }),
      },
    );
    if (r.ok) {
      const j = await r.json();
      shareUrl = j.url || null;
      directUrl = shareUrl
        ? shareUrl.replace(/\?dl=0$/, "?raw=1").replace(/\?dl=1$/, "?raw=1")
        : null;
    } else if (r.status === 409) {
      // Link already exists — fetch it.
      const lr = await fetch(
        "https://api.dropboxapi.com/2/sharing/list_shared_links",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: dropboxPath, direct_only: true }),
        },
      );
      if (lr.ok) {
        const lj = await lr.json();
        shareUrl = lj?.links?.[0]?.url || null;
        directUrl = shareUrl
          ? shareUrl.replace(/\?dl=0$/, "?raw=1").replace(/\?dl=1$/, "?raw=1")
          : null;
      }
    }
  } catch (e) {
    // share link is nice-to-have; not fatal
  }

  await fbPatch(env, `${ROOT}/meetings/${meetingId}`, {
    dropboxPath,
    dropboxShareUrl: shareUrl,
    dropboxDirectUrl: directUrl,
    dropboxUploadedAt: Date.now(),
    sizeBytes,
    durationSec,
  });
  return json({ ok: true });
}

// Chunked-upload endpoint for meeting transcription. Mirrors /sa-upload-chunk
// but writes to /commonComm/meetings/{meetingId} and meetings/{id}/chunk-NNN
// in R2. Form fields:
//   file              — the WAV chunk
//   meetingId         — required
//   chunkIndex        — 0-based
//   totalChunks       — total expected
async function handleMeetingUploadChunk(request, env, ctx) {
  if (!env.DM_MEDIA) return json({ error: "R2 bucket DM_MEDIA not bound" }, 500);
  if (!env.GROQ_API_KEY) return json({ error: "GROQ_API_KEY not set" }, 500);
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "bad multipart: " + String(e?.message || e) }, 400);
  }
  const file = form.get("file");
  const meetingId = String(form.get("meetingId") || "");
  const chunkIndex = parseInt(String(form.get("chunkIndex") || ""), 10);
  const totalChunks = parseInt(String(form.get("totalChunks") || ""), 10);

  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) {
    return json({ error: "bad chunkIndex" }, 400);
  }
  if (!Number.isFinite(totalChunks) || totalChunks < 1 || totalChunks > 200) {
    return json({ error: "bad totalChunks" }, 400);
  }
  if (chunkIndex >= totalChunks) {
    return json({ error: "chunkIndex >= totalChunks" }, 400);
  }
  if (file.size > SA_MEDIA_MAX_BYTES) {
    return json({ error: `chunk too large (>${SA_MEDIA_MAX_BYTES / 1024 / 1024} MB)` }, 413);
  }

  const padded = String(chunkIndex).padStart(3, "0");
  const key = `meetings/${meetingId}/chunk-${padded}.wav`;
  let bytes;
  try {
    bytes = await file.arrayBuffer();
    await env.DM_MEDIA.put(key, bytes, {
      httpMetadata: { contentType: "audio/wav" },
    });
  } catch (e) {
    return json({ error: "r2 put failed: " + String(e?.message || e) }, 500);
  }

  const fbPathMeeting = `${ROOT}/meetings/${meetingId}`;
  await fbPatch(env, fbPathMeeting, {
    status: `uploading ${chunkIndex + 1}/${totalChunks}`,
  });

  // When the last chunk arrives, kick off transcription (v1.260: single-
  // chunk-per-invocation, self-chains until done). v1.261: passes ctx
  // through so the chain uses ctx.waitUntil + env.SELF.fetch.
  if (chunkIndex === totalChunks - 1) {
    ctx.waitUntil(transcribeMeetingNext(env, meetingId, ctx));
  }

  return json({ ok: true, meetingId, chunkIndex });
}

// v1.260: SINGLE-CHUNK transcription processor + self-chaining.
//
// Previous design (v1.254-v1.259) ran ONE worker invocation that looped
// through all N chunks in a single ctx.waitUntil — 10s × N seconds of
// wall time. Cloudflare isolates get evicted unpredictably during long
// runs (especially with concurrent traffic), so transcriptions kept
// getting stuck mid-loop.
//
// New design: each invocation processes EXACTLY ONE chunk (~10s wall
// time, well within any isolate-eviction window), checkpoints the
// result to RTDB at meeting.chunkTranscripts[i], then fires a fetch to
// /meeting-transcribe-next to kick off the next chunk. If an
// invocation dies mid-chunk, the chunk just isn't checkpointed and the
// retry button (or a new trigger) picks it up.
//
// Once all chunks are checkpointed, the final invocation concatenates
// transcripts in order, sets status=ready, and cleans up R2.

// v1.261: transcribeMeetingNext + service-binding self-chain + detailed
// logging to RTDB so failures are visible in the UI, not just in
// wrangler tail. Every step writes a `chainLog` entry on the meeting
// record (capped at the last 30 entries) so the trainer can see exactly
// where the chain died last.
async function appendChainLog(env, fbPath, level, message, ctx_extra) {
  try {
    const meeting = await fbGet(env, fbPath);
    const existing = Array.isArray(meeting?.chainLog) ? meeting.chainLog : [];
    const entry = {
      at: Date.now(),
      level,                       // "info" | "warn" | "error"
      message: String(message).slice(0, 500),
      ...(ctx_extra || {}),
    };
    const trimmed = [...existing, entry].slice(-30);
    await fbPatch(env, fbPath, { chainLog: trimmed });
  } catch (e) {
    console.warn("[chain-log] failed to write", e);
  }
  // ALSO log to wrangler tail for live debugging.
  console.log(`[transcribe-chain] ${level.toUpperCase()} ${message}`, ctx_extra || "");
}

async function transcribeMeetingNext(env, meetingId, ctx) {
  const fbPath = `${ROOT}/meetings/${meetingId}`;
  await appendChainLog(env, fbPath, "info", "tick start", { meetingId });

  const meeting = await fbGet(env, fbPath);
  if (!meeting) {
    await appendChainLog(env, fbPath, "error", "meeting record disappeared");
    return;
  }

  // Count chunks in R2 — authoritative source for "how many total".
  if (!env.DM_MEDIA) {
    await appendChainLog(env, fbPath, "error", "R2 DM_MEDIA binding missing");
    return;
  }
  const listed = await env.DM_MEDIA.list({ prefix: `meetings/${meetingId}/` });
  const chunkKeys = (listed.objects || [])
    .filter((o) => /chunk-\d{3}\.wav$/.test(o.key))
    .map((o) => o.key)
    .sort();
  const totalChunks = chunkKeys.length;
  if (totalChunks === 0) {
    await fbPatch(env, fbPath, {
      status: "failed",
      transcriptError: "no chunks in R2 — upload may have failed",
      transcribeFinishedAt: Date.now(),
    });
    await appendChainLog(env, fbPath, "error", "no chunks in R2");
    return;
  }

  // Find lowest-index chunk that's not yet transcribed.
  const existingTranscripts = meeting.chunkTranscripts || {};
  let nextIndex = -1;
  for (let i = 0; i < totalChunks; i++) {
    if (existingTranscripts[String(i)] == null) {
      nextIndex = i;
      break;
    }
  }

  // All chunks done — finalize.
  if (nextIndex === -1) {
    await appendChainLog(env, fbPath, "info", "all chunks done — finalizing", { totalChunks });
    const parts = [];
    for (let i = 0; i < totalChunks; i++) {
      parts.push(String(existingTranscripts[String(i)] || ""));
    }
    const fullTranscript = parts.join("\n\n").trim();
    await fbPatch(env, fbPath, {
      status: "ready",
      transcript: fullTranscript,
      transcribeFinishedAt: Date.now(),
    });
    for (const key of chunkKeys) {
      try { await env.DM_MEDIA.delete(key); } catch {}
    }
    await appendChainLog(env, fbPath, "info", "transcription complete", { length: fullTranscript.length });
    return;
  }

  await appendChainLog(env, fbPath, "info", `transcribing chunk ${nextIndex} of ${totalChunks}`);

  // Transcribe just this one chunk.
  const padded = String(nextIndex).padStart(3, "0");
  const key = `meetings/${meetingId}/chunk-${padded}.wav`;
  const obj = await env.DM_MEDIA.get(key);
  if (!obj) {
    await fbPatch(env, fbPath, {
      status: "failed",
      transcriptError: `chunk ${nextIndex} missing from R2`,
      transcribeFinishedAt: Date.now(),
    });
    await appendChainLog(env, fbPath, "error", `R2 chunk missing: ${key}`);
    return;
  }
  const bytes = await obj.arrayBuffer();
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), `chunk-${padded}.wav`);
  form.append("model", SA_GROQ_MODEL);
  form.append("response_format", "verbose_json");
  form.append("temperature", "0");

  const groqStart = Date.now();
  let r, j;
  try {
    r = await fetch("https://api.groq.com/openai/v1/audio/translations", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
      body: form,
    });
    j = await safeJson(r);
    if (!r.ok) {
      const errMsg = `Groq HTTP ${r.status}: ${JSON.stringify(j).slice(0, 300)}`;
      await appendChainLog(env, fbPath, "error", errMsg, { chunk: nextIndex, groqStatus: r.status });
      throw new Error(errMsg);
    }
  } catch (e) {
    await fbPatch(env, fbPath, {
      status: "failed",
      transcriptError: String(e?.message || e).slice(0, 500),
      transcribeFinishedAt: Date.now(),
    });
    await appendChainLog(env, fbPath, "error", "Groq call failed", {
      chunk: nextIndex,
      error: String(e?.message || e).slice(0, 200),
      durationMs: Date.now() - groqStart,
    });
    return;
  }
  await appendChainLog(env, fbPath, "info", `Groq OK for chunk ${nextIndex}`, {
    durationMs: Date.now() - groqStart,
    textLength: String(j?.text || "").length,
  });

  // Checkpoint: save THIS chunk's transcript immediately.
  const completedCount = Object.keys(existingTranscripts).length + 1;
  await fbPatch(env, fbPath, {
    [`chunkTranscripts/${nextIndex}`]: String(j?.text || "").trim(),
    status: `transcribing ${completedCount}/${totalChunks}`,
    transcribeStartedAt: meeting.transcribeStartedAt || Date.now(),
  });

  // v1.261: SELF service-binding chain. Public-URL fetch hits Cloudflare's
  // worker-to-worker block (error 1042 — same lesson as the v1.239
  // PERISKOPE_GATEWAY migration). Service binding routes internally.
  if (env.SELF) {
    try {
      const chainReq = new Request("https://self/meeting-transcribe-next", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingId }),
      });
      // Wrap in ctx.waitUntil so Cloudflare keeps the parent invocation
      // alive long enough for the chain hand-off to actually complete.
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(env.SELF.fetch(chainReq));
      } else {
        // No ctx — fire-and-forget. Less reliable but better than nothing.
        env.SELF.fetch(chainReq).catch((e) => {
          console.warn("[chain] fire-and-forget self-fetch failed:", e);
        });
      }
      await appendChainLog(env, fbPath, "info", "fired chain → next chunk");
    } catch (e) {
      await appendChainLog(env, fbPath, "error", "chain self-fetch failed", {
        error: String(e?.message || e).slice(0, 200),
      });
    }
  } else {
    await appendChainLog(env, fbPath, "error", "env.SELF binding missing — chain broken");
  }
}

// v1.260: handler for the self-chain endpoint. Just unwraps the body
// and delegates to transcribeMeetingNext. Wrapped in ctx.waitUntil so
// the chunk processing continues after the HTTP response returns.
async function handleMeetingTranscribeNext(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }
  ctx.waitUntil(transcribeMeetingNext(env, meetingId, ctx));
  return json({ ok: true });
}

// v1.259: re-run transcription on a meeting whose original transcription
// got killed mid-flight (most commonly because the worker isolate was
// recycled by a deploy or an OOM kill). Looks up the chunks still
// sitting in R2 from the original upload and re-runs the same
// transcribeMeetingChunks routine. Idempotent — if all chunks were
// already transcribed and cleaned up, returns ok without doing work.
async function handleMeetingRetryTranscribe(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }
  const fbPath = `${ROOT}/meetings/${meetingId}`;
  const meeting = await fbGet(env, fbPath);
  if (!meeting) return json({ error: "meeting not found" }, 404);

  // Count chunks actually in R2. This is the authoritative source for
  // "how many chunks should we transcribe" — survives whatever status
  // string the meeting was stuck on.
  if (!env.DM_MEDIA) return json({ error: "R2 bucket not bound" }, 500);
  const listed = await env.DM_MEDIA.list({ prefix: `meetings/${meetingId}/` });
  const chunkKeys = (listed.objects || [])
    .filter((o) => /chunk-\d{3}\.wav$/.test(o.key))
    .map((o) => o.key)
    .sort();
  if (chunkKeys.length === 0) {
    return json({
      error: "no chunks left to transcribe (already cleaned up or never uploaded)",
    }, 400);
  }

  // Reset status so the UI shows progress again. transcribeMeetingNext
  // takes over and chains through any remaining un-transcribed chunks.
  // Already-transcribed chunks (stored at chunkTranscripts[N]) are
  // skipped — only un-done work runs.
  const existing = (meeting && meeting.chunkTranscripts) || {};
  const completed = Object.keys(existing).length;
  await fbPatch(env, fbPath, {
    status: `transcribing ${completed}/${chunkKeys.length}`,
    transcriptError: null,
    transcribeStartedAt: Date.now(),
  });
  ctx.waitUntil(transcribeMeetingNext(env, meetingId, ctx));
  return json({ ok: true, totalChunks: chunkKeys.length, alreadyDone: completed });
}

// v1.255: hard-delete a meeting. Removes:
//   - Firebase /commonComm/meetings/{meetingId} (metadata + transcript)
//   - Dropbox file at meeting.dropboxPath (if present)
//   - R2 chunks at meetings/{meetingId}/chunk-NNN.wav (best-effort cleanup
//     in case transcription failed mid-flight and chunks were never tidied)
//
// Body: { meetingId, deletedByUid, deletedByName }
// Returns: { ok: true } even if Dropbox / R2 cleanup fails — the
// Firebase delete is authoritative; orphan files in storage are tolerable.
// ============================================================
// v1.264: CALLING — Daily.co 1:1 audio calls between teammates.
// ============================================================
//
// Architecture:
//   1. Caller taps 📞 → POST /call-create-room with { initiatorUid,
//      recipientUid }. Worker hits Daily.co's REST API to create a
//      short-lived audio-only room. Returns { callId, roomUrl }.
//   2. Caller taps "Ring" → POST /call-ring with { callId }. Worker
//      writes the call record to RTDB at /commonComm/calls/{callId}
//      so recipient's app sees the incoming call via onValue. Phase 4
//      will also fire FCM (Android) + APNs VoIP push (iOS) for
//      lock-screen ringing.
//   3. Recipient accepts → mobile reports via POST /call-status with
//      { callId, status: "accepted" }. Mobile then joins the Daily
//      room. Caller's RTDB listener sees the status flip and stops
//      ringing.
//   4. Call ends → POST /call-status with status: "ended". Daily fires
//      a recording.ready webhook to /daily-webhook. Worker downloads
//      the recording, transcribes via the existing /translations
//      pipeline, uploads to Dropbox, stores under /commonComm/calls.
//
// Daily.co room properties we set:
//   audio_only: true           — no video tracks, smaller bandwidth.
//   enable_recording: "cloud"  — Daily records server-side, fires
//                                webhook when ready. NOTE: requires
//                                Daily's pay-as-you-go tier (~$0.0006/
//                                min for audio recording). Trainer
//                                will need to upgrade once we're
//                                actually testing recordings.
//   exp: now + 4 hours         — room auto-expires; no orphaned rooms.
//   eject_at_room_exp: true    — boots anyone still inside at exp.

async function handleCallCreateRoom(request, env) {
  if (!env.DAILY_API_KEY) {
    return json({ error: "DAILY_API_KEY not set" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const initiatorUid = String(body?.initiatorUid || "");
  const initiatorName = String(body?.initiatorName || "");
  const recipientUid = String(body?.recipientUid || "");
  const recipientName = String(body?.recipientName || "");
  if (!initiatorUid) return json({ error: "missing initiatorUid" }, 400);
  if (!recipientUid) return json({ error: "missing recipientUid" }, 400);

  // Daily room name: prefix + short timestamp + random. Daily requires
  // alphanumeric + hyphens, 1-128 chars.
  const callId = "call-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
  const expSec = Math.floor(Date.now() / 1000) + 4 * 3600;

  const dailyRes = await fetch("https://api.daily.co/v1/rooms", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DAILY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: callId,
      properties: {
        audio_only: true,
        exp: expSec,
        eject_at_room_exp: true,
        // Recording requires Daily's paid tier — uncomment when ready
        // and trainer has upgraded:
        // enable_recording: "cloud",
        // recordings_bucket: { ... } // optional: route to our R2 bucket
      },
    }),
  });
  const dailyJson = await safeJson(dailyRes);
  if (!dailyRes.ok) {
    return json({
      error: `Daily.co room creation failed (HTTP ${dailyRes.status})`,
      details: dailyJson,
    }, 502);
  }
  const roomUrl = dailyJson?.url || null;
  const roomName = dailyJson?.name || callId;
  if (!roomUrl) {
    return json({ error: "Daily.co returned no room URL", details: dailyJson }, 502);
  }

  // Write the call record to RTDB so the recipient's app (subscribed to
  // /commonComm/calls listener) can react. Status starts as "creating"
  // so the recipient doesn't see it until /call-ring is hit.
  await fbPut(env, `${ROOT}/calls/${callId}`, {
    initiatorUid,
    initiatorName: initiatorName || null,
    recipientUid,
    recipientName: recipientName || null,
    roomUrl,
    roomName,
    isVideo: false,
    status: "creating",
    createdAt: Date.now(),
  });

  return json({ ok: true, callId, roomUrl, roomName });
}

// Fires the actual ringing — recipient's app sees the RTDB write +
// (Phase 4) gets a VoIP/FCM push for lock-screen ringing.
async function handleCallRing(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const callId = String(body?.callId || "");
  if (!callId) return json({ error: "missing callId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) {
    return json({ error: "bad callId" }, 400);
  }
  const fbPath = `${ROOT}/calls/${callId}`;
  const call = await fbGet(env, fbPath);
  if (!call) return json({ error: "call not found" }, 404);
  if (call.status !== "creating") {
    return json({ error: `call already in status: ${call.status}` }, 409);
  }

  await fbPatch(env, fbPath, {
    status: "ringing",
    ringAt: Date.now(),
  });

  // Phase 4 TODO: send FCM push to recipient's Android device + VoIP push
  // to iOS device. For now (Phase 1), the recipient's app picks this up
  // via its onValue listener on /commonComm/calls and shows the in-app
  // incoming-call modal — works as long as the app is open. Lock-screen
  // ringing comes in Phase 4 once the iOS VoIP cert is in place.
  // ctx.waitUntil(sendCallPush(env, call.recipientUid, callId, call.initiatorName));

  return json({ ok: true });
}

// Recipient accepts / declines, or either side ends the call.
async function handleCallStatusUpdate(request, env) {
  const body = await request.json().catch(() => ({}));
  const callId = String(body?.callId || "");
  const newStatus = String(body?.status || "");
  if (!callId) return json({ error: "missing callId" }, 400);
  const validStatuses = new Set([
    "accepted",
    "declined",
    "missed",
    "in-progress",
    "ended",
  ]);
  if (!validStatuses.has(newStatus)) {
    return json({ error: "bad status" }, 400);
  }
  const fbPath = `${ROOT}/calls/${callId}`;
  const call = await fbGet(env, fbPath);
  if (!call) return json({ error: "call not found" }, 404);

  const patch = { status: newStatus };
  if (newStatus === "accepted") patch.acceptedAt = Date.now();
  if (newStatus === "ended") {
    patch.endedAt = Date.now();
    if (call.acceptedAt) {
      patch.durationSec = Math.floor((Date.now() - call.acceptedAt) / 1000);
    }
  }
  await fbPatch(env, fbPath, patch);
  return json({ ok: true, status: newStatus });
}

// Daily.co fires webhooks on various events. The one we care about is
// recording.ready-to-download — when the cloud recording is finalized.
// Worker downloads the recording, transcribes via the existing meeting
// pipeline, uploads to Dropbox, patches the call record.
//
// Phase 1 stubs this out; real implementation comes after recording is
// actually enabled on a paid Daily tier.
async function handleDailyWebhook(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const eventType = String(body?.type || "");
  const payload = body?.payload || {};
  console.log("[daily-webhook]", eventType, JSON.stringify(payload).slice(0, 300));

  if (eventType === "recording.ready-to-download") {
    // payload contains: room_name (= our callId), recording_id,
    // download_link (signed URL, valid ~10 min).
    const callId = String(payload.room_name || "");
    const downloadLink = String(payload.download_link || "");
    if (!callId || !downloadLink) {
      return json({ error: "missing room_name or download_link" }, 400);
    }
    // Phase 5 TODO: fetch the recording, run the existing meeting
    // chunked-transcribe pipeline against it, upload to Dropbox,
    // patch /commonComm/calls/{callId} with transcript + summary.
    // ctx.waitUntil(processCallRecording(env, callId, downloadLink));
  }
  return json({ ok: true });
}

async function handleMeetingDelete(request, env) {
  const body = await request.json().catch(() => ({}));
  const meetingId = String(body?.meetingId || "");
  if (!meetingId) return json({ error: "missing meetingId" }, 400);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(meetingId)) {
    return json({ error: "bad meetingId" }, 400);
  }

  const fbPath = `${ROOT}/meetings/${meetingId}`;
  const meeting = await fbGet(env, fbPath);
  if (!meeting) {
    // Already gone — return success so the UI cleans up regardless.
    return json({ ok: true, alreadyGone: true });
  }

  // (1) Best-effort Dropbox delete.
  if (meeting.dropboxPath && env.DROPBOX_REFRESH_TOKEN) {
    try {
      const accessToken = await getDropboxAccessToken(env);
      await fetch("https://api.dropboxapi.com/2/files/delete_v2", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path: meeting.dropboxPath }),
      });
      // Don't await response status — if Dropbox 404s (file gone) or 409s
      // (already deleted), that's fine. Anything else and we just leak
      // one file in Dropbox, trainer can prune manually.
    } catch (e) {
      console.warn("[meeting-delete] dropbox cleanup failed:", String(e?.message || e));
    }
  }

  // (2) Best-effort R2 cleanup. Chunks may still exist if transcription
  // failed or hasn't completed yet. R2 .list scoped to the meeting's prefix.
  if (env.DM_MEDIA) {
    try {
      const listed = await env.DM_MEDIA.list({ prefix: `meetings/${meetingId}/` });
      for (const obj of listed.objects || []) {
        try { await env.DM_MEDIA.delete(obj.key); } catch {}
      }
    } catch (e) {
      console.warn("[meeting-delete] r2 cleanup failed:", String(e?.message || e));
    }
  }

  // (3) Authoritative delete: remove the Firebase record. After this fires,
  // the dashboard's onValue listener removes the row from the UI.
  await fbPut(env, fbPath, null);

  return json({ ok: true });
}

// v1.233: chunked-upload endpoint for SA sessions larger than the
// per-request 25 MB Groq cap. Browser splits the audio (decoded via
// Web Audio API, re-wrapped as WAV at source sample rate) into
// ~23 MB chunks and posts them here in order. Form fields:
//   file              — the WAV chunk
//   chatKey, uploadedByUid, uploadedByName, sessionAt — same as /sa-upload
//   chunkIndex        — 0-based
//   totalChunks       — total expected
//   sessionId         — null/empty on chunk 0 (server generates), required afterwards
//   originalFileName  — display name; required on chunk 0
//   originalMimeType  — display mime; required on chunk 0
//   originalSizeBytes — source file size (for display)
//   totalDurationSec  — total audio duration (decoded, for display)
async function handleSaUploadChunk(request, env, ctx) {
  if (!env.DM_MEDIA) {
    return json({ error: "R2 bucket DM_MEDIA not bound" }, 500);
  }
  if (!env.GROQ_API_KEY) {
    return json({
      error: "GROQ_API_KEY not set",
      hint: "Run: wrangler secret put GROQ_API_KEY",
    }, 500);
  }
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ error: "bad multipart: " + String(e?.message || e) }, 400);
  }
  const file = form.get("file");
  const chatKey = String(form.get("chatKey") || "");
  const uploadedByUid = String(form.get("uploadedByUid") || "");
  const uploadedByName = String(form.get("uploadedByName") || "");
  const chunkIndex = parseInt(String(form.get("chunkIndex") || ""), 10);
  const totalChunks = parseInt(String(form.get("totalChunks") || ""), 10);
  let sessionId = String(form.get("sessionId") || "");

  if (!file || typeof file === "string") return json({ error: "missing file" }, 400);
  if (!chatKey) return json({ error: "missing chatKey" }, 400);
  if (!uploadedByUid) return json({ error: "missing uploadedByUid" }, 400);
  if (!Number.isFinite(chunkIndex) || chunkIndex < 0) return json({ error: "bad chunkIndex" }, 400);
  if (!Number.isFinite(totalChunks) || totalChunks < 1 || totalChunks > 200) {
    return json({ error: "bad totalChunks" }, 400);
  }
  if (chunkIndex >= totalChunks) return json({ error: "chunkIndex >= totalChunks" }, 400);
  if (/[\/\\.]/.test(chatKey.replace(/_/g, ""))) {
    return json({ error: "bad chatKey" }, 400);
  }
  // Per-chunk size cap — each chunk MUST fit Groq's 25 MB ceiling so
  // the eventual transcription succeeds. Leave a little slack (25 MB
  // sharp; the browser targets 23 MB on its side).
  if (file.size > SA_MEDIA_MAX_BYTES) {
    return json({ error: `chunk too large (>${SA_MEDIA_MAX_BYTES / 1024 / 1024} MB)` }, 413);
  }

  // First chunk path: allocate sessionId via Firebase push, create the
  // saSession record with the original-file metadata. Subsequent chunks
  // expect the client to pass that sessionId back.
  if (chunkIndex === 0) {
    if (sessionId) {
      return json({ error: "chunkIndex 0 must NOT pre-supply sessionId" }, 400);
    }
    const pushed = await fbPush(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions`, {
      placeholder: true,
    });
    sessionId = pushed?.name || null;
    if (!sessionId) return json({ error: "couldn't allocate sessionId" }, 500);
  } else {
    if (!sessionId) return json({ error: "missing sessionId on chunk > 0" }, 400);
    // Light path-walk guard on caller-supplied sessionId.
    if (/[\/\\.]/.test(sessionId)) return json({ error: "bad sessionId" }, 400);
  }

  // Zero-padded chunk index so R2 keys sort lexicographically in the
  // same order Groq needs to transcribe them.
  const padded = String(chunkIndex).padStart(3, "0");
  const key = `sa-sessions/${chatKey}/${sessionId}/chunk-${padded}.wav`;
  let bytes;
  try {
    bytes = await file.arrayBuffer();
    await env.DM_MEDIA.put(key, bytes, {
      httpMetadata: {
        contentType: "audio/wav",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    return json({ error: "r2 put failed: " + String(e?.message || e) }, 500);
  }

  const path = `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`;
  if (chunkIndex === 0) {
    // Initialize the saSession record with original-file metadata. The
    // audioUrl is intentionally null for multipart uploads — playback
    // would need to concatenate chunks, which is a future add. Trainers
    // can re-listen to their own source file in the meantime.
    const originalFileName = String(form.get("originalFileName") || "session");
    const originalMimeType = String(form.get("originalMimeType") || "audio/wav");
    const originalSizeBytes = Number(form.get("originalSizeBytes")) || file.size;
    const totalDurationSec = Number(form.get("totalDurationSec")) || null;
    const sessionAtRaw = form.get("sessionAt");
    const sessionAt = sessionAtRaw ? Number(sessionAtRaw) : Date.now();
    await fbPut(env, path, {
      audioUrl: null,
      audioFileName: originalFileName,
      sizeBytes: originalSizeBytes,
      mimeType: originalMimeType,
      durationSec: totalDurationSec,
      sessionAt,
      uploadedAt: Date.now(),
      uploadedByUid,
      uploadedByName: uploadedByName || null,
      status: `uploading 1/${totalChunks}`,
      groqModel: SA_GROQ_MODEL,
      multipart: { totalChunks, uploadedChunks: 1 },
    });
  } else {
    // Patch progress. Read-then-write because Firebase RTDB doesn't have
    // atomic increment — fine for our low concurrency.
    await fbPatch(env, path, {
      status: `uploading ${chunkIndex + 1}/${totalChunks}`,
      multipart: { totalChunks, uploadedChunks: chunkIndex + 1 },
    });
  }

  // Last chunk arrived → flip status and kick off the multipart
  // transcription job. ctx.waitUntil so the worker can return the
  // response to the browser immediately while the Groq calls run.
  if (chunkIndex === totalChunks - 1) {
    await fbPatch(env, path, {
      status: `queued`,
      multipart: { totalChunks, uploadedChunks: totalChunks },
    });
    ctx.waitUntil(transcribeMultipart(env, chatKey, sessionId, totalChunks));
  }

  return json({ ok: true, sessionId, chunkIndex, totalChunks });
}

// Background multipart transcription job. Iterates the chunks stored
// at sa-sessions/{chatKey}/{sessionId}/chunk-NNN.wav, transcribes each
// through Groq Whisper, stitches the result texts together (with a
// single space separator — Whisper output for adjacent audio segments
// reads naturally without explicit boundaries). Patches the saSession
// record as it progresses so the UI shows live "transcribing 5/12"
// state, then flips to "ready" with the full text.
//
// Failure handling: a single chunk failure marks the whole session
// "failed" with the error message. Retry re-runs the entire job from
// chunk 0 — Groq calls are stateless so re-runs are safe.
async function transcribeMultipart(env, chatKey, sessionId, totalChunks) {
  const path = `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`;
  const startedAt = Date.now();
  try {
    const pieces = [];
    for (let i = 0; i < totalChunks; i++) {
      await fbPatch(env, path, {
        status: `transcribing ${i + 1}/${totalChunks}`,
        transcribeStartedAt: i === 0 ? startedAt : undefined,
      });
      const padded = String(i).padStart(3, "0");
      const r2Key = `sa-sessions/${chatKey}/${sessionId}/chunk-${padded}.wav`;
      const obj = await env.DM_MEDIA.get(r2Key);
      if (!obj) throw new Error(`chunk ${i} missing from R2 (${r2Key})`);
      const bytes = await obj.arrayBuffer();
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "audio/wav" }), `chunk-${padded}.wav`);
      form.append("model", SA_GROQ_MODEL);
      form.append("response_format", "verbose_json");
      form.append("temperature", "0");
      const groqRes = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: form,
      });
      const groqJson = await safeJson(groqRes);
      if (!groqRes.ok) {
        throw new Error(`Groq ${groqRes.status} on chunk ${i + 1}/${totalChunks}: ${JSON.stringify(groqJson).slice(0, 300)}`);
      }
      const piece = String(groqJson?.text || "").trim();
      pieces.push(piece);
    }
    // Stitch — single space between pieces. Groq transcripts already
    // end with sentence-final punctuation in most cases; a space avoids
    // double-spacing while still letting adjacent words breathe.
    const full = pieces.filter(Boolean).join(" ").trim();
    if (!full) {
      await fbPatch(env, path, {
        status: "failed",
        transcriptError: "Groq returned no text across all chunks (no speech detected?)",
        transcribeFinishedAt: Date.now(),
      });
      return;
    }
    await fbPatch(env, path, {
      status: "ready",
      transcript: full,
      transcribeFinishedAt: Date.now(),
      durationTranscribeMs: Date.now() - startedAt,
    });
  } catch (e) {
    await fbPatch(env, path, {
      status: "failed",
      transcriptError: `multipart error: ${String(e?.message || e).slice(0, 500)}`,
      transcribeFinishedAt: Date.now(),
    });
  }
}

// Background transcription job. Reads the audio bytes (already in memory
// from the upload), POSTs to Groq's audio/transcriptions endpoint, and
// patches the Firebase saSession record with the result. Never throws —
// every failure path patches status="failed" with an error message so
// the UI can surface a Retry button.
async function transcribeSaSession(env, chatKey, sessionId, bytes, mimeType, fileName) {
  const path = `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`;
  const startedAt = Date.now();
  try {
    await fbPatch(env, path, { status: "transcribing", transcribeStartedAt: startedAt });

    // Groq's API expects multipart/form-data; we reconstruct from bytes.
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mimeType || "audio/mpeg" }), fileName || "session.mp3");
    form.append("model", SA_GROQ_MODEL);
    form.append("response_format", "verbose_json"); // gets us text + segments
    form.append("temperature", "0");                // deterministic
    // v1.251: switched from /transcriptions to /translations. /transcriptions
    // with language=en (v1.250 behavior) produced Latin-script Hinglish — fine
    // for Hindi/English code-switching, but the Kannada use case needed
    // actual semantic translation, not phonetic Latin transliteration. The
    // /translations endpoint translates any input language to English. Cost
    // is identical (same Whisper-large-v3 model, per-second-of-audio price).
    // Trade-off: the trainer's exact code-switched phrasing is lost —
    // "muje back pain hai" becomes "I have back pain". The original audio
    // is preserved on Dropbox + tablet for verification.

    const groqRes = await fetch("https://api.groq.com/openai/v1/audio/translations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: form,
    });
    const groqJson = await safeJson(groqRes);
    if (!groqRes.ok) {
      await fbPatch(env, path, {
        status: "failed",
        transcriptError: `Groq ${groqRes.status}: ${JSON.stringify(groqJson).slice(0, 500)}`,
        transcribeFinishedAt: Date.now(),
      });
      return;
    }
    const transcript = String(groqJson?.text || "").trim();
    const durationSec = typeof groqJson?.duration === "number" ? groqJson.duration : null;
    if (!transcript) {
      await fbPatch(env, path, {
        status: "failed",
        transcriptError: "Groq returned no text (no speech detected?)",
        transcribeFinishedAt: Date.now(),
      });
      return;
    }
    await fbPatch(env, path, {
      status: "ready",
      transcript,
      durationSec,
      transcribeFinishedAt: Date.now(),
      durationTranscribeMs: Date.now() - startedAt,
    });
  } catch (e) {
    await fbPatch(env, path, {
      status: "failed",
      transcriptError: `worker error: ${String(e?.message || e).slice(0, 500)}`,
      transcribeFinishedAt: Date.now(),
    });
  }
}

// Re-runs transcription for an existing session. Used by the "Retry"
// button in the UI when status="failed". Body: { chatKey, sessionId }.
async function handleSaRetranscribe(request, env, ctx) {
  if (!env.GROQ_API_KEY) {
    return json({ error: "GROQ_API_KEY not set" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const chatKey = String(body?.chatKey || "");
  const sessionId = String(body?.sessionId || "");
  if (!chatKey || !sessionId) return json({ error: "missing chatKey or sessionId" }, 400);
  const record = await fbGet(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`);
  if (!record) return json({ error: "session not found" }, 404);
  // v1.233: branch on single-file vs multipart. Multipart sessions have
  // their chunks at sa-sessions/{chatKey}/{sessionId}/chunk-NNN.wav and
  // are handled by transcribeMultipart; single-file by transcribeSaSession.
  if (record.multipart && record.multipart.totalChunks) {
    await fbPatch(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`, {
      status: "queued",
      transcriptError: null,
    });
    ctx.waitUntil(
      transcribeMultipart(env, chatKey, sessionId, record.multipart.totalChunks),
    );
    return json({ ok: true });
  }
  // Single-file path (original /sa-upload flow). The R2 key is
  // reconstructible from chatKey/sessionId/audioFileName since we
  // control all three.
  const safeName = String(record.audioFileName || "session.mp3");
  const r2Key = `sa-sessions/${chatKey}/${sessionId}/${safeName}`;
  const obj = await env.DM_MEDIA.get(r2Key);
  if (!obj) return json({ error: "audio file missing from R2" }, 404);
  const bytes = await obj.arrayBuffer();
  ctx.waitUntil(transcribeSaSession(env, chatKey, sessionId, bytes, record.mimeType || "audio/mpeg", safeName));
  await fbPatch(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`, {
    status: "queued",
    transcriptError: null,
  });
  return json({ ok: true });
}

// Deletes both the Firebase record AND the R2 object. Body:
// { chatKey, sessionId }. Idempotent — missing R2 object is a soft
// failure (the Firebase delete still goes through).
async function handleSaDelete(request, env) {
  const body = await request.json().catch(() => ({}));
  const chatKey = String(body?.chatKey || "");
  const sessionId = String(body?.sessionId || "");
  if (!chatKey || !sessionId) return json({ error: "missing chatKey or sessionId" }, 400);
  const record = await fbGet(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`);
  if (record) {
    // v1.233: clean up either the single-file or all chunk files,
    // depending on the session shape.
    if (record.multipart && record.multipart.totalChunks) {
      for (let i = 0; i < record.multipart.totalChunks; i++) {
        const padded = String(i).padStart(3, "0");
        const r2Key = `sa-sessions/${chatKey}/${sessionId}/chunk-${padded}.wav`;
        try {
          await env.DM_MEDIA.delete(r2Key);
        } catch { /* swallow */ }
      }
    } else {
      const safeName = String(record.audioFileName || "session.mp3");
      const r2Key = `sa-sessions/${chatKey}/${sessionId}/${safeName}`;
      try {
        await env.DM_MEDIA.delete(r2Key);
      } catch { /* swallow — Firebase delete is the source of truth */ }
    }
  }
  await fbPut(env, `${ROOT}/chats/${encodeKey(chatKey)}/saSessions/${sessionId}`, null);
  return json({ ok: true });
}

// GET /sa-media/<key> — streams the audio bytes from R2, supports Range
// so HTML5 <audio> can seek without downloading the whole file. Mirror
// of handleDmMediaGet with a different prefix strip.
async function handleSaMediaGet(request, env) {
  if (!env.DM_MEDIA) {
    return new Response("R2 bucket DM_MEDIA not bound", { status: 500 });
  }
  const url = new URL(request.url);
  let key;
  try {
    key = decodeURIComponent(url.pathname.replace(/^\/sa-media\//, ""));
  } catch {
    key = url.pathname.replace(/^\/sa-media\//, "");
  }
  if (!key) return new Response("missing key", { status: 400 });
  const rangeHeader = request.headers.get("Range");
  let r2Options;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const offset = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : undefined;
      r2Options = { range: end !== undefined ? { offset, length: end - offset + 1 } : { offset } };
    }
  }
  const object = r2Options
    ? await env.DM_MEDIA.get(key, r2Options)
    : await env.DM_MEDIA.get(key);
  if (!object) return new Response("not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Cache-Control", object.httpMetadata?.cacheControl || "public, max-age=31536000, immutable");
  headers.set("Accept-Ranges", "bytes");
  headers.set("ETag", object.httpEtag);
  if (object.range) {
    const start = object.range.offset || 0;
    const len = object.range.length ?? (object.size - start);
    const endByte = start + len - 1;
    headers.set("Content-Range", `bytes ${start}-${endByte}/${object.size}`);
    headers.set("Content-Length", String(len));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// ---------- /summarize (Claude-powered chat summary) ----------
// Reads the last N messages of a chat from Firebase, sends to Claude for a
// concise summary, returns it. Caller passes { chatId, maxMessages? }.
async function handleSummarize(request, env) {
  if (!env.CLAUDE_API_KEY) {
    return json({ error: "CLAUDE_API_KEY not configured on worker" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const chatId = body?.chatId;
  const maxMessages = Math.min(300, Math.max(10, Number(body?.maxMessages) || 150));
  if (!chatId) return json({ error: "missing chatId" }, 400);

  const chatKey = encodeKey(chatId);
  // v1.237: fetch SA transcripts + internal notes alongside messages. Both
  // get folded into the LLM context so the summary is grounded in EVERY
  // signal we have about this customer — not just the WhatsApp messages.
  // Previously the AI couldn't see SA recordings or trainer-written notes
  // even though the trainer might have spent 45 minutes capturing them.
  const [rawMessages, meta, rawSaSessions, rawNotes] = await Promise.all([
    fbGet(env, `${ROOT}/chats/${chatKey}/messages`),
    fbGet(env, `${ROOT}/chats/${chatKey}/meta`),
    fbGet(env, `${ROOT}/chats/${chatKey}/saSessions`),
    fbGet(env, `${ROOT}/chats/${chatKey}/notes`),
  ]);
  if (!rawMessages || typeof rawMessages !== "object") {
    return json({ summary: "No messages in this chat yet.", count: 0, total: 0 });
  }

  // Dedup by inner unique id (same logic as dashboard's render dedup) so the
  // LLM doesn't see duplicate outbound messages from the legacy /send+webhook race.
  const extractInnerId = (m) => {
    if (m.periskopeUniqueId) return m.periskopeUniqueId;
    if (m.periskopeMsgId) {
      const parts = String(m.periskopeMsgId).split("_");
      return parts[parts.length - 1] || null;
    }
    return null;
  };
  const byId = new Map();
  const noId = [];
  for (const m of Object.values(rawMessages)) {
    if (!m || !m.text) continue;
    const id = extractInnerId(m);
    if (!id) { noId.push(m); continue; }
    const existing = byId.get(id);
    if (!existing || (m.sentByName && !existing.sentByName)) byId.set(id, m);
  }
  const all = [...byId.values(), ...noId].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const recent = all.slice(-maxMessages);
  if (!recent.length) {
    return json({ summary: "No text messages to summarize.", count: 0, total: all.length });
  }

  const isGroup = String(chatId).endsWith("@g.us");
  const customerName = meta?.contactName || meta?.displayName || meta?.groupName || null;
  const customerLabel = customerName
    ? `${customerName}${meta?.phone ? ` (${meta.phone})` : ""}`
    : meta?.phone || "unknown";

  const lines = recent.map(m => {
    const ts = m.ts ? new Date(m.ts).toISOString().slice(0, 16).replace("T", " ") : "";
    const speaker = m.direction === "out"
      ? `Agent${m.sentByName ? ` (${m.sentByName})` : ""}`
      : (isGroup
          ? `Member${m.senderPhone ? ` ${m.senderPhone}` : ""}`
          : `Customer`);
    return `[${ts}] ${speaker}: ${m.text}`;
  });

  // v1.237: build SA transcripts + notes context blocks.
  const { block: saBlock, count: saCount } = buildSaTranscriptsBlock(rawSaSessions);
  const { block: notesBlock, count: notesCount } = buildNotesBlock(rawNotes);

  const systemPrompt = `You are summarizing a WhatsApp conversation for an Aroleap fitness team member who needs to pick up the chat with quick context. Be concise and structured.

Output 3-5 bullets covering:
- Who the customer is (any context you can infer)
- Key requests, complaints, or topics discussed (use SA transcripts + notes when they add color)
- Current state of the conversation (waiting on whom, last action)
- Suggested next step for the agent

Use simple markdown bullets. Stay under 180 words. Never invent facts not present in the supplied context. The SA transcript and notes sections (if present) are AUTHORITATIVE additional context about this customer beyond the WhatsApp thread.`;

  const userPrompt = `${isGroup ? "Group chat" : "Customer"}: ${customerLabel}\nMessages shown: last ${recent.length} of ${all.length}${saCount ? ` · ${saCount} SA transcript${saCount === 1 ? "" : "s"}` : ""}${notesCount ? ` · ${notesCount} internal note${notesCount === 1 ? "" : "s"}` : ""}\n\n${saBlock}${notesBlock}Conversation (oldest first):\n\n${lines.join("\n")}`;

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const claudeJson = await safeJson(claudeRes);
  if (!claudeRes.ok) {
    return json({ error: "claude_api_failed", details: claudeJson, status: claudeRes.status }, 502);
  }
  const summary = claudeJson?.content?.[0]?.text || "(empty response)";
  return json({
    summary,
    count: recent.length,
    total: all.length,
    // v1.237: surface what additional context fed the LLM beyond just
    // chat messages — UI shows a "X SA transcripts · Y notes used"
    // footer so trainers know the summary was grounded in everything we
    // know about the customer, not just the WhatsApp thread.
    saTranscriptsUsed: saCount,
    notesUsed: notesCount,
    model: claudeJson?.model || null,
    usage: claudeJson?.usage || null,
  });
}

// v1.237: shared helpers for assembling the SA transcript + notes context
// blocks injected into /summarize and /ai-query system prompts. Keep
// token budget under control by capping at the 3 most-recent SA sessions
// at 8000 chars each (≈ 30 min of speech) and excluding non-ready
// transcripts. Returns the formatted block + how many entries it covers.
function buildSaTranscriptsBlock(rawSaSessions) {
  if (!rawSaSessions || typeof rawSaSessions !== "object") {
    return { block: "", count: 0 };
  }
  const MAX_SESSIONS = 3;
  const MAX_CHARS_PER_TRANSCRIPT = 8000;
  const entries = Object.entries(rawSaSessions)
    .filter(([, s]) => s && !s.placeholder && s.status === "ready" && s.transcript)
    .map(([id, s]) => ({ id, ...s }))
    .sort(
      (a, b) =>
        (b.sessionAt || b.uploadedAt || 0) - (a.sessionAt || a.uploadedAt || 0),
    )
    .slice(0, MAX_SESSIONS);
  if (!entries.length) return { block: "", count: 0 };
  const blocks = entries.map((s) => {
    const dateStr = s.sessionAt || s.uploadedAt
      ? new Date(s.sessionAt || s.uploadedAt).toISOString().slice(0, 16).replace("T", " ")
      : "";
    const transcript = String(s.transcript || "").slice(0, MAX_CHARS_PER_TRANSCRIPT);
    const truncated = (s.transcript || "").length > MAX_CHARS_PER_TRANSCRIPT
      ? "\n  [transcript truncated for token budget]"
      : "";
    return `[${dateStr || "session"}] Strength Assessment:\n${transcript}${truncated}`;
  });
  return {
    block: `=== Recent SA recording transcripts (most recent first) ===\n${blocks.join("\n\n")}\n\n`,
    count: entries.length,
  };
}

function buildNotesBlock(rawNotes) {
  if (!rawNotes || typeof rawNotes !== "object") {
    return { block: "", count: 0 };
  }
  const entries = Object.entries(rawNotes)
    .filter(([, n]) => n && n.text)
    .map(([id, n]) => ({ id, ...n }))
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!entries.length) return { block: "", count: 0 };
  const lines = entries.map((n) => {
    const dateStr = n.createdAt
      ? new Date(n.createdAt).toISOString().slice(0, 16).replace("T", " ")
      : "";
    const author = n.authorName ? ` (${n.authorName})` : "";
    return `[${dateStr || "note"}]${author}: ${String(n.text || "").trim()}`;
  });
  return {
    block: `=== Internal trainer notes (oldest first) ===\n${lines.join("\n")}\n\n`,
    count: entries.length,
  };
}

// ---------- /ai-query (Claude answers a free-form question about one chat) ----------
// Caller passes { chatId, question, history? }. `history` is an optional array
// of prior { role: "user"|"assistant", content } turns so the trainer can ask
// follow-up questions in the same modal. Returns { answer, count, total, usage }.
async function handleAiQuery(request, env) {
  if (!env.CLAUDE_API_KEY) {
    return json({ error: "CLAUDE_API_KEY not configured on worker" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const chatId = body?.chatId;
  const question = String(body?.question || "").trim();
  const history = Array.isArray(body?.history) ? body.history : [];
  const maxMessages = Math.min(400, Math.max(10, Number(body?.maxMessages) || 250));
  if (!chatId) return json({ error: "missing chatId" }, 400);
  if (!question) return json({ error: "missing question" }, 400);

  const chatKey = encodeKey(chatId);
  // v1.237: same parallel fetch as /summarize — SA transcripts + notes
  // join the chat messages in the prompt context so the trainer can ask
  // questions like "what did Aparna mention in her last SA about her
  // knee?" and actually get an answer.
  const [rawMessages, meta, rawSaSessions, rawNotes] = await Promise.all([
    fbGet(env, `${ROOT}/chats/${chatKey}/messages`),
    fbGet(env, `${ROOT}/chats/${chatKey}/meta`),
    fbGet(env, `${ROOT}/chats/${chatKey}/saSessions`),
    fbGet(env, `${ROOT}/chats/${chatKey}/notes`),
  ]);
  if (!rawMessages || typeof rawMessages !== "object") {
    return json({ answer: "There are no messages in this chat yet.", count: 0, total: 0 });
  }

  // Same dedup logic as /summarize.
  const extractInnerId = (m) => {
    if (m.periskopeUniqueId) return m.periskopeUniqueId;
    if (m.periskopeMsgId) {
      const parts = String(m.periskopeMsgId).split("_");
      return parts[parts.length - 1] || null;
    }
    return null;
  };
  const byId = new Map();
  const noId = [];
  for (const m of Object.values(rawMessages)) {
    if (!m || !m.text) continue;
    const id = extractInnerId(m);
    if (!id) { noId.push(m); continue; }
    const existing = byId.get(id);
    if (!existing || (m.sentByName && !existing.sentByName)) byId.set(id, m);
  }
  const all = [...byId.values(), ...noId].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const recent = all.slice(-maxMessages);
  if (!recent.length) {
    return json({ answer: "There are no text messages in this chat to reason about.", count: 0, total: all.length });
  }

  const isGroup = String(chatId).endsWith("@g.us");
  const customerName = meta?.contactName || meta?.displayName || meta?.groupName || null;
  const customerLabel = customerName
    ? `${customerName}${meta?.phone ? ` (${meta.phone})` : ""}`
    : meta?.phone || "unknown";

  const lines = recent.map(m => {
    const ts = m.ts ? new Date(m.ts).toISOString().slice(0, 16).replace("T", " ") : "";
    const speaker = m.direction === "out"
      ? `Agent${m.sentByName ? ` (${m.sentByName})` : ""}`
      : (isGroup
          ? `Member${m.senderPhone ? ` ${m.senderPhone}` : ""}`
          : `Customer`);
    return `[${ts}] ${speaker}: ${m.text}`;
  });

  // v1.237: build SA + notes blocks the same way summarize does.
  const { block: saBlock, count: saCount } = buildSaTranscriptsBlock(rawSaSessions);
  const { block: notesBlock, count: notesCount } = buildNotesBlock(rawNotes);

  const systemPrompt = `You are an Aroleap fitness team assistant. The trainer is looking at one customer and will ask you questions. Answer using ONLY the provided context (WhatsApp conversation + SA recording transcripts + internal trainer notes).

Rules:
- Be concise and direct. Use short paragraphs or bullets — match the question's shape.
- Quote short snippets when useful (in quotes), and reference approximate dates ("on May 8") if the question is time-related.
- Prefer SA-transcript / note context when the trainer asks about session content, body assessments, or things said face-to-face — those sources contain detail the WhatsApp thread won't.
- If the answer is not present or unclear from the provided context, say so plainly ("Not mentioned anywhere I can see" / "Unclear from the records") instead of guessing.
- Never invent facts, names, prices, appointments, or trainer details not in the context.
- Don't restate the entire chat. Answer the question.

Context — ${isGroup ? "Group chat" : "Customer"}: ${customerLabel}
Messages available: last ${recent.length} of ${all.length}${saCount ? ` · ${saCount} SA transcript${saCount === 1 ? "" : "s"}` : ""}${notesCount ? ` · ${notesCount} internal note${notesCount === 1 ? "" : "s"}` : ""}

${saBlock}${notesBlock}Conversation (oldest first):

${lines.join("\n")}`;

  // Build the message list: prior turns from the modal, then the new question.
  const turns = [];
  for (const h of history) {
    if (!h || typeof h !== "object") continue;
    const role = h.role === "assistant" ? "assistant" : "user";
    const content = String(h.content || "").trim();
    if (!content) continue;
    turns.push({ role, content });
  }
  turns.push({ role: "user", content: question });

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: systemPrompt,
      messages: turns,
    }),
  });
  const claudeJson = await safeJson(claudeRes);
  if (!claudeRes.ok) {
    return json({ error: "claude_api_failed", details: claudeJson, status: claudeRes.status }, 502);
  }
  const answer = claudeJson?.content?.[0]?.text || "(empty response)";
  return json({
    answer,
    count: recent.length,
    total: all.length,
    // v1.237: same counts as /summarize so the UI footer is consistent.
    saTranscriptsUsed: saCount,
    notesUsed: notesCount,
    model: claudeJson?.model || null,
    usage: claudeJson?.usage || null,
  });
}

// ---------- /ai-inbox (v1.203) ----------
// Cross-chat AI assistant. Builds a context blob of the last N customer chats
// (recent activity, last few messages each, team note hints, ferra metadata)
// and asks Claude to either surface attention-needing chats, answer a free-
// form question, or generate a daily brief.
//
// Caller passes:
//   { mode: "attention" | "freeform" | "daily-brief",
//     question?: string,             // required for "freeform"
//     scope?: {
//       chatCount?: number,          // default 100, capped at 200
//       msgsPerChat?: number,        // default 10, capped at 20
//       withinDays?: number,         // default 14, capped at 90
//     }
//   }
//
// Returns:
//   { answer: string,                // markdown the UI renders
//     chats: [                       // structured chat references for click-through
//       { chatKey, name, phone, category, reason }
//     ],
//     usage, model, scope
//   }
async function handleAiInbox(request, env) {
  if (!env.CLAUDE_API_KEY) {
    return json({ error: "CLAUDE_API_KEY not configured on worker" }, 500);
  }
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode || "attention";
  const question = String(body?.question || "").trim();
  const scope = body?.scope || {};
  const chatCount = Math.min(200, Math.max(20, Number(scope.chatCount) || 100));
  const msgsPerChat = Math.min(20, Math.max(3, Number(scope.msgsPerChat) || 10));
  const withinDays = Math.min(90, Math.max(1, Number(scope.withinDays) || 14));

  if (mode === "freeform" && !question) {
    return json({ error: "freeform mode requires a question" }, 400);
  }

  // 1) Read /chats and pick the top N by lastMsgAt within the window.
  const chatsBlob = await fbGet(env, `${ROOT}/chats`);
  if (!chatsBlob || typeof chatsBlob !== "object") {
    return json({ answer: "No chats yet.", chats: [], scope: { chatCount: 0 } });
  }
  const cutoffMs = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  const candidates = [];
  for (const [chatKey, chat] of Object.entries(chatsBlob)) {
    const meta = chat?.meta || {};
    const lastMsgAt = meta.lastMsgAt || 0;
    if (lastMsgAt < cutoffMs) continue;
    // Skip team-internal DMs that snuck into /chats. Phone-prefixed chatIds
    // (digits-only before @c.us / @g.us) are customer threads.
    const phone = meta.phone || "";
    candidates.push({
      chatKey,
      chatId: meta.chatId || chatKey,
      phone,
      name:
        meta.contactName ||
        meta.displayName ||
        meta.groupName ||
        phone ||
        chatKey,
      lastMsgAt,
      lastMsgPreview: meta.lastMsgPreview || "",
      lastMsgDirection: meta.lastMsgDirection || "in",
      lastMsgSentByName: meta.lastMsgSentByName || "",
      chatType: meta.chatType || "user",
      isGroup: String(meta.chatId || "").endsWith("@g.us"),
      private: !!meta.private,
      messages: chat?.messages || null,
    });
  }
  candidates.sort((a, b) => b.lastMsgAt - a.lastMsgAt);
  const picked = candidates.slice(0, chatCount);

  // 2) For each picked chat, take the last msgsPerChat text messages and
  // build a compact transcript line. Skip groups + private chats to keep
  // the context tight on real customer 1:1s.
  const chatBlocks = [];
  for (const c of picked) {
    if (c.isGroup) continue;
    if (c.private) continue;
    if (!c.messages || typeof c.messages !== "object") continue;
    const all = Object.values(c.messages)
      .filter((m) => m && m.text && !m.deleted)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    if (!all.length) continue;
    const recent = all.slice(-msgsPerChat);
    const lines = recent.map((m) => {
      const when = m.ts
        ? humanRelativeTime(m.ts)
        : "?";
      const speaker = m.direction === "out"
        ? `Agent${m.sentByName ? `(${m.sentByName})` : ""}`
        : "Customer";
      // Trim each line to keep the context budget reasonable.
      const text = String(m.text).slice(0, 240).replace(/\s+/g, " ");
      return `  [${when}] ${speaker}: ${text}`;
    });
    chatBlocks.push({
      chatKey: c.chatKey,
      name: c.name,
      phone: c.phone,
      lastDirection: c.lastMsgDirection,
      lastMsgAt: c.lastMsgAt,
      lastMsgSentByName: c.lastMsgSentByName,
      block:
        `### ${c.name} (${c.phone || "no-phone"}) [chatKey: ${c.chatKey}]\n` +
        `Last activity: ${humanRelativeTime(c.lastMsgAt)}, last msg direction: ${c.lastMsgDirection}` +
        (c.lastMsgDirection === "out" && c.lastMsgSentByName
          ? ` (sent by ${c.lastMsgSentByName})`
          : "") +
        `\n` +
        lines.join("\n"),
    });
  }

  if (!chatBlocks.length) {
    return json({
      answer: "No active customer chats in the selected window.",
      chats: [],
      scope: { chatCount: 0, msgsPerChat, withinDays },
    });
  }

  const context = chatBlocks.map((c) => c.block).join("\n\n");

  // 3) System prompt + user message vary by mode.
  let systemPrompt;
  let userMessage;
  if (mode === "attention") {
    systemPrompt = AI_INBOX_ATTENTION_PROMPT;
    userMessage =
      `Inbox snapshot (${chatBlocks.length} active customer chats, last ` +
      `${withinDays} days, last ${msgsPerChat} messages each):\n\n${context}\n\n` +
      `Identify the chats that need the team's attention right now. Return JSON only.`;
  } else if (mode === "daily-brief") {
    systemPrompt = AI_INBOX_DAILY_BRIEF_PROMPT;
    userMessage =
      `Inbox snapshot (${chatBlocks.length} active customer chats, last ` +
      `${withinDays} days, last ${msgsPerChat} messages each):\n\n${context}\n\n` +
      `Generate the daily brief now. Return JSON only.`;
  } else {
    // freeform
    systemPrompt = AI_INBOX_FREEFORM_PROMPT;
    userMessage =
      `Inbox snapshot (${chatBlocks.length} active customer chats, last ` +
      `${withinDays} days, last ${msgsPerChat} messages each):\n\n${context}\n\n` +
      `Question from the trainer: ${question}\n\nAnswer in JSON.`;
  }

  // 4) Call Claude (Haiku — cheap, fast enough for this).
  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  const claudeJson = await safeJson(claudeRes);
  if (!claudeRes.ok) {
    return json({ error: "claude_api_failed", details: claudeJson, status: claudeRes.status }, 502);
  }
  const raw = claudeJson?.content?.[0]?.text || "";
  let parsed;
  try {
    const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    parsed = { summary: raw, chats: [] };
  }

  // 5) Sanitize the chats array — only keep entries with a chatKey that
  // matches one we actually sent in context. Stops Claude from inventing
  // chats that don't exist.
  const validKeys = new Set(chatBlocks.map((c) => c.chatKey));
  const safeChats = Array.isArray(parsed?.chats)
    ? parsed.chats
        .filter((c) => c && c.chatKey && validKeys.has(c.chatKey))
        .map((c) => {
          const src = chatBlocks.find((x) => x.chatKey === c.chatKey);
          return {
            chatKey: c.chatKey,
            name: src?.name || c.name || "(unknown)",
            phone: src?.phone || c.phone || "",
            category: String(c.category || "attention").toLowerCase(),
            reason: String(c.reason || "").slice(0, 200),
          };
        })
    : [];

  return json({
    answer: String(parsed?.summary || raw).slice(0, 4000),
    chats: safeChats,
    scope: {
      chatCount: chatBlocks.length,
      msgsPerChat,
      withinDays,
    },
    model: claudeJson?.model || null,
    usage: claudeJson?.usage || null,
  });
}

// Human-friendly relative time for chat-context lines. "3h ago", "2d ago",
// "just now". Keeps the context terse and lets Claude reason about freshness
// without us serializing ISO timestamps everywhere.
function humanRelativeTime(ts) {
  if (!ts) return "?";
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days < 14) return `${days}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

const AI_INBOX_ATTENTION_PROMPT = `You are an Aroleap fitness team assistant scanning the team's WhatsApp customer inbox. The trainer wants a short, ranked list of chats that need their attention RIGHT NOW.

Categorize each flagged chat into ONE of:
- "urgent": explicit urgency (cancellations, refunds, anger, injuries, today-deadline), churn risk signals, safety
- "waiting": customer's last message has gone unanswered for >12 hours
- "attention": complaints, repeated questions, customer waiting on a commitment the team made, unclear status

Be CONSERVATIVE. Don't flag chats that look fine. Aim for 5–15 entries — quality over coverage. Skip chats where the team has clearly already handled the issue.

Respond with JSON ONLY (no prose outside the JSON, no code fences). Schema:
{
  "summary": "<1–2 sentence overview of the inbox state, e.g. 'Mostly quiet — 3 urgent items, 6 chats waiting on replies.'>",
  "chats": [
    {
      "chatKey": "<exact chatKey string from the context>",
      "category": "urgent" | "waiting" | "attention",
      "reason": "<1 short sentence explaining WHY this needs attention>"
    }
  ]
}

Order chats by category (urgent first, then waiting, then attention) and within each by recency / severity. Use chatKey EXACTLY as given. Never invent chats.`;

const AI_INBOX_FREEFORM_PROMPT = `You are an Aroleap fitness team assistant. The trainer will ask a question about the customer inbox. Answer using ONLY the inbox snapshot below — don't invent facts, customer names, prices, or events that aren't in the data.

Respond with JSON ONLY (no prose outside the JSON, no code fences). Schema:
{
  "summary": "<answer to the question, in plain English. Use short paragraphs or bullets. Match the question's shape — a count gets a number, a list gets a list, a yes/no gets a yes/no with the supporting context.>",
  "chats": [
    {
      "chatKey": "<exact chatKey string from the context — only chats relevant to the answer>",
      "category": "attention",
      "reason": "<1 short sentence on why this chat is mentioned>"
    }
  ]
}

The "chats" array is for clickable references the trainer can use to jump into specific chats — only include chats you actually referenced in the summary. Use chatKey EXACTLY as given. Never invent chats.`;

const AI_INBOX_DAILY_BRIEF_PROMPT = `You are an Aroleap fitness team assistant generating a start-of-shift daily brief from the customer inbox.

Produce a brief, scannable summary that helps the team prioritize the day. Cover:
- Recent volume (rough sense of inbound, customers active in the last 24h)
- Top themes / recurring topics (what are customers talking about, asking about, complaining about)
- Notable chats — anything urgent, churn-risk, or stuck waiting for a reply
- Recommended focus — concrete 2–4 things the team should tackle first

Be concise. The trainer reads this in 30 seconds. Use bullets and short lines. Don't pad with platitudes.

Respond with JSON ONLY (no prose outside the JSON, no code fences). Schema:
{
  "summary": "<markdown text. Use ## section headers like '## Volume', '## Themes', '## Notable', '## Focus today'.>",
  "chats": [
    {
      "chatKey": "<chatKey of any chat referenced in the summary>",
      "category": "urgent" | "waiting" | "attention",
      "reason": "<short reason>"
    }
  ]
}

The chats array is for clickable links from the brief — only include chats you actually called out by name. Use chatKey EXACTLY as given. Never invent chats.`;

// ---------- /suggest-reply (Claude drafts a short reply for the trainer) ----------
async function handleSuggestReply(request, env) {
  if (!env.CLAUDE_API_KEY) return json({ error: "CLAUDE_API_KEY not configured on worker" }, 500);
  const body = await request.json().catch(() => ({}));
  const chatId = body?.chatId;
  if (!chatId) return json({ error: "missing chatId" }, 400);

  const chatKey = encodeKey(chatId);
  const [rawMessages, meta] = await Promise.all([
    fbGet(env, `${ROOT}/chats/${chatKey}/messages`),
    fbGet(env, `${ROOT}/chats/${chatKey}/meta`),
  ]);
  if (!rawMessages || typeof rawMessages !== "object") {
    return json({ error: "no_messages" }, 400);
  }

  // Same render-time dedup as /summarize
  const extractInnerId = (m) => {
    if (m.periskopeUniqueId) return m.periskopeUniqueId;
    if (m.periskopeMsgId) {
      const parts = String(m.periskopeMsgId).split("_");
      return parts[parts.length - 1] || null;
    }
    return null;
  };
  const byId = new Map();
  const noId = [];
  for (const m of Object.values(rawMessages)) {
    if (!m) continue;
    const id = extractInnerId(m);
    if (!id) { noId.push(m); continue; }
    const existing = byId.get(id);
    if (!existing || (m.sentByName && !existing.sentByName)) byId.set(id, m);
  }
  const all = [...byId.values(), ...noId]
    .filter(m => m.text || m.media)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const recent = all.slice(-30);
  if (!recent.length) return json({ error: "no_recent" }, 400);

  const isGroup = String(chatId).endsWith("@g.us");
  const customerName = meta?.contactName || meta?.groupName || meta?.phone || "Customer";

  const lines = recent.map(m => {
    const text = m.text || (m.media ? `[${m.media.mimeType || "media"}]` : "");
    const speaker = m.direction === "out"
      ? `Agent${m.sentByName ? ` (${m.sentByName})` : ""}`
      : (isGroup ? `Member${m.senderPhone ? ` ${m.senderPhone}` : ""}` : "Customer");
    return `${speaker}: ${text}`;
  });

  const systemPrompt = `You are an Aroleap fitness team member drafting a WhatsApp reply for a customer. The trainer will edit and send your draft.

Style:
- Warm, professional, conversational — not stiff or overly formal.
- 1-3 sentences max. Short = better.
- Match the tone of recent exchanges (formal if customer is formal, casual if casual).
- Use the customer's name if it's known and the context warrants it.

Rules:
- Never invent facts (appointments, prices, names of trainers, etc.) not present in the conversation.
- If the customer just asked a question you can't answer from context, suggest a brief clarifying question or a "let me check and get back to you".
- Don't use emojis unless the conversation already has them.
- Output ONLY the reply text. No explanation, no quotes, no preamble like "Here's a draft:".`;

  const userPrompt = `Customer: ${customerName}\nChat type: ${isGroup ? "group" : "1-on-1"}\n\nRecent conversation (oldest first):\n\n${lines.join("\n")}\n\nDraft the next reply the agent should send.`;

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  const claudeJson = await safeJson(claudeRes);
  if (!claudeRes.ok) {
    return json({ error: "claude_api_failed", details: claudeJson, status: claudeRes.status }, 502);
  }
  const reply = (claudeJson?.content?.[0]?.text || "").trim();
  return json({ reply, count: recent.length, usage: claudeJson?.usage || null });
}

// ---------- /transcribe (Workers AI Whisper for voice notes) ----------
// Frontend records audio via MediaRecorder, base64-encodes it, POSTs here.
// We run whisper-large-v3-turbo, then a quick Claude pass to strip fillers
// ("um", "uh"), fix punctuation, and tighten the phrasing without inventing
// facts — so what the trainer sees is a clean note draft, not raw dictation.
// Audio is NEVER sent to the customer; the frontend drops the result into
// the notes-panel draft form.
//
// Body `cleanup: false` opts out of the Claude pass — used by the mobile
// app's internal-DM composer mic, where the cleanup prompt (written for
// trainer-notes-about-customer) is the wrong service.
async function handleTranscribe(request, env) {
  if (!env.AI) {
    return json({ error: "workers_ai_not_bound", hint: "Add [ai] binding=\"AI\" in wrangler.toml and redeploy" }, 500);
  }
  const body = await request.json().catch(() => null);
  const audioB64 = body?.audio;
  if (!audioB64 || typeof audioB64 !== "string") {
    return json({ error: "missing audio (base64 string)" }, 400);
  }
  const cleanup = body?.cleanup !== false;

  // (1) Whisper transcription
  let rawText = "";
  try {
    const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: audioB64,
    });
    rawText = String(result?.text || "").trim();
  } catch (e) {
    return json({ error: "transcribe_failed", details: String(e?.message || e) }, 502);
  }
  if (!rawText) {
    return json({ text: "", raw: "", cleaned: false, reason: "no_speech" });
  }

  if (!cleanup) {
    return json({ text: rawText, raw: rawText, cleaned: false, reason: "cleanup_disabled" });
  }

  // (2) Claude cleanup pass — delegated to the shared helper so /cleanup
  // (called by the browser-direct Groq STT path) uses the exact same prompt.
  const cleanResult = await runCleanupPass(rawText, env);
  return json(cleanResult);
}

// System prompt for voice-transcript cleanup. Shared between the legacy
// /transcribe route (which does Whisper + cleanup in one call) and /cleanup
// (called by the browser/mobile after they do STT directly via Groq with
// the user's own API key — see v1.133).
//
// Intentionally context-agnostic: the same transcript could be a private
// note, an outgoing message, or a quick reminder. The prompt only cleans
// up the text — it doesn't assume anything about where the text is going.
const VOICE_NOTE_CLEANUP_PROMPT = `You are cleaning up a voice-dictated transcript. The raw text may contain filler words ("um", "uh", "like", "you know"), false starts, repeated words, and missing punctuation.

Your job:
- Remove fillers, false starts, and obvious stammers.
- Fix punctuation, capitalization, and run-on sentences.
- Preserve the speaker's voice and meaning — don't rewrite for "formality" and don't change wording beyond what's needed to make the text read cleanly.
- Keep ALL specifics exactly as spoken: names, phone numbers, dates, times, prices, technical terms, addresses, identifiers.
- Do NOT add facts or details that aren't in the transcript.
- Do NOT add greetings, signoffs, headers ("Note:", "Summary:"), or bullets unless the transcript itself is clearly multi-topic.
- If the transcript is already clean, return it as-is with only punctuation fixes.

Output ONLY the cleaned text — no preamble, no explanation, no quotes around it.`;

// Runs the Claude cleanup pass over a raw transcript and returns a result
// object in the same shape both /transcribe and /cleanup return. Never
// throws — if Claude is unreachable or misconfigured, we fall back to the
// raw text so the feature never hard-fails for the caller.
async function runCleanupPass(rawText, env) {
  if (!rawText) {
    return { text: "", raw: "", cleaned: false, reason: "no_speech" };
  }
  if (!env.CLAUDE_API_KEY) {
    return { text: rawText, raw: rawText, cleaned: false, reason: "claude_not_configured" };
  }
  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system: VOICE_NOTE_CLEANUP_PROMPT,
        messages: [{ role: "user", content: rawText }],
      }),
    });
    const claudeJson = await safeJson(claudeRes);
    if (!claudeRes.ok) {
      return { text: rawText, raw: rawText, cleaned: false, reason: "claude_api_failed", details: claudeJson };
    }
    const cleaned = String(claudeJson?.content?.[0]?.text || "").trim();
    if (!cleaned) {
      return { text: rawText, raw: rawText, cleaned: false, reason: "claude_empty" };
    }
    return { text: cleaned, raw: rawText, cleaned: true, usage: claudeJson?.usage || null };
  } catch (e) {
    return { text: rawText, raw: rawText, cleaned: false, reason: "claude_network_error", details: String(e?.message || e) };
  }
}

// ---------- /cleanup (Claude pass over already-transcribed text) ----------
// Called by the browser/mobile after they hit Groq directly with the user's
// own API key. Body: { text: "raw transcript from whisper" }. Response is
// the same shape /transcribe returns: { text, raw, cleaned, ... }.
async function handleCleanup(request, env) {
  const body = await request.json().catch(() => null);
  const rawText = String(body?.text || "").trim();
  if (!rawText) return json({ error: "missing text" }, 400);
  return json(await runCleanupPass(rawText, env));
}

async function handleFetchMessages(request, env) {
  const url = new URL(request.url);
  const chatId = url.searchParams.get("chatId");
  if (!chatId) return json({ error: "missing chatId" }, 400);

  const r = await fetch(`${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}/messages?offset=0&limit=200`, {
    headers: periskopeHeaders(env),
  });
  const j = await safeJson(r);
  return json(j, r.ok ? 200 : 502);
}

// ---------- /search-messages?q=...&limit=50 ----------
// Substring search across every message in commonComm/chats. Single Firebase
// fetch of the chats branch; in-memory scan; return top N hits newest-first
// with enough metadata for the dashboard to render result rows + jump to the
// chat. Skips outbound-only matches when scope=in is set (rarely used).
async function handleSearchMessages(request, env) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  if (q.length < 2) return json({ error: "query must be at least 2 chars" }, 400);

  const chats = await fbGet(env, `${ROOT}/chats`);
  if (!chats || typeof chats !== "object") return json({ results: [] });

  const hits = [];
  for (const [chatKey, chat] of Object.entries(chats)) {
    if (!chat || typeof chat !== "object") continue;
    const meta = chat.meta || {};
    const messages = chat.messages || {};
    if (typeof messages !== "object") continue;
    for (const [msgKey, m] of Object.entries(messages)) {
      if (!m || typeof m !== "object") continue;
      const hay = String(m.text || "").toLowerCase() +
                  (m.media?.caption ? " " + String(m.media.caption).toLowerCase() : "") +
                  (m.media?.fileName ? " " + String(m.media.fileName).toLowerCase() : "");
      if (!hay.includes(q)) continue;
      hits.push({
        chatKey,
        chatId: meta.chatId || null,
        chatName: meta.groupName || meta.contactName || meta.displayName || null,
        phone: meta.phone || null,
        chatType: meta.chatType || "user",
        msgKey,
        text: (m.text || m.media?.caption || m.media?.fileName || "").slice(0, 300),
        ts: m.ts || 0,
        direction: m.direction || "in",
        sentByName: m.sentByName || null,
        messageType: m.messageType || null,
      });
    }
  }

  hits.sort((a, b) => b.ts - a.ts);
  return json({ results: hits.slice(0, limit), total: hits.length });
}

// ---------- /dm-notify ----------
// Fan out an Expo push to a teammate when an internal DM is delivered.
// The client writes the message to /dms/{pairKey}/messages itself; this
// endpoint exists only to ping the recipient's mobile device. No Periskope
// involvement — DMs never leave Firebase.
//
// v1.210: subscribe this worker's /webhook to Periskope's
// `message.ack.updated` event so delivered/read receipts start flowing in
// for outbound messages. Idempotent on our end — if Periskope rejects with
// "already subscribed" or similar we surface that verbatim so the operator
// can see it. Auth uses the same PERISKOPE_API_KEY + PERISKOPE_PHONE that
// /send already uses, so no extra secrets needed.
async function handleSubscribeAckWebhook(request, env) {
  const url = new URL(request.url);
  // The hookUrl we want Periskope to call. Defaults to THIS worker's own
  // /webhook (computed from request.url). Override via ?hookUrl=... if
  // you ever need to point ack events somewhere else for testing.
  const defaultHook = `${url.protocol}//${url.host}/webhook`;
  const hookUrl = url.searchParams.get("hookUrl") || defaultHook;
  if (!env.PERISKOPE_API_KEY || !env.PERISKOPE_PHONE) {
    return json({ error: "missing PERISKOPE_API_KEY/PERISKOPE_PHONE secrets" }, 500);
  }
  const periskopeRes = await fetch("https://api.periskope.app/v1/webhooks", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.PERISKOPE_API_KEY}`,
      "x-phone": env.PERISKOPE_PHONE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: "CommonComm ack receipts",
      hookUrl,
      integrationName: ["message.ack.updated"],
    }),
  });
  const periskopeJson = await safeJson(periskopeRes);
  return json(
    {
      ok: periskopeRes.ok,
      status: periskopeRes.status,
      hookUrl,
      event: "message.ack.updated",
      periskope: periskopeJson,
    },
    periskopeRes.ok ? 200 : periskopeRes.status,
  );
}

// Body: { pairKey, fromUid, fromName, toUid, text }
// We re-verify on the server that fromUid is actually a participant in
// {pairKey}, so a malicious caller can't trigger pushes to arbitrary users.
async function handleDmNotify(request, env) {
  const body = await request.json().catch(() => ({}));
  const { pairKey, fromUid, fromName, toUid, text } = body || {};
  if (!pairKey || !fromUid || !toUid) {
    return json({ error: "missing pairKey/fromUid/toUid" }, 400);
  }

  const participants = await fbGet(env, `${ROOT}/dms/${encodeKey(pairKey)}/meta/participants`);
  if (!participants || participants[fromUid] !== true || participants[toUid] !== true) {
    return json({ error: "not a participant" }, 403);
  }

  const tokensMap = await fbGet(env, `${ROOT}/pushTokens/${toUid}`);
  if (!tokensMap || typeof tokensMap !== "object") {
    return json({ ok: true, delivered: 0 });
  }

  const messages = [];
  for (const entry of Object.values(tokensMap)) {
    if (!entry || !entry.token) continue;
    if (!/^ExponentPushToken\[.+\]$/.test(entry.token)) continue;
    messages.push({
      to: entry.token,
      title: fromName || "Team",
      body: String(text || "").slice(0, 200) || "[new message]",
      data: { dmPairKey: pairKey, kind: "dm" },
      sound: "default",
      priority: "high",
      channelId: "default",
    });
  }
  if (!messages.length) return json({ ok: true, delivered: 0 });

  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (env.EXPO_ACCESS_TOKEN) headers["Authorization"] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });
    } catch { /* swallow — push is best-effort */ }
  }
  return json({ ok: true, delivered: messages.length });
}

// ---------- /notify-ticket-assignee (v1.205) ----------
// Fire a push to the assignee when a ticket is created or reassigned.
// Called by clients right after they write to /tickets — Firebase RTDB
// writes don't trigger anything server-side on their own, so this is the
// hook to make ticket assignments push-noticeable on the phone.
//
// Body:
//   { ticketId, assigneeUid, assigneeName, fromUid, fromName,
//     chatId, customerName, title, type: "created"|"reassigned" }
//
// Behavior:
//   - Skips if assigneeUid === fromUid (don't wake yourself up for a
//     ticket you just assigned to yourself).
//   - Fetches assignee's Expo push tokens from /pushTokens/{uid}.
//   - Sends one Expo push per token. Data payload includes ticketId +
//     chatId so the mobile app can deep-link the user to the relevant
//     thread on tap (future work; v1 just opens the app).
async function handleNotifyTicketAssignee(request, env) {
  const body = await request.json().catch(() => ({}));
  const {
    ticketId,
    assigneeUid,
    assigneeName,
    fromUid,
    fromName,
    chatId,
    customerName,
    title,
    type,
  } = body || {};
  if (!ticketId || !assigneeUid) {
    return json({ error: "missing ticketId/assigneeUid" }, 400);
  }
  // Don't push yourself.
  if (fromUid && fromUid === assigneeUid) {
    return json({ ok: true, delivered: 0, skipped: "self-assign" });
  }

  const tokensMap = await fbGet(env, `${ROOT}/pushTokens/${assigneeUid}`);
  if (!tokensMap || typeof tokensMap !== "object") {
    return json({ ok: true, delivered: 0 });
  }

  const verb = type === "reassigned" ? "reassigned to you" : "assigned to you";
  const customer = customerName || "a customer";
  const titleTxt = `🎫 Ticket ${verb}`;
  const ticketPart = title ? `${title} · ` : "";
  const bodyTxt =
    `${fromName ? `${fromName} → ` : ""}${ticketPart}${customer}`.slice(0, 200);

  const messages = [];
  for (const entry of Object.values(tokensMap)) {
    if (!entry || !entry.token) continue;
    if (!/^ExponentPushToken\[.+\]$/.test(entry.token)) continue;
    messages.push({
      to: entry.token,
      title: titleTxt,
      body: bodyTxt,
      data: {
        kind: "ticket",
        ticketId,
        chatId: chatId || null,
        type: type || "created",
      },
      sound: "default",
      priority: "high",
      channelId: "default",
    });
  }
  if (!messages.length) return json({ ok: true, delivered: 0 });

  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (env.EXPO_ACCESS_TOKEN) headers["Authorization"] = `Bearer ${env.EXPO_ACCESS_TOKEN}`;
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });
    } catch { /* swallow — push is best-effort */ }
  }
  return json({ ok: true, delivered: messages.length });
}

// ---------- /dm-search ----------
// Participant-scoped full-text search across the caller's own DMs. Mirrors
// /search-messages but only scans /dms/{pairKey} where the given uid is a
// participant — never leaks messages from DMs the caller can't see.
//
// Query: ?q=...&uid=...&limit=...
async function handleDmSearch(request, env) {
  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase();
  const uid = String(url.searchParams.get("uid") || "").trim();
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
  if (q.length < 2) return json({ error: "query must be at least 2 chars" }, 400);
  if (!uid) return json({ error: "missing uid" }, 400);

  const dms = await fbGet(env, `${ROOT}/dms`);
  if (!dms || typeof dms !== "object") return json({ results: [], total: 0 });

  const hits = [];
  for (const [pairKey, pair] of Object.entries(dms)) {
    if (!pair || typeof pair !== "object") continue;
    const participants = pair.meta?.participants;
    if (!participants || participants[uid] !== true) continue;
    const otherUid = Object.keys(participants).find((u) => u !== uid) || null;
    const messages = pair.messages || {};
    if (typeof messages !== "object") continue;
    for (const [msgKey, m] of Object.entries(messages)) {
      if (!m || typeof m !== "object" || !m.text) continue;
      if (!String(m.text).toLowerCase().includes(q)) continue;
      hits.push({
        pairKey,
        otherUid,
        msgKey,
        text: String(m.text).slice(0, 300),
        ts: m.ts || 0,
        fromUid: m.fromUid || null,
        fromName: m.fromName || null,
      });
    }
  }
  hits.sort((a, b) => b.ts - a.ts);
  return json({ results: hits.slice(0, limit), total: hits.length });
}

// ---------- Periskope helpers ----------
function periskopeHeaders(env) {
  return {
    "Authorization": `Bearer ${env.PERISKOPE_API_KEY}`,
    "x-phone": env.PERISKOPE_PHONE,
    "Content-Type": "application/json",
  };
}

function phoneToChatId(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return `${digits}@c.us`;
}
function chatIdToPhone(chatId) {
  return String(chatId || "").split("@")[0];
}
function digitsOnly(v) {
  return String(v || "").replace(/\D/g, "");
}

// ──────────────────────────────────────────────────────────────────
// v1.241: shared phone normalizer (copied from
// https://github.com/rohit-aroleap/ferra-periskope-gateway/blob/main/lib/normalize-phone.js
// — version 1.0.0). DO NOT EDIT HERE. Update upstream, bump VERSION
// there, then copy this block again.
//
// Phase A of the canonical customer model. The worker doesn't currently
// have a comparison-style normalizePhone call (legacy helpers above
// handle the WhatsApp-specific transforms). This block is inlined for
// (a) parity with web + mobile so all three copies of CommonComm agree,
// and (b) future Phase B+ work where worker-side joins against
// ferraSubscriptions/v1/byPhone need canonical keys.
//
// Canonical format: E.164 without the leading + sign — "919876543210".
// ──────────────────────────────────────────────────────────────────
const PHONE_NORMALIZER_VERSION = "1.0.0";

function normalizePhone(raw) {
  if (raw == null) return "";
  let s = String(raw).trim();
  if (/@g\.us$/i.test(s) || /@broadcast$/i.test(s)) return "";
  s = s.replace(/@[a-z0-9.]+$/i, "");
  s = s.replace(/\D/g, "");
  while (s.startsWith("0") && s.length > 10) s = s.slice(1);
  if (s.length === 10) s = "91" + s;
  if (s.length < 11 || s.length > 15) return "";
  return s;
}

function normalizeChatKey(raw) {
  if (raw == null) return "";
  const s = String(raw).trim();
  if (/@g\.us$/i.test(s) || /@broadcast$/i.test(s)) {
    return s.replace(/@.*$/, "").replace(/\D/g, "");
  }
  return normalizePhone(s);
}

function isValidPhone(raw) {
  const p = normalizePhone(raw);
  return p.length === 12 && p.startsWith("91");
}

function phoneVariants(raw) {
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

function formatPhoneDisplay(raw) {
  const c = normalizePhone(raw);
  if (!c) return "";
  if (c.length === 12 && c.startsWith("91")) {
    return `+91 ${c.slice(2, 7)}-${c.slice(7)}`;
  }
  return "+" + c;
}

function samePhone(a, b) {
  const na = normalizePhone(a);
  if (!na) return false;
  return na === normalizePhone(b);
}
// Periskope's webhook envelope isn't perfectly stable, so look in a few
// plausible spots for the org's own phone number. Returns digits-only, or
// "" if nothing recognizable was found (in which case the guard treats the
// message as unverified rather than rejecting — see handleWebhook).
function extractAccountPhone(payload, msg) {
  const candidates = [
    payload?.phone,
    payload?.account_phone,
    payload?.business_phone,
    payload?.to,
    payload?.data?.phone,
    payload?.data?.account_phone,
    payload?.data?.business_phone,
    payload?.data?.to,
    msg?.account_phone,
    msg?.business_phone,
    msg?.to,
    msg?.to_phone,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const d = digitsOnly(String(c).split("@")[0]);
    if (d) return d;
  }
  return "";
}
// Periskope sends timestamps as ISO strings ("2026-05-14T08:17:49+00:00").
// Older code paths might send unix seconds or millis. Handle all three.
function parseTs(v) {
  if (!v) return Date.now();
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const s = String(v);
  if (/^\d+$/.test(s)) return s.length <= 10 ? Number(s) * 1000 : Number(s);
  const n = Date.parse(s);
  return isNaN(n) ? Date.now() : n;
}

// ---------- Firebase RTDB REST helpers ----------
function fbUrl(env, path) {
  return `${env.FIREBASE_DB_URL}/${path}.json?auth=${env.FIREBASE_DB_SECRET}`;
}
async function fbPush(env, path, value) {
  const r = await fetch(fbUrl(env, path), { method: "POST", body: JSON.stringify(value) });
  return safeJson(r);
}
async function fbPut(env, path, value) {
  const r = await fetch(fbUrl(env, path), { method: "PUT", body: JSON.stringify(value) });
  return safeJson(r);
}
async function fbPatch(env, path, value) {
  const r = await fetch(fbUrl(env, path), { method: "PATCH", body: JSON.stringify(value) });
  return safeJson(r);
}
async function fbGet(env, path) {
  const r = await fetch(fbUrl(env, path));
  return safeJson(r);
}
// Multi-path PATCH at the root of the database. Body keys are deep paths relative to root.
// One HTTP request → many writes atomically. Critical for fitting under the Worker subrequest limit.
async function fbPatchRoot(env, updates) {
  const url = `${env.FIREBASE_DB_URL}/.json?auth=${env.FIREBASE_DB_SECRET}`;
  const r = await fetch(url, { method: "PATCH", body: JSON.stringify(updates) });
  return safeJson(r);
}

// Dual-write chat meta to /chats/{k}/meta/* AND /chatsIndex/{k}/*. The phone
// app subscribes to /chatsIndex (meta-only, no messages subtree) so it can
// render the chat list without downloading every message of every chat —
// /chats keeps the full tree the web app's listener still uses. Both paths
// stay in sync via this single atomic multi-path PATCH.
async function patchChatMeta(env, chatKey, fields) {
  const updates = {};
  for (const [k, v] of Object.entries(fields)) {
    updates[`${ROOT}/chats/${chatKey}/meta/${k}`] = v;
    updates[`${ROOT}/chatsIndex/${chatKey}/${k}`] = v;
  }
  return fbPatchRoot(env, updates);
}

// Inject chatsIndex mirror keys for any chats/{k}/meta/* paths in an updates
// map. Used by callers that already build a multi-path update object (e.g.
// /import-chat, /fetch-chat-info) — they call this once before fbPatchRoot.
function mirrorChatsMetaToIndex(updates) {
  for (const [path, value] of Object.entries(updates)) {
    // Match exactly the meta-field paths we want mirrored. Sub-keys like
    // /meta/lastMsgAt are mirrored to /chatsIndex/{k}/lastMsgAt; we
    // deliberately don't mirror /messages/* or /tickets/*.
    const m = path.match(/^commonComm\/chats\/([^/]+)\/meta\/(.+)$/);
    if (!m) continue;
    updates[`${ROOT}/chatsIndex/${m[1]}/${m[2]}`] = value;
  }
}

// Firebase keys can't contain . # $ [ ] /  -> replace
function encodeKey(k) {
  return String(k).replace(/[.#$\[\]\/]/g, "_");
}

// ---------- HTTP helpers ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
async function safeJson(r) {
  try { return await r.json(); } catch { return null; }
}
function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN || "*");
  h.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  return new Response(res.body, { status: res.status, headers: h });
}
