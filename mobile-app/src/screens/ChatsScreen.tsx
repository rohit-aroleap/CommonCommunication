// Chats tab. Filter + search across all visible chat rows, then render the
// list. The filter rules (daily-groups hidden by default, status/stage
// exclusions) match mobile.html exactly.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import { useAppData, isDailyGroup, type CgroupRow } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { ChatRowItem, claimInitials, CLAIM_BLUE } from "@/components/ChatRow";
import { cohortPhoneKey, useCohorts } from "@/lib/cohorts";
import { useDailyTextOnly } from "@/lib/dailyTextOnly";
import { FilterBar } from "@/components/FilterBar";
import { AddCustomerModal } from "@/components/AddCustomerModal";
import { DAILY_SENTINEL } from "@/types";
import { FERRA_TAG_STAGE, FERRA_TAG_TEAMS, ROOT } from "@/config";
import { db } from "@/firebase";
import { encodeKey } from "@/lib/encodeKey";
import { ref, set } from "firebase/database";
import { normalizeFerraPhone } from "@/lib/ferra";
import { shouldSuggestPin } from "@/lib/favorites";
import { formatTime } from "@/lib/format";
import { getDisplayVersion } from "@/lib/version";
import { getGroqKey } from "@/lib/groqKey";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "@/screens/types";

// ChatsScreen lives inside the tab navigator but pushes to the root stack's
// Thread route. Using useNavigation typed against the stack avoids the
// "tab screen but used as stack" prop mismatch.
type Nav = NativeStackNavigationProp<RootStackParamList>;

function isCustomerTeamPhoneException(phone: string) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits === "9650854161" || digits === "919650854161" || digits.endsWith("9650854161");
}

export function ChatsScreen() {
  const navigation = useNavigation<Nav>();
  const { isAdmin } = useAuth();
  const {
    chatRows,
    chatMetaByKey,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
    sharedCustomerDetails,
    subsByPhone,
    tickets,
    sharedSubsByPhone,
    myLastSeen,
    teamPhones,
    myFavorites,
    mySendActivity,
    toggleFavorite,
    dataReady,
    isLimited,
    myTeamTags,
    myGrants,
    grantChatAccess,
    channelAccess,
    watiActivityByPhone,
    cgroups,
    cgroupsLoading,
    loadCgroups,
    claims,
  } = useAppData();
  const { user } = useAuth();

  const [statusFilter, setStatusFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [search, setSearch] = useState("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // v1.330: list-level Periskope/Wati sort toggle. "wati" re-orders the list
  // by Wati activity. Only meaningful for members with Wati access.
  const [chatListChannel, setChatListChannel] = useState<
    "periskope" | "wati" | "cgroups"
  >("periskope");
  const watiMode = chatListChannel === "wati" && channelAccess.wati;
  // v1.341: CGroups channel — per-customer WhatsApp groups on +919187651332.
  // Visible to any non-limited trainer (it lists EVERY customer group).
  const cgroupsMode = chatListChannel === "cgroups" && !isLimited;
  // Fetch the CGroups list the first time the tab is opened.
  useEffect(() => {
    if (cgroupsMode && cgroups === null && !cgroupsLoading) loadCgroups();
  }, [cgroupsMode, cgroups, cgroupsLoading, loadCgroups]);
  // A limited trainer can never be on CGroups — fall back to Trainer 1.
  useEffect(() => {
    if (chatListChannel === "cgroups" && isLimited) setChatListChannel("periskope");
  }, [chatListChannel, isLimited]);
  // Wati activity keyed by last-10 digits so it matches a chat row's phone
  // regardless of country-code / formatting differences.
  const watiActivityByTen = useMemo(() => {
    const m: Record<
      string,
      { lastMsgAt: number; lastMsgPreview: string; lastMsgDirection: string }
    > = {};
    for (const [phone, meta] of Object.entries(watiActivityByPhone || {})) {
      const k = String(phone).replace(/\D/g, "").slice(-10);
      if (k && (!m[k] || meta.lastMsgAt > m[k].lastMsgAt)) m[k] = meta;
    }
    return m;
  }, [watiActivityByPhone]);
  const watiActivityFor = useCallback(
    (phone: string) =>
      watiActivityByTen[String(phone || "").replace(/\D/g, "").slice(-10)],
    [watiActivityByTen],
  );
  // v1.274: daily-cohort registry — powers the "no group" pill on rows.
  const { assignedPhoneKeys: cohortAssignedKeys, loaded: cohortsLoaded } =
    useCohorts();
  // v1.291: daily-workout "Text only" toggle (shared with ThreadScreen).
  const [dailyTextOnly, setDailyTextOnly] = useDailyTextOnly();
  const dailyView = statusFilter === DAILY_SENTINEL;
  const textOnlyMode = dailyView && dailyTextOnly;
  // v1.196: limited-trainer "Add customer" modal state.
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);
  const styles = useStyles(makeStyles);
  const { colors } = useTheme(); // v1.355: claim status-light avatar colours

  // v1.146: warn the user if their phone doesn't have a Groq API key set.
  // Without it, voice-note transcription silently falls back to the slow
  // Worker /transcribe path (~3× slower). Re-checks every time the chats
  // tab gains focus so the banner disappears the moment the admin pastes
  // a key into Settings. `null` = still loading; suppresses the banner so
  // it doesn't flash on mount before the AsyncStorage read resolves.
  const [hasGroqKey, setHasGroqKey] = useState<boolean | null>(null);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      getGroqKey()
        .then((k) => {
          if (!cancelled) setHasGroqKey(!!k);
        })
        .catch(() => {
          if (!cancelled) setHasGroqKey(null);
        });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const myUid = user?.uid;

  // v1.199: when the search input looks like a phone number, normalize it
  // for the "Start a new chat" affordance. Returns null for non-phone
  // inputs (names, partial numbers under 7 digits, etc.) so the affordance
  // stays hidden in those cases. 10-digit Indian mobile numbers get +91
  // auto-prefixed — same heuristic the AddCustomerModal uses.
  const searchPhoneNormalized = useMemo<string | null>(() => {
    if (!search.trim()) return null;
    const digits = search.replace(/\D/g, "");
    if (digits.length < 7) return null;
    let normalized = digits;
    if (digits.length === 10 && /^[6-9]/.test(digits)) {
      normalized = "91" + digits;
    }
    return normalized;
  }, [search]);

  // v1.199: "Start a new chat" handler. Creates a chat skeleton if one
  // doesn't already exist (so the chat row appears in the list and the
  // worker has a target chatId), writes a userGrant for limited trainers
  // so the new chat surfaces in their filtered list, then navigates to
  // the Thread screen.
  const startChatWithPhone = useCallback(async () => {
    if (!searchPhoneNormalized || !user) return;
    const chatId = `${searchPhoneNormalized}@c.us`;
    const chatKey = encodeKey(chatId);
    try {
      if (!chatMetaByKey[chatKey]) {
        await set(ref(db, `${ROOT}/chats/${chatKey}/meta`), {
          chatId,
          phone: searchPhoneNormalized,
          chatType: "user",
          lastMsgAt: Date.now(),
          lastMsgPreview: "",
        });
      }
      if (isLimited) await grantChatAccess(chatKey);
      setSearch("");
      navigation.navigate("Thread", {
        chatKey,
        initialTitle: "+" + searchPhoneNormalized,
      });
    } catch (e) {
      Alert.alert("Couldn't start chat", (e as Error)?.message ?? String(e));
    }
  }, [
    searchPhoneNormalized,
    user,
    chatMetaByKey,
    isLimited,
    grantChatAccess,
    navigation,
  ]);

  const myTicketChatKeys = useMemo(() => {
    const out = new Set<string>();
    if (!myUid) return out;
    for (const t of Object.values(tickets)) {
      if (!t || t.status !== "open" || t.assignee !== myUid || !t.anchorChatId)
        continue;
      // encodeKey is mirrored here so we don't import it just for this loop.
      out.add(String(t.anchorChatId).replace(/[.#$\[\]\/]/g, "_"));
    }
    return out;
  }, [tickets, myUid]);

  const enriched = useMemo(
    () =>
      chatRows
        // Hide chats whose phone is mapped to a teammate's WhatsApp number.
        // Those conversations belong in the Team tab as internal DMs, not
        // in the customer inbox.
        .filter((r) => !teamPhones.has(r.phone.replace(/\D/g, "")) || isCustomerTeamPhoneException(r.phone))
        .map((r) => ({
          row: r,
          name: resolveDisplayName(
            r.phone,
            r.explicitName,
            { chatType: r.chatType, groupName: r.groupName },
            {
              habitUsers,
              cancelledUsers,
              ferraIndex,
              contacts,
              customerDetails: sharedCustomerDetails,
              subsByPhone,
            },
          ),
        })),
    [
      chatRows,
      habitUsers,
      cancelledUsers,
      ferraIndex,
      contacts,
      sharedCustomerDetails,
      subsByPhone,
      teamPhones,
    ],
  );

  // v1.196: limited-trainer visibility filter. A chat is visible iff
  // (manual grant in last 14 days) OR (open ticket assigned to me on
  // that chat). Computed once per render and applied alongside the
  // other filters below. Returns null when the user isn't limited, so
  // the rest of the pipeline can skip the check entirely.
  const visibleChatKeysForLimited = useMemo<Set<string> | null>(() => {
    if (!isLimited) return null;
    const visible = new Set<string>();
    const now = Date.now();
    const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
    for (const [chatKey, grant] of Object.entries(myGrants || {})) {
      if (grant?.grantedAt && now - grant.grantedAt < FOURTEEN_DAYS) {
        visible.add(chatKey);
      }
    }
    // Tickets assigned to me unlock the chat for the ticket's lifetime —
    // myTicketChatKeys already does the filter (open + assignee=me).
    for (const ck of myTicketChatKeys) visible.add(ck);
    return visible;
  }, [isLimited, myGrants, myTicketChatKeys]);

  // v1.223: team-tag visibility. Returns the set of chat keys a
  // team-tagged trainer is allowed to see — customers whose Ferra tag
  // belongs to one of their teams, plus any chat with an open ticket
  // assigned to them (same override as limited). Returns null when the
  // user has no team narrowing (full visibility), letting the consumer
  // skip the filter cheaply. Only meaningful when the user isn't
  // limited — limited is the more restrictive concept and wins.
  const visibleChatKeysForTeams = useMemo<Set<string> | null>(() => {
    if (isLimited) return null; // limited filter handles this case
    if (!myTeamTags) return null;
    const teams = myTeamTags;
    const visible = new Set<string>();
    for (const r of enriched) {
      const tag = sharedSubsByPhone?.[normalizeFerraPhone(r.row.phone)];
      if (!tag) continue;
      const teamsForTag = FERRA_TAG_TEAMS[tag] || [];
      for (const t of teamsForTag) {
        if (teams.has(t)) { visible.add(r.row.chatKey); break; }
      }
    }
    // Ticket override — same as limited.
    for (const ck of myTicketChatKeys) visible.add(ck);
    return visible;
  }, [isLimited, myTeamTags, enriched, sharedSubsByPhone, myTicketChatKeys]);

  const filtered = useMemo(() => {
    let rows = enriched;
    if (!isAdmin) rows = rows.filter((r) => !r.row.private);
    if (visibleChatKeysForLimited) {
      const set = visibleChatKeysForLimited;
      rows = rows.filter((r) => set.has(r.row.chatKey));
    } else if (visibleChatKeysForTeams) {
      // v1.223: team-tag narrowing. Only applies for non-limited
      // trainers (limited is more restrictive and short-circuits above).
      const set = visibleChatKeysForTeams;
      rows = rows.filter((r) => set.has(r.row.chatKey));
    }

    // Daily-workout cohort groups: the dedicated tab shows them all; the
    // everyday inbox (v1.292) shows them too BUT only once they have a text
    // message (a typed question), rendered text-only. Image-only groups
    // stay out of the main list.
    if (statusFilter === DAILY_SENTINEL) {
      rows = rows.filter((r) => isDailyGroup(r.row));
    } else {
      rows = rows.filter(
        (r) => !isDailyGroup(r.row) || (r.row.lastTextMsgAt || 0) > 0,
      );
      if (statusFilter) {
        rows = rows.filter(
          (r) =>
            ferraIndex.phoneToStatus[normalizeFerraPhone(r.row.phone)] ===
            statusFilter,
        );
      }
      if (stageFilter) {
        rows = rows.filter((r) => {
          const tag = sharedSubsByPhone?.[normalizeFerraPhone(r.row.phone)];
          return !!tag && FERRA_TAG_STAGE[tag] === stageFilter;
        });
      }
    }

    const q = search.trim().toLowerCase();
    if (q) {
      const qDigits = q.replace(/\D/g, "");
      rows = rows.filter((r) => {
        if (r.name.toLowerCase().includes(q)) return true;
        if (qDigits && r.row.phone.includes(qDigits)) return true;
        return false;
      });
    }
    // v1.291: Daily Groups tab Text-only mode → sort by latest TEXT.
    // v1.292: everyday inbox → sort by activity time (daily groups use
    // their latest TEXT, normal chats their latest message) so a group's
    // photo flood doesn't bump it; only a typed message moves it up.
    if (textOnlyMode) {
      rows = [...rows].sort(
        (a, b) => (b.row.lastTextMsgAt || 0) - (a.row.lastTextMsgAt || 0),
      );
    } else if (statusFilter !== DAILY_SENTINEL) {
      const activityAt = (x: (typeof rows)[number]) =>
        isDailyGroup(x.row) ? x.row.lastTextMsgAt || 0 : x.row.lastMsgAt || 0;
      rows = [...rows].sort((a, b) => activityAt(b) - activityAt(a));
    }
    // v1.330: with the Wati toggle on, surface Wati conversations at the top
    // ordered by Wati recency. Stable sort → chats with no Wati activity keep
    // their Periskope-activity order beneath the Wati ones.
    if (watiMode) {
      rows = [...rows].sort(
        (a, b) =>
          (watiActivityFor(b.row.phone)?.lastMsgAt || 0) -
          (watiActivityFor(a.row.phone)?.lastMsgAt || 0),
      );
    }
    return rows;
  }, [
    enriched,
    isAdmin,
    statusFilter,
    stageFilter,
    search,
    ferraIndex,
    sharedSubsByPhone,
    visibleChatKeysForLimited,
    visibleChatKeysForTeams,
    textOnlyMode,
    watiMode,
    watiActivityFor,
  ]);

  // Partition: chats with my open ticket anchor the very top, then
  // favorites (without my ticket), then everything else. Tickets are
  // usually more urgent than favorites, so they always sort above them.
  // Within each bucket we keep the existing lastMsgAt sort.
  type ListItem =
    | { kind: "row"; key: string; item: (typeof enriched)[number] }
    | { kind: "divider"; key: string }
    | { kind: "cgroup"; key: string; cg: CgroupRow };

  // v1.353: subId(digits) -> journey-stage bucket, for the CGroups stage pill.
  const cgStageBySubId = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    subsByPhone.forEach((list) => {
      for (const s of list) {
        const d = String(s.customerId || "").replace(/\D/g, "");
        if (!d || m[d]) continue;
        const ph = s.customerPhone ? normalizeFerraPhone(s.customerPhone) : "";
        const tag = (ph && sharedSubsByPhone?.[ph]) || s.status || "";
        const stage = tag ? FERRA_TAG_STAGE[tag] : "";
        if (stage) m[d] = stage;
      }
    });
    return m;
  }, [subsByPhone, sharedSubsByPhone]);

  // CGroups journey-stage pill (bucket-level, matches Trainer 1; hides "active").
  const renderCgStagePill = (stage: string | null) => {
    if (!stage || stage === "active") return null;
    const map: Record<string, { pill: any; txt: any }> = {
      setup: { pill: styles.cgStageSetup, txt: styles.cgStageSetupTxt },
      onboarding: { pill: styles.cgStageOnboarding, txt: styles.cgStageOnboardingTxt },
      sa: { pill: styles.cgStageSa, txt: styles.cgStageSaTxt },
      offboarding: { pill: styles.cgStageOffboarding, txt: styles.cgStageOffboardingTxt },
    };
    const c = map[stage];
    if (!c) return null;
    const label = stage[0].toUpperCase() + stage.slice(1);
    return (
      <View style={[styles.cgStagePill, c.pill]}>
        <Text style={[styles.cgStagePillTxt, c.txt]}>{label}</Text>
      </View>
    );
  };

  const listData = useMemo<ListItem[]>(() => {
    // v1.341: CGroups mode renders the live per-customer-group list (a separate
    // dataset, not the Periskope chat index), filtered by the search box.
    if (cgroupsMode) {
      const all = cgroups || [];
      const q = search.trim().toLowerCase();
      let rows = all;
      if (q) {
        // v1.351 parity: search the group AND its subscription — owner name/
        // phone + every member's name/phone + the subId — so typing a customer
        // or any user (by name or number) surfaces their group, not just a
        // group-name match. Phone search is digit-normalized.
        const qDigits = q.replace(/\D/g, "");
        const subById: Record<string, any> = {};
        subsByPhone.forEach((list) => {
          for (const s of list) {
            const d = String(s.customerId || "").replace(/\D/g, "");
            if (d && !subById[d]) subById[d] = s;
          }
        });
        const haystack = (g: CgroupRow) => {
          const parts: (string | undefined)[] = [
            g.customerName,
            g.subId,
            g.lastMessage?.body,
          ];
          const sub = subById[String(g.subId || "").replace(/\D/g, "")];
          if (sub) {
            parts.push(sub.customerName, sub.customerPhone);
            if (Array.isArray(sub.memberNames)) parts.push(...sub.memberNames);
            if (Array.isArray(sub.memberPhones)) parts.push(...sub.memberPhones);
          }
          return parts.filter(Boolean).join(" ").toLowerCase();
        };
        rows = all.filter((g) => {
          const text = haystack(g);
          if (text.includes(q)) return true;
          return qDigits.length >= 3 && text.replace(/\D/g, "").includes(qDigits);
        });
      }
      // v1.352: pin starred groups to the top (mirrors Trainer 1), preserving
      // updatedAt order within each partition.
      const favTop: CgroupRow[] = [];
      const favRest: CgroupRow[] = [];
      for (const g of rows)
        (myFavorites[encodeKey(g.chatId)] ? favTop : favRest).push(g);
      rows = favTop.concat(favRest);
      return rows.map((g) => ({ kind: "cgroup", key: g.chatId, cg: g }));
    }
    // v1.330: Wati mode shows a pure Wati-recency list — no ticket/favorite
    // pinning — so the people we're actively messaging on Wati lead the list.
    if (watiMode) {
      const base = favoritesOnly
        ? filtered.filter((r) => myFavorites[r.row.chatKey])
        : filtered;
      return base.map((r) => {
        const w = watiActivityFor(r.row.phone);
        // v1.335: in Wati mode show the latest WATI message preview + time (not
        // the Periskope/Trainer-1 one) for chats that have Wati activity.
        const row =
          w && w.lastMsgAt
            ? {
                ...r.row,
                preview: w.lastMsgPreview || r.row.preview,
                lastMsgAt: w.lastMsgAt,
                direction:
                  w.lastMsgDirection === "out"
                    ? ("out" as const)
                    : w.lastMsgDirection === "in"
                      ? ("in" as const)
                      : r.row.direction,
                sentByName: w.lastMsgDirection === "out" ? "You" : null,
                lastMsgStatus: undefined,
              }
            : r.row;
        return { kind: "row", key: r.row.chatKey, item: { ...r, row } };
      });
    }
    const tickets: typeof filtered = [];
    const favorites: typeof filtered = [];
    const rest: typeof filtered = [];
    for (const r of filtered) {
      if (myTicketChatKeys.has(r.row.chatKey)) tickets.push(r);
      else if (myFavorites[r.row.chatKey]) favorites.push(r);
      else rest.push(r);
    }
    if (favoritesOnly) {
      return favorites.map((r) => ({
        kind: "row",
        key: r.row.chatKey,
        item: r,
      }));
    }
    const pinned = tickets.concat(favorites);
    const items: ListItem[] = pinned.map((r) => ({
      kind: "row",
      key: r.row.chatKey,
      item: r,
    }));
    if (pinned.length > 0 && rest.length > 0) {
      items.push({ kind: "divider", key: "__divider__" });
    }
    for (const r of rest) {
      items.push({ kind: "row", key: r.row.chatKey, item: r });
    }
    return items;
  }, [filtered, myFavorites, myTicketChatKeys, favoritesOnly, watiMode, watiActivityFor, cgroupsMode, cgroups, search, subsByPhone]);

  // v1.163: edges={[]} — was edges={["top"]} which double-counted the
  // status-bar inset on Android. The React Navigation Stack header
  // above this screen already consumes the top inset, so adding it
  // again here painted a gray strip between the header and the search
  // input. iOS hid the strip because its inset is 0 below the header.
  return (
    <SafeAreaView style={styles.root} edges={[]}>
      <FilterBar
        rows={chatRows}
        phoneToStatus={ferraIndex.phoneToStatus}
        statusFilter={statusFilter}
        stageFilter={stageFilter}
        search={search}
        favoritesOnly={favoritesOnly}
        onChangeStatus={setStatusFilter}
        onChangeStage={setStageFilter}
        onChangeSearch={setSearch}
        onChangeFavoritesOnly={setFavoritesOnly}
        channel={chatListChannel}
        showChannelToggle={channelAccess.wati}
        showCgroups={!isLimited}
        onChangeChannel={setChatListChannel}
      />
      {hasGroqKey === false && (
        <View style={styles.noKeyBanner}>
          <Text style={styles.noKeyBannerTxt}>
            ⚠️ Voice notes are slow — talk to admin for fast transcription
          </Text>
        </View>
      )}
      {/* v1.196: limited-trainer add-customer entry point. Sits at the
          top of the chat list as a tappable row. Tapping opens the
          AddCustomerModal where the trainer types a phone number and
          unlocks that customer for 14 days. */}
      {isLimited && (
        <TouchableOpacity
          style={styles.addCustomerRow}
          onPress={() => setAddCustomerOpen(true)}
          accessibilityLabel="Add customer by phone number"
        >
          <Text style={styles.addCustomerTxt}>＋  Add customer</Text>
        </TouchableOpacity>
      )}
      {/* v1.291: Text-only toggle — only in the Daily Groups view. */}
      {dailyView && !cgroupsMode && (
        <TouchableOpacity
          style={styles.textOnlyBar}
          activeOpacity={0.7}
          onPress={() => setDailyTextOnly(!dailyTextOnly)}
        >
          <Text style={styles.textOnlyChk}>{dailyTextOnly ? "☑" : "☐"}</Text>
          <Text style={styles.textOnlyTxt}>
            💬 Text only — hide workout photos, sort by latest message
          </Text>
        </TouchableOpacity>
      )}
      <FlatList
        data={listData}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => {
          if (item.kind === "divider") {
            return (
              <View style={styles.divider}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerTxt}>More chats</Text>
                <View style={styles.dividerLine} />
              </View>
            );
          }
          // v1.341: CGroups row — a per-customer WhatsApp group. Tapping opens
          // the group thread (chatId keyed the same way as any other chat).
          if (item.kind === "cgroup") {
            const g = item.cg;
            const chatKey = encodeKey(g.chatId);
            const favored = !!myFavorites[chatKey];
            const cgStage =
              cgStageBySubId[String(g.subId || "").replace(/\D/g, "")] || null;
            const cleanName = g.customerName
              .replace(/^(mr|mrs|ms|dr|prof)\.?\s*/i, "")
              .trim();
            // v1.355: claim/ticket status-light avatar (parity with web).
            const cgClaim = claims[chatKey];
            const cgClaimed = !!cgClaim?.uid;
            const cgHasTicket = Object.values(tickets).some(
              (t) =>
                t &&
                t.status === "open" &&
                String(t.anchorChatId || "").replace(/[.#$\[\]\/]/g, "_") ===
                  chatKey,
            );
            const cgSplit = cgClaimed && cgHasTicket;
            const cgAvatarBg = cgHasTicket
              ? colors.red
              : cgClaimed
                ? CLAIM_BLUE
                : colors.green;
            const initial = cgClaimed ? claimInitials(cgClaim?.name || "") : "";
            const preview = (g.lastMessage?.body || "").replace(/\s+/g, " ").trim();
            const when = g.updatedAt ? new Date(g.updatedAt).getTime() : undefined;
            return (
              <TouchableOpacity
                style={styles.cgRow}
                activeOpacity={0.7}
                onPress={() =>
                  navigation.navigate("Thread", {
                    chatKey,
                    initialTitle: g.groupName,
                  })
                }
              >
                <View style={[styles.cgAvatar, { backgroundColor: cgAvatarBg }]}>
                  {cgSplit && <View style={styles.cgAvatarSplitLeft} />}
                  <Text style={styles.cgAvatarTxt}>{initial}</Text>
                </View>
                <View style={styles.cgBody}>
                  <View style={styles.cgTopRow}>
                    <View style={styles.cgNameWrap}>
                      <Text style={styles.cgSubId}>{g.subId}</Text>
                      <Text style={styles.cgName} numberOfLines={1}>
                        {cleanName}
                      </Text>
                    </View>
                    {when ? (
                      <Text style={styles.cgTime}>{formatTime(when)}</Text>
                    ) : null}
                  </View>
                  <Text style={styles.cgPreview} numberOfLines={1}>
                    {g.lastMessage?.fromMe ? "You: " : ""}
                    {preview}
                  </Text>
                  {renderCgStagePill(cgStage)}
                </View>
                <TouchableOpacity
                  onPress={() => toggleFavorite(chatKey)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  style={styles.cgStar}
                >
                  <Text style={[styles.cgStarTxt, favored && styles.cgStarOn]}>
                    {favored ? "★" : "☆"}
                  </Text>
                </TouchableOpacity>
              </TouchableOpacity>
            );
          }
          const enrichedRow = item.item;
          const r = enrichedRow.row;
          const tag = sharedSubsByPhone?.[normalizeFerraPhone(r.phone)];
          const stage = tag ? FERRA_TAG_STAGE[tag] ?? null : null;
          const status =
            ferraIndex.phoneToStatus[normalizeFerraPhone(r.phone)] ?? null;
          // v1.274: "no group" pill — ACTIVE Ferra customer with no
          // daily-cohort membership yet. Only meaningful once the
          // cohort registry has loaded; before that, show nothing
          // rather than flashing the pill on everyone.
          const noCohort =
            cohortsLoaded &&
            r.chatType !== "group" &&
            status === "ACTIVE" &&
            !cohortAssignedKeys.has(cohortPhoneKey(r.phone));
          const openTickets = Object.values(tickets).filter(
            (t) =>
              t &&
              t.status === "open" &&
              String(t.anchorChatId || "").replace(/[.#$\[\]\/]/g, "_") ===
                r.chatKey,
          );
          const hasOpenTicket = openTickets.length > 0;
          const myTicket = myTicketChatKeys.has(r.chatKey);
          const lastSeen = myLastSeen[r.chatKey] || 0;
          const unread = r.lastMsgAt > lastSeen && r.direction === "in";
          const isFavorite = !!myFavorites[r.chatKey];
          const suggestPin = shouldSuggestPin(
            r.chatKey,
            myFavorites,
            mySendActivity,
          );
          // v1.292: a daily group renders text-only ALWAYS in the everyday
          // inbox, and per the toggle in the Daily Groups tab.
          const rowIsDaily = isDailyGroup(r);
          const rowTextOnly = rowIsDaily
            ? dailyView
              ? dailyTextOnly
              : true
            : false;
          // v1.293: tag the everyday-inbox copy of a daily group with
          // "(no image)" so it reads as the text-only view, distinct from
          // the full group in the Daily Groups tab. Display-only.
          const rowName =
            rowIsDaily && !dailyView
              ? `${enrichedRow.name} (no image)`
              : enrichedRow.name;

          return (
            <ChatRowItem
              row={r}
              name={rowName}
              subscriptionStatus={status}
              stage={stage}
              hasOpenTicket={hasOpenTicket}
              myTicket={myTicket}
              claim={claims[r.chatKey] || null}
              unread={unread}
              isFavorite={isFavorite}
              suggestPin={suggestPin}
              noCohort={noCohort}
              textOnly={rowTextOnly}
              onPress={() =>
                navigation.navigate("Thread", {
                  chatKey: r.chatKey,
                  initialTitle: enrichedRow.name,
                  // v1.292: a daily group opened from the everyday inbox
                  // (not the Daily Groups tab) shows a text-only thread.
                  textOnly: rowIsDaily && !dailyView ? true : undefined,
                  // v1.336: open on the same channel tab the list is showing.
                  initialChannel: watiMode ? "wati" : "periskope",
                })
              }
              onToggleFavorite={() => toggleFavorite(r.chatKey)}
            />
          );
        }}
        ListHeaderComponent={
          cgroupsMode && (cgroups?.length ?? 0) > 0 ? (
            <TouchableOpacity
              style={styles.cgHeader}
              activeOpacity={0.7}
              onPress={() => loadCgroups(true)}
            >
              <Text style={styles.cgHeaderTxt}>
                {cgroups?.length ?? 0} customer group
                {(cgroups?.length ?? 0) === 1 ? "" : "s"} on +91 91876 51332 · ↻ refresh
              </Text>
            </TouchableOpacity>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTxt}>
              {cgroupsMode
                ? cgroupsLoading
                  ? "Loading CGroups…"
                  : search.trim()
                  ? "No CGroups match your search."
                  : "No customer groups yet."
                : !dataReady
                ? "Loading chats…"
                : favoritesOnly
                ? "No favorites yet."
                : searchPhoneNormalized
                ? "No existing chat for this number."
                : isLimited
                ? "Your chat list is empty. Tap + Add customer above to unlock a customer's chat, or wait for a teammate to assign you a ticket."
                : "No chats match."}
            </Text>
            {/* v1.199: when the search input looks like a phone and no
                existing chat matches, offer a one-tap "start new chat"
                affordance. Saves having a separate "+" button on the
                main UI (which the desktop has but the mobile app didn't). */}
            {!cgroupsMode && searchPhoneNormalized && dataReady && (
              <TouchableOpacity
                style={styles.startChatBtn}
                onPress={startChatWithPhone}
              >
                <Text style={styles.startChatTxt}>
                  ＋  Start a new chat with +{searchPhoneNormalized}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        }
        ListFooterComponent={
          <View style={styles.versionFooter}>
            <Text style={styles.versionTxt}>{getDisplayVersion()}</Text>
          </View>
        }
      />
      <AddCustomerModal
        visible={addCustomerOpen}
        onCancel={() => setAddCustomerOpen(false)}
        onAdd={async (chatKey) => {
          await grantChatAccess(chatKey);
          // Tell the trainer what happened. If no /chats record exists yet
          // for that key (customer never messaged the org's WhatsApp),
          // the chat row won't appear until messages start landing.
          const hasChat = chatRows.some((r) => r.chatKey === chatKey);
          if (!hasChat) {
            Alert.alert(
              "Added",
              "No existing chat history for that number yet. The chat will appear in your list as soon as a message arrives.",
            );
          }
        }}
      />
    </SafeAreaView>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    empty: { padding: 60, alignItems: "center" },
    emptyTxt: { color: colors.muted, fontSize: 14 },
    versionFooter: { paddingVertical: 16, alignItems: "center" },
    versionTxt: { color: colors.muted, fontSize: 10 },
    // v1.146: amber strip shown when getGroqKey() returns empty. Calm
    // enough to live persistently at the top of the chat list without
    // becoming visual noise, loud enough that the user notices voice
    // notes will be slow until they sort the key out.
    noKeyBanner: {
      backgroundColor: "#fff3cd",
      borderLeftWidth: 3,
      borderLeftColor: "#e0a500",
      paddingHorizontal: space.md,
      paddingVertical: 8,
    },
    // v1.196: limited-trainer add-customer entry row. Sits between the
    // filter bar and the chat list. Tap → AddCustomerModal opens.
    addCustomerRow: {
      paddingHorizontal: space.md,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.panel,
    },
    addCustomerTxt: {
      color: colors.green,
      fontSize: 14,
      fontWeight: "600",
    },
    // v1.291: daily-workout Text-only toggle bar.
    textOnlyBar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: space.md,
      paddingVertical: 10,
      backgroundColor: colors.panel,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    textOnlyChk: { fontSize: 16, color: colors.green },
    textOnlyTxt: { flex: 1, fontSize: 12.5, color: colors.text },
    // v1.199: "Start a new chat" button shown in the empty state when the
    // search input parses as a phone number. Replaces the missing-from-
    // mobile "+ new chat" affordance the desktop has in its rail.
    startChatBtn: {
      marginTop: 16,
      paddingHorizontal: 18,
      paddingVertical: 12,
      backgroundColor: colors.green,
      borderRadius: 10,
    },
    startChatTxt: {
      color: "white",
      fontSize: 14,
      fontWeight: "600",
    },
    noKeyBannerTxt: {
      color: "#5c4400",
      fontSize: 12,
      fontWeight: "500",
    },
    // v1.166: divider was blending into the chat-list background
    // because the line was 1px in the same gray as the borders below.
    // Bumped the line to 2px, switched both the line and the label to
    // the brand accent (colors.green — emerald in light, blue in dark)
    // so it reads clearly as "section break here, more chats below."
    // v1.172: strip background now matches the chat-row panel color
    // so the strip itself disappears — only the green line + label
    // show, against a continuous chat-list surface. Line bumped 2 → 3px
    // for a bit more weight.
    divider: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: space.md,
      paddingVertical: 8,
      backgroundColor: colors.panel,
      gap: space.sm,
    },
    dividerLine: {
      flex: 1,
      height: 3,
      backgroundColor: colors.green,
      opacity: 0.55,
      borderRadius: 1.5,
    },
    dividerTxt: {
      fontSize: 11,
      color: colors.green,
      fontWeight: "600",
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    // v1.341: CGroups list rows + header.
    cgHeader: {
      paddingHorizontal: space.md,
      paddingVertical: 8,
      backgroundColor: colors.panel,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    cgHeaderTxt: { fontSize: 11.5, color: colors.muted, textAlign: "center" },
    cgRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: space.md,
      paddingVertical: 10,
      backgroundColor: colors.panel,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: 12,
    },
    cgAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.green,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden", // clips the half-blue claim overlay to the circle
    },
    // v1.355: left half painted blue over the red base = claimed + open ticket.
    cgAvatarSplitLeft: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: 22,
      backgroundColor: CLAIM_BLUE,
    },
    cgAvatarTxt: { color: "white", fontSize: 18, fontWeight: "700" },
    cgBody: { flex: 1, minWidth: 0 },
    cgTopRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cgNameWrap: {
      flexDirection: "row",
      alignItems: "center",
      flex: 1,
      minWidth: 0,
      gap: 6,
    },
    cgSubId: {
      backgroundColor: colors.green,
      color: "white",
      fontSize: 10.5,
      fontWeight: "700",
      paddingHorizontal: 5,
      paddingVertical: 2,
      borderRadius: 5,
      overflow: "hidden",
    },
    cgName: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.text },
    cgTime: { fontSize: 11, color: colors.muted, marginLeft: 6 },
    cgPreview: { fontSize: 13, color: colors.muted, marginTop: 2 },
    cgStar: { paddingHorizontal: 4, paddingVertical: 4 },
    cgStarTxt: { fontSize: 20, color: colors.muted },
    cgStarOn: { color: "#f5b400" },
    cgStagePill: {
      alignSelf: "flex-start",
      marginTop: 4,
      paddingHorizontal: 7,
      paddingVertical: 2,
      borderRadius: 6,
    },
    cgStagePillTxt: { fontSize: 10.5, fontWeight: "700" },
    cgStageSetup: { backgroundColor: colors.pillStageSetupBg },
    cgStageSetupTxt: { color: colors.pillStageSetupFg },
    cgStageOnboarding: { backgroundColor: colors.pillStageOnboardingBg },
    cgStageOnboardingTxt: { color: colors.pillStageOnboardingFg },
    cgStageSa: { backgroundColor: colors.pillStageSaBg },
    cgStageSaTxt: { color: colors.pillStageSaFg },
    cgStageOffboarding: { backgroundColor: colors.pillStageOffboardingBg },
    cgStageOffboardingTxt: { color: colors.pillStageOffboardingFg },
  });
}
