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
import { get, onValue, ref, remove, set } from "firebase/database";
import { db } from "@/firebase";
import { useAuth } from "@/auth/AuthContext";
import { ROOT } from "@/config";
import { encodeKey, chatKeyToChatId } from "@/lib/encodeKey";
import { buildFerraIndex, type FerraIndex } from "@/lib/ferra";
import { isDailyGroup as _isDailyGroup } from "@/lib/chats";
import { nextSendActivity } from "@/lib/favorites";
import type {
  ChatMeta,
  ChatRow,
  ChatType,
  ContactInfo,
  CustomerDetail,
  DmMeta,
  DmRow,
  FerraUser,
  SendActivity,
  TeamMember,
  TeamUser,
  Template,
  Ticket,
} from "@/types";

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
}

function normalizePhone(p: string): string {
  return String(p || "").replace(/\D/g, "");
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

  const [chatsRaw, setChatsRaw] = useState<Record<string, { meta?: ChatMeta }>>(
    {},
  );
  const [tickets, setTickets] = useState<Record<string, Ticket>>({});
  const [teamUsers, setTeamUsers] = useState<Record<string, TeamUser>>({});
  const [teamMembers, setTeamMembers] = useState<Record<string, TeamMember>>({});
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
  const [myLastSeen, setMyLastSeen] = useState<Record<string, number>>({});
  const [myFavorites, setMyFavorites] = useState<Record<string, boolean>>({});
  const [mySendActivity, setMySendActivity] = useState<
    Record<string, SendActivity>
  >({});
  const [templates, setTemplates] = useState<Record<string, Template>>({});

  useEffect(() => {
    if (!user) return;
    const unsubs: Array<() => void> = [];
    unsubs.push(
      onValue(ref(db, `${ROOT}/chats`), (s) => setChatsRaw(s.val() || {})),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/tickets`), (s) => setTickets(s.val() || {})),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/users`), (s) => setTeamUsers(s.val() || {})),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/config/teamMembers`), (s) =>
        setTeamMembers(s.val() || {}),
      ),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/dms`), (s) => setDmsByKey(s.val() || {})),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/contacts`), (s) => setContacts(s.val() || {})),
    );
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
        } | null;
        setSharedSubsByPhone(v?.byPhone ?? null);
        setSharedCustomerDetails(v?.customerDetails ?? null);
      }),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/userState/${user.uid}/lastSeen`), (s) =>
        setMyLastSeen(s.val() || {}),
      ),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/userState/${user.uid}/favorites`), (s) =>
        setMyFavorites(s.val() || {}),
      ),
    );
    unsubs.push(
      onValue(ref(db, `${ROOT}/userState/${user.uid}/sendActivity`), (s) =>
        setMySendActivity(s.val() || {}),
      ),
    );
    // Quick-reply templates (v1.126). Read-only on mobile; the desktop
    // dashboard's Templates modal is the source of truth.
    unsubs.push(
      onValue(ref(db, `${ROOT}/config/templates`), (s) =>
        setTemplates(s.val() || {}),
      ),
    );
    return () => {
      for (const u of unsubs) u();
    };
  }, [user]);

  const chatMetaByKey = useMemo(() => {
    const out: Record<string, ChatMeta> = {};
    for (const [chatKey, val] of Object.entries(chatsRaw)) {
      const rawMeta = val.meta || {};
      const chatId = rawMeta.chatId || chatKeyToChatId(chatKey);
      const derivedPhone =
        String(chatId || "").split("@")[0] || rawMeta.phone || chatKey;
      out[chatKey] = { ...rawMeta, chatId, phone: derivedPhone };
    }
    return out;
  }, [chatsRaw]);

  const chatRows = useMemo<ChatRow[]>(() => {
    const rows: ChatRow[] = [];
    for (const [chatKey, val] of Object.entries(chatsRaw)) {
      const rawMeta = val.meta || {};
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
      });
    }
    rows.sort((a, b) => (b.lastMsgAt || 0) - (a.lastMsgAt || 0));
    return rows;
  }, [chatsRaw]);

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
        name: otherUser.name || otherUser.email || "(teammate)",
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
  }, [dmsByKey, teamUsers, user, myLastSeen]);

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
      ferraIndex,
      myLastSeen,
      myFavorites,
      mySendActivity,
      templates,
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
