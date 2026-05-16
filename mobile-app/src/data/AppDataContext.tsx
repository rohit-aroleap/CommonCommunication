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
  FerraUser,
  SendActivity,
  TeamUser,
  Ticket,
} from "@/types";

interface AppDataValue {
  chatRows: ChatRow[];
  chatMetaByKey: Record<string, ChatMeta>;
  tickets: Record<string, Ticket>;
  teamUsers: Record<string, TeamUser>;
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
    }),
    [
      chatRows,
      chatMetaByKey,
      tickets,
      teamUsers,
      contacts,
      habitUsers,
      cancelledUsers,
      sharedSubsByPhone,
      sharedCustomerDetails,
      ferraIndex,
      myLastSeen,
      myFavorites,
      mySendActivity,
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
