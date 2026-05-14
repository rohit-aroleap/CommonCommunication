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
  await fbPatch(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`, {
    phone: senderPhone,
    chatId,
    contactName: senderName || null,
    lastMsgAt: ts,
    lastMsgPreview: (text || `[${messageType}]`).slice(0, 120),
    lastMsgDirection: isFromMe ? "out" : "in",
  });

  return json({ ok: true, event: evtType });
}

// ---------- /messages?chatId=...  (reconciliation poller fallback) ----------
// ---------- /backfill-batch (admin-triggered import from Periskope) ----------
async function handleBackfillBatch(request, env) {
  const body = await request.json().catch(() => ({}));
  const chatOffset = Math.max(0, Number(body.chatOffset) || 0);
  const chatLimit = Math.min(10, Math.max(1, Number(body.chatLimit) || 3));
  const msgsPerChat = Math.min(500, Math.max(1, Number(body.msgsPerChat) || 100));

  const chatsRes = await fetch(
    `${PERISKOPE_BASE}/chats?offset=${chatOffset}&limit=${chatLimit}&chat_type=user`,
    { headers: periskopeHeaders(env) }
  );
  const chatsJson = await safeJson(chatsRes);
  if (!chatsRes.ok) return json({ error: "list_chats_failed", details: chatsJson }, 502);

  const chats = chatsJson?.chats || [];
  const total = chatsJson?.count || 0;
  const processed = [];

  for (const c of chats) {
    try {
      processed.push(await backfillOneChat(env, c, msgsPerChat));
    } catch (e) {
      processed.push({ chatId: c.chat_id, error: String(e && e.message || e) });
    }
  }

  const nextOffset = chatOffset + chats.length;
  const done = chats.length === 0 || nextOffset >= total;
  return json({ processed, total, nextOffset, done });
}

async function backfillOneChat(env, chat, msgsPerChat) {
  const chatId = chat.chat_id;
  if (!chatId) return { error: "no chatId" };

  const msgsRes = await fetch(
    `${PERISKOPE_BASE}/chats/${encodeURIComponent(chatId)}/messages?offset=0&limit=${msgsPerChat}`,
    { headers: periskopeHeaders(env) }
  );
  const msgsJson = await safeJson(msgsRes);
  if (!msgsRes.ok) return { chatId, error: "msgs_fetch_failed" };

  const messages = msgsJson?.messages || [];

  // Parallel dedup check
  const checks = await Promise.all(messages.map(async (m) => {
    const id = m.message_id || m.unique_id || m.id?.serialized || null;
    if (!id) return null;
    const existing = await fbGet(env, `${ROOT}/byPeriskopeId/${encodeKey(id)}`);
    return existing ? null : { m, id };
  }));
  const toWrite = checks.filter(Boolean);

  // Compute latest message for meta (do this before parallel writes to avoid races)
  let latestTs = 0, latestPreview = "", latestDir = "in";
  for (const { m } of toWrite) {
    const ts = parseTs(m.timestamp);
    if (ts > latestTs) {
      latestTs = ts;
      latestPreview = (m.body || `[${m.message_type || "media"}]`).slice(0, 120);
      latestDir = m.from_me ? "out" : "in";
    }
  }

  // Parallel writes
  await Promise.all(toWrite.map(async ({ m, id }) => {
    const isFromMe = m.from_me === true;
    const record = {
      direction: isFromMe ? "out" : "in",
      text: m.body || "",
      ts: parseTs(m.timestamp),
      periskopeMsgId: id,
      messageType: m.message_type || "text",
      senderPhone: m.sender_phone ? String(m.sender_phone).split("@")[0] : chatIdToPhone(chatId),
      backfilled: true,
    };
    const pushed = await fbPush(env, `${ROOT}/chats/${encodeKey(chatId)}/messages`, record);
    if (pushed?.name) {
      await fbPut(env, `${ROOT}/byPeriskopeId/${encodeKey(id)}`, { chatId, msgKey: pushed.name });
    }
  }));

  // Update chat meta only if we have something new and it's actually newer than what's there
  if (toWrite.length > 0) {
    const existingMeta = await fbGet(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`);
    const meta = {
      chatId,
      phone: chatIdToPhone(chatId),
      contactName: chat.chat_name || existingMeta?.contactName || null,
    };
    if (latestTs > 0 && (!existingMeta?.lastMsgAt || latestTs > existingMeta.lastMsgAt)) {
      meta.lastMsgAt = latestTs;
      meta.lastMsgPreview = latestPreview;
      meta.lastMsgDirection = latestDir;
    }
    await fbPatch(env, `${ROOT}/chats/${encodeKey(chatId)}/meta`, meta);
  }

  return {
    chatId,
    name: chat.chat_name || chatIdToPhone(chatId),
    written: toWrite.length,
    skipped: messages.length - toWrite.length,
    fetched: messages.length,
  };
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
