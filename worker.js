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
      if (url.pathname === "/messages" && request.method === "GET") {
        return cors(env, await handleFetchMessages(request, env));
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
  // Periskope event shape: { event: "message.created", data: { ...message } }
  // Be defensive — pull from common locations.
  const evtType = payload?.event || payload?.type || "unknown";
  const msg = payload?.data || payload?.message || payload;

  if (!msg) return json({ ok: true, skipped: "no message" });

  const chatId = msg.chat_id || msg.chatId;
  if (!chatId) return json({ ok: true, skipped: "no chat_id" });

  const isFromMe = msg.from_me === true || msg.fromMe === true;
  const text = msg.body || msg.message || msg.text || "";
  const ts = (msg.timestamp ? Number(msg.timestamp) * (String(msg.timestamp).length <= 10 ? 1000 : 1) : Date.now());
  const periskopeMsgId = msg.message_id || msg.id || null;
  const senderName = msg.sender_name || msg.contact_name || null;
  const senderPhone = msg.sender_phone || chatIdToPhone(chatId);
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
