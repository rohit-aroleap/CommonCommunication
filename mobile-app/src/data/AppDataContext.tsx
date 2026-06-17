// One context attaching every long-lived RTDB listener the app needs:
// chats, tickets, team users, contacts, plus the shared ferra feeds. Screens
// pull from useAppData() rather than re-subscribing themselves, which keeps
// listener count constant regardless of navigation.

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { InteractionManager } from "react-native";
import {
  get,
  limitToLast,
  onValue,
  orderByChild,
  query,
  ref,
  remove,
  set,
} from "firebase/database";
import { db } from "@/firebase";
import { useAuth } from "@/auth/AuthContext";
import { ROOT } from "@/config";
import { encodeKey, chatKeyToChatId } from "@/lib/encodeKey";
import { buildFerraIndex, type FerraIndex } from "@/lib/ferra";
import { normalizePhone as canonicalNormalizePhone } from "@/lib/normalizePhone";
import { isDailyGroup as _isDailyGroup } from "@/lib/chats";
import { nextSendActivity } from "@/lib/favorites";
import { resolveTeammateName } from "@/lib/teamFilter";
import { cacheGet, cacheSet } from "@/data/cache";
import type {
  ChatMeta,
  ChatRow,
  ChatType,
  ContactInfo,
  CustomerDetail,
  DmMeta,
  DmRow,
  FerraSubscription,
  FerraUser,
  SendActivity,
  TeamMember,
  TeamUser,
  Template,
  Ticket,
  UserGrant,
} from "@/types";

// How many chats / DMs to subscribe to. The first paint only needs the
// recent slice — older threads are still reachable by search later (the
// per-thread Thread listener pulls messages on demand). 200 covers a few
// months of customer activity for a busy trainer; bump if anyone reports
// missing rows.
const CHATS_LIMIT = 200;
// v1.279: DMS_LIMIT removed — the DM list now reads the lean /dmsIndex
// mirror in full (tiny) instead of a limitToLast query over the heavy
// /dms subtree.

interface AppDataValue {
  chatRows: ChatRow[];
  chatMetaByKey: Record<string, ChatMeta>;
  tickets: Record<string, Ticket>;
  teamUsers: Record<string, TeamUser>;
  teamMembers: Record<string, TeamMember>;
  teamPhones: Set<string>; // digits-only normalized phones from teamMembers
  dmsByKey: Record<string, { meta?: DmMeta }>;
  dmRows: DmRow[];
  contacts: Record<string, ContactInfo>;
  habitUsers: Record<string, FerraUser> | FerraUser[] | null;
  cancelledUsers: Record<string, FerraUser> | FerraUser[] | null;
  sharedSubsByPhone: Record<string, string> | null;
  sharedCustomerDetails: Record<string, CustomerDetail> | null;
  // v1.243 (Phase E mobile): phone → list of subscriptions this phone is
  // a member of. Keyed by canonical 12-digit phone. Drives the "👥
  // Subscription members" panel in CustomerInfoScreen, mirroring the
  // v1.242 web build. An ARRAY because one phone can be on multiple
  // subscriptions (rare but possible).
  subsByPhone: Map<string, FerraSubscription[]>;
  // v1.212: timestamp from ferraSubscriptions/v1/uploadedAt — the last
  // moment the Ferra-sync worker wrote fresh data. Surfaced in the app
  // header as "↻ 30m ago" so trainers know whether the customer list /
  // stages they're looking at are stale, and tap it to force a refresh.
  ferraLastSyncedAt: number | null;
  ferraIndex: FerraIndex;
  myLastSeen: Record<string, number>;
  markChatSeen: (chatKey: string) => void;
  myFavorites: Record<string, boolean>;
  mySendActivity: Record<string, SendActivity>;
  toggleFavorite: (chatKey: string) => void;
  bumpSendActivity: (chatKey: string) => void;
  // Tab-badge counts. Computed under the same strict rules as push:
  // chatsUnread = customer chats where (latest inbound > myLastSeen) AND
  // (it's my ticket OR I starred it). teamUnread = DMs with inbound newer
  // than myLastSeen. ticketsCount = workload reminder — total open
  // tickets assigned to me, doesn't clear on read. Reactive.
  chatsUnreadCount: number;
  teamUnreadCount: number;
  ticketsCount: number;
  // Quick-reply templates (read-only on mobile in v1.126; desktop manages
  // CRUD). Slash-picker in ThreadScreen reads from this map.
  templates: Record<string, Template>;
  // True once we've either hydrated from on-device cache or received the
  // first /chats snapshot from Firebase. Screens use this to show "Loading
  // chats…" on cold first-install instead of the misleading "No chats
  // match." empty-state during the brief pre-data window.
  dataReady: boolean;
  // v1.196: limited-access trainer plumbing.
  //   isLimited:  derived from teamMembers[myEmail].limited. When true,
  //               the chat list filters down to manually-granted
  //               customers + customers I have an open ticket on.
  //   myGrants:   /userGrants/{myUid} — chatKey → { grantedAt }. Grants
  //               older than 14 days no longer surface the chat.
  //   grantChatAccess(chatKey): writes a grant for the current user.
  isLimited: boolean;
  // v1.223: team tags the current user is a member of (empty = no
  // narrowing). Drives the team-visibility filter in ChatsScreen.
  myTeamTags: Set<string> | null;
  myGrants: Record<string, UserGrant>;
  grantChatAccess: (chatKey: string) => Promise<void>;
}

// v1.241: delegate to the shared canonical normalizer so teamPhones
// matching stays consistent with the rest of the dashboard suite. The
// canonical form is 12-digit Indian (E.164-without-+). Previously this
// returned raw digits, which meant a 10-digit teammate phone wouldn't
// match the 12-digit canonical key used elsewhere — a latent bug the
// canonical helper fixes by also prepending "91" to 10-digit input.
function normalizePhone(p: string): string {
  return canonicalNormalizePhone(p);
}

// v1.243 (Phase E mobile): build the phone → subscriptions reverse
// index from the raw bySubscription snapshot. Mirrors index.html's
// rebuildSubsByPhone() in shape and semantics so the panel renders
// identically on both surfaces. One phone can map to MULTIPLE
// subscriptions (rare: own subscription AND on a parent's) — the UI
// handles that by stacking cards.
function buildSubsByPhoneIndex(
  bySubscription: Record<string, FerraSubscription> | undefined | null,
): Map<string, FerraSubscription[]> {
  const idx = new Map<string, FerraSubscription[]>();
  if (!bySubscription || typeof bySubscription !== "object") return idx;
  for (const subId in bySubscription) {
    const sub = bySubscription[subId];
    if (!sub) continue;
    const phones = new Set<string>();
    const cust = canonicalNormalizePhone(sub.customerPhone || "");
    if (cust) phones.add(cust);
    for (const p of sub.memberPhones || []) {
      const np = canonicalNormalizePhone(p);
      if (np) phones.add(np);
    }
    const tagged: FerraSubscription = { ...sub, _subId: subId };
    for (const p of phones) {
      if (!idx.has(p)) idx.set(p, []);
      idx.get(p)!.push(tagged);
    }
  }
  return idx;
}

// Sorted-UID pairKey. Same convention as web — see index.html getPairKey().
export function getPairKey(uidA: string, uidB: string): string {
  return [String(uidA), String(uidB)].sort().join("_");
}
export function chatKeyFromPairKey(pairKey: string): string {
  return "dm:" + pairKey;
}
export function pairKeyFromChatKey(chatKey: string): string | null {
  return chatKey.startsWith("dm:") ? chatKey.slice(3) : null;
}
export function isDmKey(chatKey: string): boolean {
  return chatKey.startsWith("dm:");
}

const AppDataContext = createContext<AppDataValue | null>(null);

// Re-export so existing call sites that import from this module keep working.
// The implementation lives in lib/chats.ts so it's unit-testable.
export const isDailyGroup = _isDailyGroup;

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();

  // chatsIndex is the meta-only mirror at /commonComm/chatsIndex/{chatKey} —
  // the worker and web app dual-write to it whenever they touch a chat's meta
  // so we can subscribe here without dragging the messages subtree along on
  // every snapshot. Each value is the meta object directly (no `meta` wrapper
  // like the old /chats payload had).
  const [chatsIndex, setChatsIndex] = useState<Record<string, ChatMeta>>({});
  const [tickets, setTickets] = useState<Record<string, Ticket>>({});
  const [teamUsers, setTeamUsers] = useState<Record<string, TeamUser>>({});
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMember>>({});
  // v1.196: my own /userGrants subtree. Used by the limited-trainer chat
  // list filter — chats with a grant in the last 14 days appear in my
  // list (in addition to any chat I have an open ticket on).
  const [myGrants, setMyGrants] = useState<Record<string, UserGrant>>({});
  const [dmsByKey, setDmsByKey] = useState<Record<string, { meta?: DmMeta }>>({});
  const [contacts, setContacts] = useState<Record<string, ContactInfo>>({});
  const [habitUsers, setHabitUsers] = useState<
    Record<string, FerraUser> | FerraUser[] | null
  >(null);
  const [cancelledUsers, setCancelledUsers] = useState<
    Record<string, FerraUser> | FerraUser[] | null
  >(null);
  const [sharedSubsByPhone, setSharedSubsByPhone] = useState<
    Record<string, string> | null
  >(null);
  const [sharedCustomerDetails, setSharedCustomerDetails] = useState<
    Record<string, CustomerDetail> | null
  >(null);
  // v1.243 (Phase E mobile): phone → subscriptions reverse index, built
  // each time the ferraSubscriptions/v1 listener fires. See
  // rebuildSubsByPhone helper below + the snapshot callback at
  // attachTier3 where the rebuild fires.
  const [subsByPhone, setSubsByPhone] = useState<
    Map<string, FerraSubscription[]>
  >(() => new Map());
  // v1.212: when Ferra last synced (epoch ms). Updated whenever the
  // ferraSubscriptions/v1 node is rewritten by the Ferra-sync worker.
  const [ferraLastSyncedAt, setFerraLastSyncedAt] = useState<number | null>(
    null,
  );
  const [myLastSeen, setMyLastSeen] = useState<Record<string, number>>({});
  const [myFavorites, setMyFavorites] = useState<Record<string, boolean>>({});
  const [mySendActivity, setMySendActivity] = useState<
    Record<string, SendActivity>
  >({});
  const [templates, setTemplates] = useState<Record<string, Template>>({});
  const [dataReady, setDataReady] = useState(false);

  useEffect(() => {
    if (!user) {
      setDataReady(false);
      return;
    }
    const uid = user.uid;
    const unsubs: Array<() => void> = [];
    let cancelled = false;

    // 1. Hydrate React state from the on-device cache so the UI paints with
    //    last-known data instead of waiting for the network. Each key runs
    //    independently — if one cache entry is missing or corrupt, the rest
    //    still load. Live listeners below overwrite as snapshots arrive.
    cacheGet<Record<string, ChatMeta>>(uid, "chatsIndex").then((v) => {
      if (cancelled) return;
      if (v) setChatsIndex(v);
      // Cache hit OR cache miss both unblock the loading state: a miss
      // means no prior session, so the live listener is the only source
      // and we want screens to show their normal empty UX rather than a
      // permanent "Loading…".
      setDataReady(true);
    });
    cacheGet<Record<string, Ticket>>(uid, "tickets").then((v) => {
      if (!cancelled && v) setTickets(v);
    });
    cacheGet<Record<string, TeamUser>>(uid, "teamUsers").then((v) => {
      if (!cancelled && v) setTeamUsers(v);
    });
    cacheGet<Record<string, TeamMember>>(uid, "teamMembers").then((v) => {
      if (!cancelled && v) setTeamMembers(v);
    });
    cacheGet<Record<string, { meta?: DmMeta }>>(uid, "dmsByKey").then((v) => {
      if (!cancelled && v) setDmsByKey(v);
    });
    cacheGet<Record<string, ContactInfo>>(uid, "contacts").then((v) => {
      if (!cancelled && v) setContacts(v);
    });
    cacheGet<Record<string, number>>(uid, "myLastSeen").then((v) => {
      if (!cancelled && v) setMyLastSeen(v);
    });
    cacheGet<Record<string, boolean>>(uid, "myFavorites").then((v) => {
      if (!cancelled && v) setMyFavorites(v);
    });
    cacheGet<Record<string, UserGrant>>(uid, "myGrants").then((v) => {
      if (!cancelled && v) setMyGrants(v);
    });
    cacheGet<Record<string, SendActivity>>(uid, "mySendActivity").then((v) => {
      if (!cancelled && v) setMySendActivity(v);
    });
    cacheGet<Record<string, Template>>(uid, "templates").then((v) => {
      if (!cancelled && v) setTemplates(v);
    });
    // ferra* snapshots can be megabytes — round-trip through AsyncStorage
    // is slower than just letting the live listener stream them in once
    // the JS thread is idle. Not cached on purpose.

    // 2. Attach listeners in three tiers. Tier 1 fires immediately because
    //    the first paint depends on it; Tier 2 + 3 wait for the navigator
    //    to finish its initial render so we don't block on parsing /
    //    setState during the most jank-sensitive moment.
    const attachTier1 = () => {
      // Recent chats only. orderByChild + limitToLast pushes the slicing to
      // the server; without it Firebase ships every chat ever to the client.
      // Requires .indexOn "lastMsgAt" under /chatsIndex in database.rules.json.
      // chatsIndex is the meta-only mirror — subscribing here avoids pulling
      // the messages subtree (MBs per chat) just to render the chat list.
      const chatsQuery = query(
        ref(db, `${ROOT}/chatsIndex`),
        orderByChild("lastMsgAt"),
        limitToLast(CHATS_LIMIT),
      );
      unsubs.push(
        onValue(chatsQuery, (s) => {
          const v = (s.val() || {}) as Record<string, ChatMeta>;
          setChatsIndex(v);
          cacheSet(uid, "chatsIndex", v);
          setDataReady(true);
        }),
      );
      unsubs.push(
        onValue(ref(db, `${ROOT}/tickets`), (s) => {
          const v = (s.val() || {}) as Record<string, Ticket>;
          setTickets(v);
          cacheSet(uid, "tickets", v);
        }),
      );
      unsubs.push(
        onValue(ref(db, `${ROOT}/userState/${uid}/lastSeen`), (s) => {
          const v = (s.val() || {}) as Record<string, number>;
          setMyLastSeen(v);
          cacheSet(uid, "myLastSeen", v);
        }),
      );
      unsubs.push(
        onValue(ref(db, `${ROOT}/userState/${uid}/favorites`), (s) => {
          const v = (s.val() || {}) as Record<string, boolean>;
          setMyFavorites(v);
          cacheSet(uid, "myFavorites", v);
        }),
      );
      // v1.196: my own customer-access grants (limited-trainer flow).
      unsubs.push(
        onValue(ref(db, `${ROOT}/userGrants/${uid}`), (s) => {
          const v = (s.val() || {}) as Record<string, UserGrant>;
          setMyGrants(v);
          cacheSet(uid, "myGrants", v);
        }),
      );
    };

    const attachTier2 = () => {
      if (cancelled) return;
      unsubs.push(
        onValue(ref(db, `${ROOT}/users`), (s) => {
          const v = (s.val() || {}) as Record<string, TeamUser>;
          setTeamUsers(v);
          cacheSet(uid, "teamUsers", v);
        }),
      );
      unsubs.push(
        onValue(ref(db, `${ROOT}/config/teamMembers`), (s) => {
          const v = (s.val() || {}) as Record<string, TeamMember>;
          setTeamMembers(v);
          cacheSet(uid, "teamMembers", v);
        }),
      );
      // v1.279: subscribe to the lean /dmsIndex mirror instead of the
      // full /dms subtree (which dragged every message of every thread,
      // ~9 KB/record, for up to DMS_LIMIT threads). /dmsIndex stores meta
      // fields FLAT under /dmsIndex/{pk}/*; wrap each back into { meta }
      // so dmsByKey keeps the { meta } shape the dmRows builder expects.
      // The index is tiny (~32 threads × ~150 B) so we read it whole — no
      // limitToLast / orderByChild (which would need an .indexOn rule).
      unsubs.push(
        onValue(ref(db, `${ROOT}/dmsIndex`), (s) => {
          const raw = (s.val() || {}) as Record<string, DmMeta>;
          const wrapped: Record<string, { meta?: DmMeta }> = {};
          for (const [pk, fields] of Object.entries(raw)) {
            wrapped[pk] = { meta: fields || {} };
          }
          setDmsByKey(wrapped);
          cacheSet(uid, "dmsByKey", wrapped);
        }),
      );
      unsubs.push(
        onValue(ref(db, `${ROOT}/contacts`), (s) => {
          const v = (s.val() || {}) as Record<string, ContactInfo>;
          setContacts(v);
          cacheSet(uid, "contacts", v);
        }),
      );
      unsubs.push(
        onValue(ref(db, `${ROOT}/userState/${uid}/sendActivity`), (s) => {
          const v = (s.val() || {}) as Record<string, SendActivity>;
          setMySendActivity(v);
          cacheSet(uid, "mySendActivity", v);
        }),
      );
      // Quick-reply templates (v1.126). Read-only on mobile; the desktop
      // dashboard's Templates modal is the source of truth.
      unsubs.push(
        onValue(ref(db, `${ROOT}/config/templates`), (s) => {
          const v = (s.val() || {}) as Record<string, Template>;
          setTemplates(v);
          cacheSet(uid, "templates", v);
        }),
      );
    };

    const attachTier3 = () => {
      if (cancelled) return;
      // ferra* lookups only affect display name + status pill on existing
      // chat rows. Rows render fine without them (fall back to phone +
      // contact name), so deferring keeps initial parse cost off the path.
      unsubs.push(
        onValue(ref(db, "ferraHabitData/v1/users"), (s) =>
          setHabitUsers(s.val()),
        ),
      );
      unsubs.push(
        onValue(ref(db, "ferraHabitData/v1/cancelledUsers"), (s) =>
          setCancelledUsers(s.val()),
        ),
      );
      unsubs.push(
        onValue(ref(db, "ferraSubscriptions/v1"), (s) => {
          const v = s.val() as {
            byPhone?: Record<string, string>;
            customerDetails?: Record<string, CustomerDetail>;
            // v1.243 (Phase E mobile): same node the v1.242 web build
            // reads. One entry per Ferra subscription, with
            // customerPhone + memberPhones[] + memberNames[]. We turn
            // it into a phone → subscriptions reverse index right here
            // so the consumer (CustomerInfoScreen) is just a lookup.
            bySubscription?: Record<string, FerraSubscription>;
            // v1.212: epoch-ms timestamp the Ferra-sync worker writes on
            // every successful pull. Used to render the "↻ 30m ago" pill
            // in the app header.
            uploadedAt?: number | string;
          } | null;
          setSharedSubsByPhone(v?.byPhone ?? null);
          setSharedCustomerDetails(v?.customerDetails ?? null);
          // v1.243: rebuild the phone → subscriptions reverse index
          // every time fresh subscription data arrives. Mirrors the
          // v1.242 web build's rebuildSubsByPhone() inside index.html.
          setSubsByPhone(buildSubsByPhoneIndex(v?.bySubscription));
          // Coerce — the worker has historically written either a number
          // (epoch ms) or an ISO string. Try numeric first, fall back to
          // Date.parse, fall back to null.
          const rawTs = v?.uploadedAt ?? null;
          if (typeof rawTs === "number" && Number.isFinite(rawTs)) {
            setFerraLastSyncedAt(rawTs);
          } else if (typeof rawTs === "string") {
            const parsed = Date.parse(rawTs);
            setFerraLastSyncedAt(Number.isFinite(parsed) ? parsed : null);
          } else {
            setFerraLastSyncedAt(null);
          }
        }),
      );
    };

    attachTier1();
    const t2 = InteractionManager.runAfterInteractions(attachTier2);
    // Stagger tier 3 a tick beyond tier 2 so the two waves of state
    // updates don't land in the same frame and re-trigger every useMemo.
    const t3 = InteractionManager.runAfterInteractions(() => {
      setTimeout(attachTier3, 50);
    });

    return () => {
      cancelled = true;
      t2.cancel?.();
      t3.cancel?.();
      for (const u of unsubs) u();
    };
  }, [user]);

  const chatMetaByKey = useMemo(() => {
    const out: Record<string, ChatMeta> = {};
    for (const [chatKey, rawMeta] of Object.entries(chatsIndex)) {
      const chatId = rawMeta?.chatId || chatKeyToChatId(chatKey);
      const derivedPhone =
        String(chatId || "").split("@")[0] || rawMeta?.phone || chatKey;
      out[chatKey] = { ...rawMeta, chatId, phone: derivedPhone };
    }
    return out;
  }, [chatsIndex]);

  const chatRows = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];
    for (const [chatKey, rawMeta] of Object.entries(chatsIndex)) {
      if (!rawMeta) continue;
      const chatId = rawMeta.chatId || chatKeyToChatId(chatKey);
      const derivedPhone =
        String(chatId || "").split("@")[0] || rawMeta.phone || chatKey;
      let preview = rawMeta.lastMsgPreview || "";
      if (preview === "(added from Ferra)" || preview === "(new chat)") {
        preview = "";
      }
      const chatType: ChatType =
        rawMeta.chatType ||
        (String(chatId).endsWith("@g.us") ? "group" : "user");
      rows.push({
        chatKey,
        chatId,
        chatType,
        phone: derivedPhone,
        explicitName: rawMeta.contactName || rawMeta.displayName || null,
        groupName: rawMeta.groupName || null,
        private: rawMeta.private === true,
        lastMsgAt: rawMeta.lastMsgAt || 0,
        preview,
        direction: rawMeta.lastMsgDirection || "in",
        sentByName: rawMeta.lastMsgSentByName || null,
        // v1.291: latest-TEXT metadata for the daily-workout Text-only view.
        lastTextMsgAt: rawMeta.lastTextMsgAt || 0,
        lastTextPreview: rawMeta.lastTextPreview || "",
        lastTextSender: rawMeta.lastTextSender || null,
        lastTextDirection: rawMeta.lastTextDirection || "in",
      });
    }
    rows.sort((a, b) => (b.lastMsgAt || 0) - (a.lastMsgAt || 0));
    return rows;
  }, [chatsIndex]);

  const ferraIndex = useMemo(
    () => buildFerraIndex(habitUsers, cancelledUsers),
    [habitUsers, cancelledUsers],
  );

  // Suppression set: every phone listed under any teammate's config record.
  // Drives both customer-inbox filtering and the "new chat" redirect.
  const teamPhones = useMemo(() => {
    const out = new Set<string>();
    for (const m of Object.values(teamMembers)) {
      if (!m?.phones) continue;
      for (const [ph, on] of Object.entries(m.phones)) {
        if (on) out.add(normalizePhone(ph));
      }
    }
    return out;
  }, [teamMembers]);

  // Compose dmRows for the Team screen. Pulls participant display info from
  // teamUsers (whichever teammate isn't the current user) and unread state
  // from myLastSeen (same mechanism customer chats use).
  const dmRows = useMemo<DmRow[]>(() => {
    if (!user) return [];
    const out: DmRow[] = [];
    for (const [pairKey, pair] of Object.entries(dmsByKey)) {
      const meta = pair?.meta || {};
      const parts = meta.participants || {};
      if (parts[user.uid] !== true) continue;
      const otherUid =
        Object.keys(parts).find((u) => u !== user.uid) || user.uid;
      const otherUser = teamUsers[otherUid] || {};
      const chatKey = chatKeyFromPairKey(pairKey);
      out.push({
        pairKey,
        chatKey,
        otherUid,
        // v1.195: admin name override from /config/teamMembers takes
        // priority. resolveTeammateName falls back to otherUser.name then
        // email, so behavior matches the previous default when no admin
        // override exists.
        name: resolveTeammateName(otherUid, otherUser.email, teamUsers, teamMembers),
        email: otherUser.email || "",
        photoURL: otherUser.photoURL || null,
        lastMsgAt: meta.lastMsgAt || 0,
        preview: meta.lastMsgPreview || "",
        lastMsgFromUid: meta.lastMsgFromUid || null,
        lastMsgFromName: meta.lastMsgFromName || null,
        unread:
          (meta.lastMsgAt || 0) > (myLastSeen[chatKey] || 0) &&
          meta.lastMsgFromUid !== user.uid,
      });
    }
    out.sort((a, b) => (b.lastMsgAt || 0) - (a.lastMsgAt || 0));
    return out;
  }, [dmsByKey, teamUsers, teamMembers, user, myLastSeen]);

  // Tab badge counts. Match the worker's push targeting rules so what you
  // see on the icon matches what you'd get pinged for. Recomputed on every
  // chatRows / tickets / favorites / myLastSeen update — all reactive.
  const chatsUnreadCount = useMemo(() => {
    if (!user) return 0;
    // Build the set of chatKeys where I have an open ticket assigned.
    const myTicketKeys = new Set<string>();
    for (const t of Object.values(tickets)) {
      if (
        t &&
        t.status === "open" &&
        t.assignee === user.uid &&
        t.anchorChatId
      ) {
        myTicketKeys.add(
          String(t.anchorChatId).replace(/[.#$\[\]\/]/g, "_"),
        );
      }
    }
    let count = 0;
    for (const r of chatRows) {
      if (r.direction !== "in") continue; // last message wasn't inbound
      const lastMsgAt = r.lastMsgAt || 0;
      const seen = myLastSeen[r.chatKey] || 0;
      if (lastMsgAt <= seen) continue;
      // Strict rule: only count if I have a ticket or I starred it
      const isMine = myTicketKeys.has(r.chatKey);
      const isFavorite = !!myFavorites[r.chatKey];
      if (!isMine && !isFavorite) continue;
      count++;
    }
    return count;
  }, [user, chatRows, tickets, myFavorites, myLastSeen]);

  const teamUnreadCount = useMemo(() => {
    return dmRows.filter((r) => r.unread).length;
  }, [dmRows]);

  // My tickets tab badge: count of open tickets currently assigned to me.
  // Different signal from chatsUnreadCount — this is a workload reminder,
  // it doesn't clear when I open the tab. Stays visible as long as I have
  // open tickets, falls when I resolve or get reassigned off.
  const ticketsCount = useMemo(() => {
    if (!user) return 0;
    let n = 0;
    for (const t of Object.values(tickets)) {
      if (t && t.status === "open" && t.assignee === user.uid) n++;
    }
    return n;
  }, [tickets, user]);

  const markChatSeen = (chatKey: string) => {
    if (!user || !chatKey) return;
    set(
      ref(db, `${ROOT}/userState/${user.uid}/lastSeen/${chatKey}`),
      Date.now(),
    ).catch(() => {});
  };

  const toggleFavorite = (chatKey: string) => {
    if (!user || !chatKey) return;
    const path = `${ROOT}/userState/${user.uid}/favorites/${chatKey}`;
    if (myFavorites[chatKey]) {
      remove(ref(db, path)).catch(() => {});
    } else {
      set(ref(db, path), true).catch(() => {});
    }
  };

  // Read-modify-write the per-chat send counter. Used by ThreadScreen on
  // every outgoing message; one extra read per send is fine for a hint.
  const bumpSendActivity = (chatKey: string) => {
    if (!user || !chatKey) return;
    const path = `${ROOT}/userState/${user.uid}/sendActivity/${chatKey}`;
    get(ref(db, path))
      .then((snap) => {
        const next = nextSendActivity(
          snap.val() as SendActivity | null,
        );
        return set(ref(db, path), next);
      })
      .catch(() => {});
  };

  // v1.196: derive limited-trainer flag from teamMembers config keyed by
  // the current user's email. Limited === false (or the user not being
  // in teamMembers at all, e.g. bootstrap admins) means unrestricted.
  const isLimited = useMemo(() => {
    const myEmail = (user?.email || "").toLowerCase();
    if (!myEmail) return false;
    for (const m of Object.values(teamMembers || {})) {
      if (m?.email && m.email.toLowerCase() === myEmail) {
        return !!m.limited;
      }
    }
    return false;
  }, [teamMembers, user?.email]);

  // v1.223: derive team-tag membership from the same teamMembers record.
  // Empty Set = no team narrowing (full visibility — back-compat). Admin
  // membership is NOT checked here because we don't have isAdmin on
  // mobile; bootstrap admins are still in teamMembers with their email
  // and just need their `teams` field unset (default behavior). Returns
  // null when the user has no narrowing so the consumer can short-circuit.
  const myTeamTags = useMemo<Set<string> | null>(() => {
    const myEmail = (user?.email || "").toLowerCase();
    if (!myEmail) return null;
    for (const m of Object.values(teamMembers || {})) {
      if (!m?.email || m.email.toLowerCase() !== myEmail) continue;
      const raw = (m as unknown as { teams?: unknown }).teams;
      if (Array.isArray(raw)) {
        return raw.length === 0 ? null : new Set(raw as string[]);
      }
      if (raw && typeof raw === "object") {
        const set = new Set<string>();
        for (const [k, v] of Object.entries(raw)) {
          if (v) set.add(k);
        }
        return set.size === 0 ? null : set;
      }
      return null;
    }
    return null;
  }, [teamMembers, user?.email]);

  // v1.196: writes a grant for the current user on `chatKey`. Used by the
  // "Add customer" flow on the limited-trainer chat list.
  const grantChatAccess = async (chatKey: string) => {
    if (!user || !chatKey) return;
    await set(ref(db, `${ROOT}/userGrants/${user.uid}/${chatKey}`), {
      grantedAt: Date.now(),
    });
  };

  const value: AppDataValue = useMemo(
    () => ({
      chatRows,
      chatMetaByKey,
      tickets,
      teamUsers,
      teamMembers,
      teamPhones,
      dmsByKey,
      dmRows,
      contacts,
      habitUsers,
      cancelledUsers,
      sharedSubsByPhone,
      sharedCustomerDetails,
      subsByPhone,
      ferraLastSyncedAt,
      ferraIndex,
      myLastSeen,
      markChatSeen,
      myFavorites,
      mySendActivity,
      toggleFavorite,
      bumpSendActivity,
      chatsUnreadCount,
      teamUnreadCount,
      ticketsCount,
      templates,
      dataReady,
      isLimited,
      myTeamTags,
      myGrants,
      grantChatAccess,
    }),
    [
      chatRows,
      chatMetaByKey,
      tickets,
      teamUsers,
      teamMembers,
      teamPhones,
      dmsByKey,
      dmRows,
      contacts,
      habitUsers,
      cancelledUsers,
      chatsUnreadCount,
      teamUnreadCount,
      ticketsCount,
      sharedSubsByPhone,
      sharedCustomerDetails,
      subsByPhone,
      ferraLastSyncedAt,
      ferraIndex,
      myLastSeen,
      myFavorites,
      mySendActivity,
      templates,
      dataReady,
      isLimited,
      myTeamTags,
      myGrants,
    ],
  );

  return (
    <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>
  );
}

export function useAppData(): AppDataValue {
  const v = useContext(AppDataContext);
  if (!v) throw new Error("useAppData must be inside <AppDataProvider>");
  return v;
}

// Helper that screens use to look up the current user's open tickets without
// needing to re-implement the filter each time.
export function myOpenTickets(
  tickets: Record<string, Ticket>,
  uid: string | undefined,
): Ticket[] {
  if (!uid) return [];
  const out: Ticket[] = [];
  for (const [id, t] of Object.entries(tickets)) {
    if (!t || t.status !== "open" || t.assignee !== uid) continue;
    out.push({ ...t, id });
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}

export function openTicketsForChat(
  tickets: Record<string, Ticket>,
  chatKey: string,
): Ticket[] {
  const out: Ticket[] = [];
  for (const [id, t] of Object.entries(tickets)) {
    if (!t || t.status !== "open" || !t.anchorChatId) continue;
    if (encodeKey(t.anchorChatId) !== chatKey) continue;
    out.push({ ...t, id });
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}
