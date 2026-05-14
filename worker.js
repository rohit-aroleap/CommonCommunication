// Cloudflare Worker: Periskope <-> Firebase bridge for CommonCommunication
// Secrets required (wrangler secret put / dashboard):
//   PERISKOPE_API_KEY   - Bearer JWT from Periskope console
//   PERISKOPE_PHONE     - org WhatsApp phone, digits only, e.g. 919187651332
//   FIREBASE_DB_SECRET  - Firebase RTDB legacy database secret
//
// Vars (wrangler.toml):
//   FIREBASE_DB_URL     - https://motherofdashboard-default-rtdb.asia-southeast1.firebasedatabase.app
//   ALLOWED_ORIGIN      - dashboard origin (e.g. https://rohit-aroleap.github.io)

const PERISKOPE_BASE = "https://api.periskope.app/v1";
const ROOT = "commonComm";

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
          endpoints: ["/health", "/send (POST)", "/webhook (POST)", "/messages?chatId=... (GET)"],
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

  if (!message || (!chatId && !phone)) {
    return json({ error: "missing chatId/phone or message" }, 400);
  }
  if (!sentByUid || !sentByName) {
    return json({ error: "missing sentByUid/sentByName" }, 400);
  }

  const resolvedChatId = chatId || phoneToChatId(phone);
  const resolvedPhone = phone || chatIdToPhone(resolvedChatId);

  const periskopeRes = await fetch(`${PERISKOPE_BASE}/message/send`, {
    method: "POST",
    headers: periskopeHeaders(env),
    body: JSON.stringify({ chat_id: resolvedChatId, message }),
  });

  const periskopeJson = await safeJson(periskopeRes);
  const ok = periskopeRes.ok;

  // Mirror the send into Firebase so all dashboards see it.
  // If we already have a localMsgId from the dashboard, update that record;
  // otherwise push a new one.
  const ts = Date.now();
  const msgRecord = {
    direction: "out",
    text: message,
    ts,
    sentByUid,
    sentByName,
    status: ok ? "sent" : "failed",
    periskopeUniqueId: periskopeJson?.unique_id || null,
    periskopeTrackBy: periskopeJson?.track_by || null,
    periskopeResp: periskopeJson || null,
  };

  if (localMsgId) {
    await fbPatch(env, `${ROOT}/chats/${encodeKey(resolvedChatId)}/messages/${localMsgId}`, msgRecord);
  } else {
    await fbPush(env, `${ROOT}/chats/${encodeKey(resolvedChatId)}/messages`, msgRecord);
  }
  await fbPatch(env, `${ROOT}/chats/${encodeKey(resolvedChatId)}/meta`, {
    phone: resolvedPhone,
    chatId: resolvedChatId,
    lastMsgAt: ts,
    lastMsgPreview: message.slice(0, 120),
    lastMsgDirection: "out",
    lastMsgSentByName: sentByName,
  });

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
    if (existing) return json({ ok: true, dedup: true });
  }

  const record = {
    direction: isFromMe ? "out" : "in",
    text,
    ts,
    periskopeMsgId,
    messageType,
    senderPhone,
    raw: msg,
  };

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
    lastMsgPreview: (text || `[${messageType}]`).slice(0, 120),
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

  return json({ ok: true, event: evtType });
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

  // (2) Fetch existing in-chat messages, build periskopeMsgId set for local dedup
  const existingMsgs = await fbGet(env, `${ROOT}/chats/${chatKey}/messages`);
  const existingIds = new Set();
  if (existingMsgs && typeof existingMsgs === "object") {
    for (const m of Object.values(existingMsgs)) {
      if (m && m.periskopeMsgId) existingIds.add(m.periskopeMsgId);
    }
  }

  // (3) Fetch existing meta
  const existingMeta = await fbGet(env, `${ROOT}/chats/${chatKey}/meta`);

  // Build multi-path update
  const updates = {};
  let written = 0, latestTs = 0, latestPreview = "", latestDir = "in";

  for (const m of messages) {
    const id = m.message_id || m.unique_id || m.id?.serialized || null;
    if (!id || existingIds.has(id)) continue;

    const isFromMe = m.from_me === true;
    const text = m.body || "";
    const ts = parseTs(m.timestamp);
    const senderPhone = m.sender_phone ? String(m.sender_phone).split("@")[0] : chatIdToPhone(chatId);
    const msgKey = encodeKey(id);

    updates[`${ROOT}/chats/${chatKey}/messages/${msgKey}`] = {
      direction: isFromMe ? "out" : "in",
      text, ts,
      periskopeMsgId: id,
      messageType: m.message_type || "text",
      senderPhone,
      backfilled: true,
    };
    updates[`${ROOT}/byPeriskopeId/${msgKey}`] = { chatId, msgKey };
    written++;

    if (ts > latestTs) {
      latestTs = ts;
      latestPreview = (text || `[${m.message_type || "media"}]`).slice(0, 120);
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
    skipped: messages.length - written,
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
