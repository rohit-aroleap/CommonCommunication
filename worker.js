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
  "rohitpatel.mailid297@gmail.com",
]);

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
          endpoints: ["/health", "/send (POST)", "/webhook (POST)", "/messages?chatId=... (GET)", "/transcribe (POST)", "/cleanup (POST)", "/register-push-token (POST)"],
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
      if (url.pathname === "/dm-search" && request.method === "GET") {
        return cors(env, await handleDmSearch(request, env));
      }
      if (url.pathname === "/triage-backfill" && request.method === "POST") {
        return cors(env, await handleTriageBackfill(request, env));
      }
      if (url.pathname === "/backfill-resolution-notes" && request.method === "POST") {
        return cors(env, await handleBackfillResolutionNotes(request, env));
      }
      return cors(env, json({ error: "not_found" }, 404));
    } catch (err) {
      return cors(env, json({ error: String(err && err.message || err) }, 500));
    }
  },
};

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

  // Media support: dashboard passes media as { type, filename, mimetype, filedata }
  // (Periskope's exact shape). Pass through verbatim if present.
  const periskopeBody = { chat_id: resolvedChatId };
  if (message) periskopeBody.message = message;
  if (body.media && (body.media.filedata || body.media.url)) {
    periskopeBody.media = body.media;
  }
  const periskopeRes = await fetch(`${PERISKOPE_BASE}/message/send`, {
    method: "POST",
    headers: periskopeHeaders(env),
    body: JSON.stringify(periskopeBody),
  });

  const periskopeJson = await safeJson(periskopeRes);
  const ok = periskopeRes.ok;
  const uniqueId = periskopeJson?.unique_id || null;

  // Predict the message_id format that Periskope's webhook will use for
  // the from_me=true echo of this send: "true_{chat_id}_{unique_id}". By
  // pre-writing the byPeriskopeId dedup entry, we prevent the webhook from
  // duplicating the message when it arrives a moment later.
  const expectedWebhookMsgId = (ok && uniqueId) ? `true_${resolvedChatId}_${uniqueId}` : null;

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
  await fbPatch(env, `${ROOT}/chats/${encodeKey(resolvedChatId)}/meta`, {
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
      if (echoMedia && existing.chatId && existing.msgKey) {
        await fbPatch(env, `${ROOT}/chats/${encodeKey(existing.chatId)}/messages/${existing.msgKey}`, { media: echoMedia });
      }
      return json({ ok: true, dedup: true });
    }
  }

  const media = extractMedia(msg);
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
  await fbPatch(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`, metaUpdate);

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
            await fbPatch(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`, { groupName: chat.chat_name });
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
  await fbPatch(env, `${ROOT}/chats/${chatKey}/meta`, {
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
    await fbPatch(env, `${ROOT}/chats/${chatKey}/meta`, {
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

  // (4) Atomic multi-path PATCH at root - one subrequest for all writes
  if (Object.keys(updates).length > 0) {
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
  if (chat?.members && typeof chat.members === "object") {
    for (const m of Object.values(chat.members)) {
      if (!m) continue;
      const phone = String(m.contact_id || "").split("@")[0].replace(/\D/g, "");
      const name = m.contact_name;
      if (!phone || !name) continue;
      updates[`${ROOT}/contacts/${phone}/name`] = name;
      updates[`${ROOT}/contacts/${phone}/source`] = "group_members";
      updates[`${ROOT}/contacts/${phone}/seenAt`] = Date.now();
      membersWritten++;
    }
  }
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
    host.endsWith(".googleusercontent.com")
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
  const [rawMessages, meta] = await Promise.all([
    fbGet(env, `${ROOT}/chats/${chatKey}/messages`),
    fbGet(env, `${ROOT}/chats/${chatKey}/meta`),
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

  const systemPrompt = `You are summarizing a WhatsApp conversation for an Aroleap fitness team member who needs to pick up the chat with quick context. Be concise and structured.

Output 3-5 bullets covering:
- Who the customer is (any context you can infer)
- Key requests, complaints, or topics discussed
- Current state of the conversation (waiting on whom, last action)
- Suggested next step for the agent

Use simple markdown bullets. Stay under 180 words. Never invent facts not present in the messages.`;

  const userPrompt = `${isGroup ? "Group chat" : "Customer"}: ${customerLabel}\nMessages shown: last ${recent.length} of ${all.length}\n\nConversation (oldest first):\n\n${lines.join("\n")}`;

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
    model: claudeJson?.model || null,
    usage: claudeJson?.usage || null,
  });
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
  const [rawMessages, meta] = await Promise.all([
    fbGet(env, `${ROOT}/chats/${chatKey}/messages`),
    fbGet(env, `${ROOT}/chats/${chatKey}/meta`),
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

  const systemPrompt = `You are an Aroleap fitness team assistant. The trainer is looking at one WhatsApp chat and will ask you questions about it. Answer using ONLY the conversation provided as context.

Rules:
- Be concise and direct. Use short paragraphs or bullets — match the question's shape.
- Quote short message snippets when useful (in quotes), and reference approximate dates ("on May 8") if the question is time-related.
- If the answer is not present or unclear from the messages, say so plainly ("Not mentioned in this chat" / "Unclear from the messages") instead of guessing.
- Never invent facts, names, prices, appointments, or trainer details not in the conversation.
- Don't restate the entire chat. Answer the question.

Context — ${isGroup ? "Group chat" : "Customer"}: ${customerLabel}
Messages available: last ${recent.length} of ${all.length}

Conversation (oldest first):

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
    model: claudeJson?.model || null,
    usage: claudeJson?.usage || null,
  });
}

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
