// Message thread + composer. Long-press a bubble to open the action sheet
// (Create ticket / Copy). 📎 picks a file → sends through the Worker as
// base64 media. ✨ in the header opens the AI summary modal.

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
// expo-file-system 18+ split into "new" and "legacy" APIs. We still use the
// legacy patterns (getInfoAsync with size, readAsStringAsync with base64),
// so import from the legacy path to keep the existing call sites working.
import * as FileSystem from "expo-file-system/legacy";
import {
  limitToLast,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  set,
  update,
} from "firebase/database";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { db } from "@/firebase";
import { ROOT, MAX_MEDIA_BYTES } from "@/config";
import { colors, space } from "@/theme";
import {
  useAppData,
  openTicketsForChat,
  isDmKey,
  pairKeyFromChatKey,
} from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { dayLabel } from "@/lib/format";
import { chatKeyToChatId } from "@/lib/encodeKey";
import { fetchChatInfo, sendMessage, notifyDm, transcribeAudio } from "@/lib/worker";
import { dedupMessages } from "@/lib/messageDedup";
import {
  filterTemplates,
  substituteTemplateVars,
} from "@/lib/templates";
import { MessageBubble } from "@/components/MessageBubble";
import { TicketBanner } from "@/components/TicketBanner";
import { CreateTicketModal } from "@/components/CreateTicketModal";
import { ReassignModal } from "@/components/ReassignModal";
import { SummaryModal } from "@/components/SummaryModal";
import { ActivityIndicator } from "react-native";
import type { Message, Ticket } from "@/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";

// Lazy require for expo-audio so older native builds (pre v1.115) don't
// crash on import. Mic button is conditionally rendered only when this
// resolves — hooks inside MicButton always run unconditionally, so
// rules-of-hooks stays clean.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let audioMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  audioMod = require("expo-audio");
} catch {
  audioMod = null;
}

type Props = NativeStackScreenProps<RootStackParamList, "Thread">;

export function ThreadScreen({ route, navigation }: Props) {
  const { chatKey, initialTitle } = route.params;
  const { user } = useAuth();
  // Bottom inset = the home indicator / gesture-nav pill on iPhones with
  // notches and Androids with the bottom swipe-up bar. Without this padding
  // the composer's mic/send buttons sit flush against the phone's bottom
  // edge and get clipped by the gesture area.
  const insets = useSafeAreaInsets();
  const {
    chatMetaByKey,
    tickets,
    teamUsers,
    teamMembers,
    dmRows,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
    markChatSeen,
    bumpSendActivity,
    templates,
  } = useAppData();

  // DM mode: the chatKey is "dm:" + pairKey, not a customer chatKey. Branch
  // here so the rest of the component can stay shape-compatible — chatId
  // and phone are unused on the DM path.
  const isDm = isDmKey(chatKey);
  const pairKey = isDm ? pairKeyFromChatKey(chatKey)! : "";
  const dmRow = isDm ? dmRows.find((r) => r.pairKey === pairKey) : undefined;
  const otherUid =
    isDm && user
      ? pairKey.split("_").find((u) => u !== user.uid) || ""
      : "";

  const meta = chatMetaByKey[chatKey] ?? {};
  const isGroup =
    !isDm &&
    (meta.chatType === "group" ||
      String(meta.chatId || "").endsWith("@g.us"));
  const chatId = isDm ? "" : meta.chatId || chatKeyToChatId(chatKey);
  const phone = isDm ? "" : meta.phone || chatId.split("@")[0];

  const headerName = useMemo(() => {
    if (initialTitle) return initialTitle;
    if (isDm) return dmRow?.name || "Teammate";
    return resolveDisplayName(
      meta.phone || phone,
      meta.contactName || meta.displayName,
      {
        chatType: isGroup ? "group" : "user",
        groupName: meta.groupName,
      },
      { habitUsers, cancelledUsers, ferraIndex, contacts },
    );
  }, [
    initialTitle,
    isDm,
    dmRow,
    meta,
    phone,
    isGroup,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
  ]);

  const [messages, setMessages] = useState<Message[]>([]);
  const [composer, setComposer] = useState("");
  // v1.130: structured mentions parallel to the composer text. When the
  // user picks "@Ashima" from the autocomplete, we add Ashima's uid here
  // so the worker can ping her even if she isn't on the ticket. Kept as
  // a Map so the same uid can't be added twice but order is preserved.
  const [mentions, setMentions] = useState<Map<string, { name: string }>>(
    new Map(),
  );
  // Slash-command template picker (v1.126). When the composer starts with
  // "/", we show a floating list above the composer. Same UX as the
  // desktop's openTplPicker, scoped to first-character "/" rather than
  // mid-text so it doesn't fight with regular typing.
  const slashQuery: string | null = useMemo(() => {
    if (!composer.startsWith("/")) return null;
    // DMs and groups should still allow templates — useful for canned
    // "I'm offline" or "Acknowledged" replies — so we don't gate by isDm.
    return composer.slice(1).toLowerCase().trim();
  }, [composer]);
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : filterTemplates(templates, slashQuery)),
    [slashQuery, templates],
  );

  // v1.130: @-mention picker. We look for the LAST `@` in the composer
  // that's at the start or right after whitespace, with only word chars
  // following. That match defines both the trigger and what to filter by.
  // If the picker is hidden (no @ being typed) mentionMatch is null.
  const mentionMatch = useMemo(() => {
    // Skip when slash picker is showing — they'd visually overlap, and
    // a slash command takes priority over any embedded @ inside it.
    if (composer.startsWith("/")) return null;
    const re = /(^|\s)@([\w.-]*)$/;
    const m = composer.match(re);
    if (!m) return null;
    const queryStart = composer.length - m[2].length;
    return {
      query: m[2].toLowerCase(),
      // Index of the "@" character — used to splice in the picked name.
      atIndex: queryStart - 1,
    };
  }, [composer]);

  // Candidate teammates: union of teamUsers (signed in) and teamMembers
  // config (allow-listed but maybe never signed in). Filter out yourself
  // and apply the query filter. Sort: signed-in first (so they're the
  // top hits), then alphabetical.
  const mentionCandidates = useMemo(() => {
    if (!mentionMatch) return [] as Array<{ uid: string; name: string; active: boolean }>;
    const me = user?.uid;
    const byUid = new Map<
      string,
      { uid: string; name: string; active: boolean }
    >();
    for (const [uid, u] of Object.entries(teamUsers || {})) {
      if (!u || uid === me) continue;
      byUid.set(uid, {
        uid,
        name: u.name || u.email || uid,
        active: true,
      });
    }
    // teamMembers is keyed by emailKey; we'd love to know the matching uid
    // but config/teamMembers doesn't store one. For users who never signed
    // in we synthesize a "pending" entry — we can't push them anyway (no
    // token), so this is just for display continuity.
    for (const [emailKey, m] of Object.entries(teamMembers || {})) {
      const email = m?.email;
      if (!email) continue;
      // Skip if already covered by teamUsers (same email landing under a
      // uid). Emails are unique per allow-list entry.
      const emailLower = email.toLowerCase();
      const dup = Array.from(byUid.values()).some(
        (entry) =>
          (teamUsers[entry.uid]?.email || "").toLowerCase() === emailLower,
      );
      if (dup) continue;
      byUid.set(`pending:${emailKey}`, {
        uid: `pending:${emailKey}`,
        name: m?.name || email,
        active: false,
      });
    }
    const all = Array.from(byUid.values());
    const q = mentionMatch.query;
    const filtered = q
      ? all.filter((x) => x.name.toLowerCase().includes(q))
      : all;
    filtered.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return filtered;
  }, [mentionMatch, teamUsers, teamMembers, user]);
  // sheetMsg removed in v1.118 — long-press now copies directly and single
  // tap opens the ticket-create modal, so the bottom action sheet became
  // dead UI. Kept the ActionSheet component definition in this file for
  // possible future use.
  const [ticketCreateFor, setTicketCreateFor] = useState<Message | null>(null);
  const [reassignTicket, setReassignTicket] = useState<Ticket | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  // Voice-note flow state. When transcribing is true, the mic button shows
  // a spinner. When notePreview is non-null, an editable preview modal is
  // open with the transcript pre-filled — trainer reviews then saves.
  const [transcribing, setTranscribing] = useState(false);
  const [notePreview, setNotePreview] = useState<string | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  // Android edge-to-edge keyboard fix (v1.127). KeyboardAvoidingView's
  // "height" / "padding" behaviors are unreliable on SDK 55 Android because
  // edge-to-edge means the window keeps its full size when the keyboard
  // opens; the bottom of the composer ends up UNDER the keyboard. The
  // earlier v1.124 attempt (behavior="height") didn't actually move the
  // composer on real devices — see the Pavitra Shetty thread screenshot.
  //
  // Fix: subscribe to native keyboard events, measure the actual keyboard
  // pixel height, and pad the KAV root by that much. Drives the layout to
  // shrink so the flex-end composer sits exactly above the keyboard. iOS
  // keeps its KeyboardAvoidingView path because "padding" works there.
  const [androidKbHeight, setAndroidKbHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    // Android only emits *Did* events. *Will* events are iOS-only — they
    // would let us animate in sync with the keyboard but we don't have
    // access to them here. The visible reflow is fast enough that the
    // ~50ms delay between keyboardDidShow and our re-render isn't noticed.
    const show = Keyboard.addListener("keyboardDidShow", (e) => {
      setAndroidKbHeight(e.endCoordinates?.height ?? 0);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setAndroidKbHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // v1.129: mobile-side template creation. Opens a small modal where the
  // trainer can save a new template without going back to the desktop.
  // newTemplateModal is null when closed; an object holds the form state.
  const [newTemplateModal, setNewTemplateModal] = useState<
    { name: string; text: string; saving: boolean } | null
  >(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerTitle: headerName,
      // DM threads skip all customer-only header tools (no person to look up,
      // no chat to summarize). For customer chats: 👤 opens Customer Info
      // (hidden for groups since there's no single customer), ✨ opens the
      // AI summary modal.
      headerRight: isDm
        ? undefined
        : () => (
            <View style={styles.headerRightWrap}>
              {!isGroup && (
                <TouchableOpacity
                  accessibilityLabel="Customer details"
                  onPress={() =>
                    navigation.navigate("CustomerInfo", { chatKey })
                  }
                  style={styles.headerBtn}
                >
                  <Text style={styles.headerBtnTxt}>👤</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                accessibilityLabel="Summarize"
                onPress={() => setSummaryOpen(true)}
                style={styles.headerBtn}
              >
                <Text style={styles.headerBtnTxt}>✨</Text>
              </TouchableOpacity>
            </View>
          ),
    });
  }, [navigation, headerName, isDm, chatKey, isGroup]);

  // Live messages listener (last 300). DM messages live at /dms/{pairKey}
  // and use fromUid instead of a direction field — we translate at the
  // boundary so MessageBubble can stay shape-compatible.
  useEffect(() => {
    const path = isDm
      ? `${ROOT}/dms/${pairKey}/messages`
      : `${ROOT}/chats/${chatKey}/messages`;
    const q = query(ref(db, path), orderByChild("ts"), limitToLast(300));
    const unsub = onValue(q, (snap) => {
      const v = snap.val() || {};
      const list: Message[] = Object.entries(
        v as Record<string, Message & { fromUid?: string; fromName?: string }>,
      ).map(([k, m]) => {
        if (isDm) {
          const me = user?.uid;
          return {
            ...m,
            id: k,
            direction: m.fromUid === me ? "out" : "in",
            sentByName: m.fromName || null,
          } as Message;
        }
        return { ...m, id: k } as Message;
      });
      list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      setMessages(list);
      markChatSeen(chatKey);
      // Auto-scroll to bottom after the snapshot lands.
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
      });
    });
    // Fetch group name lazily if missing.
    if (!isDm && isGroup && !meta.groupName) {
      fetchChatInfo(chatId);
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey]);

  // Deduplicate by inner unique id — see lib/messageDedup for the rationale.
  const visible = useMemo(() => dedupMessages(messages), [messages]);

  const banner = useMemo<Ticket[]>(
    () => (isDm ? [] : openTicketsForChat(tickets, chatKey)),
    [isDm, tickets, chatKey],
  );

  // DM send. Writes to /dms/{pairKey}/messages + meta in one shot; fires
  // a worker push afterwards (best-effort). No Periscope, no "sending"
  // status — the write IS the delivery.
  const sendDm = useCallback(async () => {
    const text = composer.trim();
    if (!text || !user || !otherUid) return;
    const ts = Date.now();
    const fromName = user.displayName || user.email || "(team)";
    const msgRef = push(ref(db, `${ROOT}/dms/${pairKey}/messages`));
    await set(msgRef, { text, ts, fromUid: user.uid, fromName });
    await update(ref(db, `${ROOT}/dms/${pairKey}/meta`), {
      participants: { [user.uid]: true, [otherUid]: true },
      lastMsgAt: ts,
      lastMsgPreview: text.slice(0, 120),
      lastMsgFromUid: user.uid,
      lastMsgFromName: fromName,
    });
    setComposer("");
    // Fire-and-forget push fan-out. Don't await — UX shouldn't depend on
    // notification delivery.
    notifyDm({
      pairKey,
      fromUid: user.uid,
      fromName,
      toUid: otherUid,
      text: text.slice(0, 200),
    });
  }, [composer, user, pairKey, otherUid]);

  const send = useCallback(async () => {
    if (isDm) return sendDm();
    const text = composer.trim();
    if (!text || !user) return;
    const ts = Date.now();
    const msgRef = push(ref(db, `${ROOT}/chats/${chatKey}/messages`));
    const localMsgId = msgRef.key as string;
    await set(msgRef, {
      direction: "out",
      text,
      ts,
      sentByUid: user.uid,
      sentByName: user.displayName || user.email,
      status: "sending",
    });
    await update(ref(db, `${ROOT}/chats/${chatKey}/meta`), {
      chatId,
      phone,
      lastMsgAt: ts,
      lastMsgPreview: text.slice(0, 120),
      lastMsgDirection: "out",
      lastMsgSentByName: user.displayName || user.email,
    });
    bumpSendActivity(chatKey);
    // v1.130: snapshot mentions whose names still appear in the outgoing
    // text. If the user @-picked someone then erased the name, we want
    // that uid OUT of the mentions list (don't ping someone whose name
    // was deleted). Compare by name substring — close enough for v1.
    const mentionUids: string[] = [];
    for (const [uid, info] of mentions) {
      if (text.includes(`@${info.name}`)) mentionUids.push(uid);
    }
    setComposer("");
    setMentions(new Map());
    try {
      const res = await sendMessage({
        chatId,
        phone,
        message: text,
        sentByUid: user.uid,
        sentByName: user.displayName || user.email || "",
        localMsgId,
        ...(mentionUids.length > 0 ? { mentions: mentionUids } : {}),
      });
      if (!res.ok) {
        const t = await res.text();
        await update(msgRef, { status: "failed", error: t.slice(0, 300) });
      }
    } catch (e: any) {
      await update(msgRef, { status: "failed", error: String(e) });
    }
  }, [isDm, sendDm, composer, user, chatKey, chatId, phone, mentions]);

  // Voice note flow — called by MicButton after recording stops with the
  // captured audio file URI. Uploads to /transcribe, opens the preview
  // modal with the cleaned text. Trainer can edit before saving.
  const onTranscribed = useCallback(
    async (uri: string) => {
      setTranscribing(true);
      try {
        const b64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const text = await transcribeAudio(b64);
        if (!text) {
          Alert.alert("No speech detected", "Try recording again, closer to the mic.");
          return;
        }
        setNotePreview(text);
      } catch (e) {
        Alert.alert(
          "Transcription failed",
          String((e as Error)?.message || e),
        );
      } finally {
        setTranscribing(false);
      }
    },
    [],
  );

  async function saveVoiceNote(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !user) return;
    setSavingNote(true);
    try {
      const noteRef = push(ref(db, `${ROOT}/chats/${chatKey}/notes`));
      await set(noteRef, {
        text: trimmed,
        authorUid: user.uid,
        authorName: user.displayName || user.email || "(me)",
        createdAt: Date.now(),
        source: "mobile-voice",
      });
      setNotePreview(null);
    } catch (e) {
      Alert.alert("Couldn't save note", String((e as Error)?.message || e));
    } finally {
      setSavingNote(false);
    }
  }

  // v1.129: save a new template to commonComm/config/templates. The listener
  // in AppDataContext picks it up immediately, so the picker refreshes and
  // we can close the modal right after the write.
  const saveNewTemplate = useCallback(async () => {
    if (!newTemplateModal || !user) return;
    const name = newTemplateModal.name.trim().replace(/^\/+/, "");
    const text = newTemplateModal.text.trim();
    if (!name) {
      Alert.alert("Need a keyword", "Give the template a short slash name, e.g. 'welcome'.");
      return;
    }
    if (!text) {
      Alert.alert("Need template text", "Type the message body that should be inserted.");
      return;
    }
    setNewTemplateModal({ ...newTemplateModal, saving: true });
    try {
      const tplRef = push(ref(db, `${ROOT}/config/templates`));
      await set(tplRef, {
        name,
        text,
        createdBy: user.uid,
        createdByName: user.displayName || user.email || "(mobile)",
        createdAt: Date.now(),
      });
      setNewTemplateModal(null);
      // Helpful: drop the user back into the picker with their new template
      // pre-filtered. Setting composer to "/<name>" makes the slashQuery
      // match exactly the row that just landed.
      setComposer(`/${name}`);
    } catch (e) {
      Alert.alert("Couldn't save", String((e as Error)?.message || e));
      setNewTemplateModal((m) => (m ? { ...m, saving: false } : m));
    }
  }, [newTemplateModal, user]);

  // v1.130: insert a mention. Replaces the "@<query>" in the composer
  // with "@<Name> " and records the uid so /send can push to them.
  // "pending:" uids are skipped from the mentions list (can't push someone
  // who never signed in / never registered a push token) but their name
  // still goes into the text — useful as a written-out @-callout.
  const insertMention = useCallback(
    (candidate: { uid: string; name: string }) => {
      if (!mentionMatch) return;
      const before = composer.slice(0, mentionMatch.atIndex);
      const after = composer.slice(mentionMatch.atIndex + 1 + mentionMatch.query.length);
      const newComposer = `${before}@${candidate.name} ${after}`;
      setComposer(newComposer);
      if (!candidate.uid.startsWith("pending:")) {
        setMentions((prev) => {
          const next = new Map(prev);
          next.set(candidate.uid, { name: candidate.name });
          return next;
        });
      }
    },
    [mentionMatch, composer],
  );

  // Insert a template into the composer (v1.126). Resolves {name},
  // {firstName}, {phone}, {trainerName} from the chat meta + signed-in
  // trainer. Replaces the entire composer (matching desktop behavior —
  // typing `/welcome` then picking inserts the whole canned message, the
  // user's "/welcome" placeholder gets thrown away).
  const insertTemplate = useCallback(
    (templateText: string) => {
      const resolved = substituteTemplateVars(templateText, {
        meta: isDm ? null : meta,
        resolvedDisplayName: isDm ? "" : headerName,
        trainerName: user?.displayName || user?.email || "",
      });
      setComposer(resolved);
    },
    [isDm, meta, headerName, user],
  );

  const onAttach = useCallback(async () => {
    if (!user || attachBusy) return;
    if (isDm) {
      Alert.alert(
        "Not yet",
        "Attachments aren't supported in internal chats yet — text only for now.",
      );
      return;
    }
    Alert.alert(
      "Attach",
      undefined,
      [
        {
          text: "Photo or video",
          onPress: async () => pickMedia("image"),
        },
        {
          text: "Document",
          onPress: async () => pickMedia("document"),
        },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );

    async function pickMedia(kind: "image" | "document") {
      setAttachBusy(true);
      try {
        let uri: string | null = null;
        let name = "file";
        let mimeType = "application/octet-stream";
        if (kind === "image") {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (perm.status !== "granted") {
            Alert.alert("Permission needed", "Allow photo access to attach.");
            return;
          }
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.All,
            quality: 0.85,
          });
          if (result.canceled || !result.assets?.[0]) return;
          const asset = result.assets[0];
          uri = asset.uri;
          name = asset.fileName || "media";
          mimeType =
            asset.mimeType ||
            (asset.type === "video" ? "video/mp4" : "image/jpeg");
        } else {
          const result = await DocumentPicker.getDocumentAsync({
            type: "*/*",
            copyToCacheDirectory: true,
          });
          if (result.canceled || !result.assets?.[0]) return;
          const asset = result.assets[0];
          uri = asset.uri;
          name = asset.name || "file";
          mimeType = asset.mimeType || "application/octet-stream";
        }
        if (!uri) return;
        // SDK 53+ returns size by default; the explicit { size: true } option
        // was removed. Read info.size as before if it's present.
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && info.size && info.size > MAX_MEDIA_BYTES) {
          Alert.alert("Too large", "Max attachment size is 25 MB.");
          return;
        }
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const mediaType = mimeType.startsWith("image/")
          ? "image"
          : mimeType.startsWith("video/")
          ? "video"
          : mimeType.startsWith("audio/")
          ? "audio"
          : "document";
        await doSendMedia({
          type: mediaType,
          filename: name,
          mimetype: mimeType,
          filedata: base64,
        });
      } catch (e: any) {
        Alert.alert("Attach failed", e?.message ?? String(e));
      } finally {
        setAttachBusy(false);
      }
    }

    async function doSendMedia(media: {
      type: "image" | "video" | "audio" | "document";
      filename: string;
      mimetype: string;
      filedata: string;
    }) {
      if (!user) return;
      const caption = composer.trim();
      const ts = Date.now();
      const msgRef = push(ref(db, `${ROOT}/chats/${chatKey}/messages`));
      const localMsgId = msgRef.key as string;
      await set(msgRef, {
        direction: "out",
        text: caption,
        ts,
        sentByUid: user.uid,
        sentByName: user.displayName || user.email,
        status: "sending",
        media: { mimeType: media.mimetype, fileName: media.filename },
        messageType: media.type,
      });
      const previewIcon =
        media.type === "image"
          ? "📷"
          : media.type === "video"
          ? "🎥"
          : media.type === "audio"
          ? "🎤"
          : "📎";
      await update(ref(db, `${ROOT}/chats/${chatKey}/meta`), {
        chatId,
        phone,
        lastMsgAt: ts,
        lastMsgPreview: caption || `${previewIcon} ${media.filename}`,
        lastMsgDirection: "out",
        lastMsgSentByName: user.displayName || user.email,
      });
      bumpSendActivity(chatKey);
      setComposer("");
      try {
        const res = await sendMessage({
          chatId,
          phone,
          message: caption,
          sentByUid: user.uid,
          sentByName: user.displayName || user.email || "",
          localMsgId,
          media,
        });
        if (!res.ok) {
          const t = await res.text();
          await update(msgRef, { status: "failed", error: t.slice(0, 300) });
        }
      } catch (e: any) {
        await update(msgRef, { status: "failed", error: String(e) });
      }
    }
  }, [isDm, user, attachBusy, composer, chatKey, chatId, phone]);

  const resolveSenderName = useCallback(
    (senderPhone: string) =>
      resolveDisplayName(
        senderPhone,
        null,
        { chatType: "user" },
        { habitUsers, cancelledUsers, ferraIndex, contacts },
      ),
    [habitUsers, cancelledUsers, ferraIndex, contacts],
  );

  // Day-divider rendering: walk the deduped list and remember the prior day.
  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => {
      const prev = visible[index - 1];
      const showDay = !prev || dayLabel(prev.ts) !== dayLabel(item.ts);
      return (
        <View>
          {showDay && (
            <View style={styles.dayWrap}>
              <Text style={styles.day}>{dayLabel(item.ts)}</Text>
            </View>
          )}
          <MessageBubble
            message={item}
            isGroup={isGroup}
            resolveSenderName={resolveSenderName}
            onPress={(m) => {
              // Single tap → open "Create ticket from this message" flow.
              // Matches webapp behaviour where clicking a bubble is the
              // primary affordance for raising a ticket.
              if (isDm) return; // DMs don't support tickets
              setTicketCreateFor(m);
            }}
            onLongPress={async (m) => {
              // Long-press → copy. Quietly puts text on clipboard and shows
              // a light toast-style alert so the trainer knows it worked.
              const txt =
                m.text ||
                m.media?.caption ||
                m.media?.fileName ||
                "";
              if (!txt) return;
              await Clipboard.setStringAsync(txt);
              Alert.alert("Copied");
            }}
          />
        </View>
      );
    },
    [visible, isGroup, resolveSenderName],
  );

  return (
    <KeyboardAvoidingView
      style={[
        styles.root,
        // Android edge-to-edge fix (v1.127): KAV's behaviors don't reliably
        // shrink the layout when the keyboard opens, so we pad the root
        // bottom by the actual measured keyboard height. Flex-end children
        // (composer + slash picker) then sit exactly above the keyboard.
        //
        // v1.128: add insets.bottom on top of the kb height. The gesture-nav
        // pill on edge-to-edge phones is drawn OVER the keyboard, so the
        // visually-usable area above the keyboard ends `insets.bottom` pixels
        // higher than endCoordinates.height suggests. Without this, the send
        // and attach buttons get clipped by ~20-30px on Pixel-style devices.
        Platform.OS === "android" && androidKbHeight > 0
          ? { paddingBottom: androidKbHeight + insets.bottom }
          : null,
      ]}
      // iOS keeps "padding" (works well with the bottom tab safe area).
      // Android: undefined — we handle it manually via the paddingBottom
      // above. Setting "height" actually made things WORSE on edge-to-edge
      // because it measures the layout incorrectly.
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}
    >
      {!isDm && (
        <TicketBanner
          tickets={banner}
          currentUid={user?.uid ?? ""}
          currentName={user?.displayName || user?.email || ""}
          onReassign={(id) => {
            const t = banner.find((x) => x.id === id);
            if (t) setReassignTicket(t);
          }}
        />
      )}
      <FlatList
        ref={listRef}
        data={visible}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() =>
          listRef.current?.scrollToEnd({ animated: false })
        }
      />
      {/* Slash-command template picker (v1.126). Visible whenever composer
          starts with "/". Sits BETWEEN the message list and the composer so
          it stays put when the keyboard is open. v1.129 adds an inline
          "+ New template" action so trainers can capture canned replies
          from the phone without bouncing back to the desktop. */}
      {slashQuery !== null && (
        <View style={styles.tplPicker}>
          {slashMatches.length === 0 ? (
            <View style={styles.tplEmptyWrap}>
              <Text style={styles.tplEmptyTxt}>
                {Object.keys(templates).length === 0
                  ? "No templates yet. Tap “+ New template” to create one."
                  : `No templates match "/${slashQuery}"`}
              </Text>
            </View>
          ) : (
            <>
              {slashMatches.slice(0, 6).map((t) => (
                <TouchableOpacity
                  key={t.id}
                  style={styles.tplItem}
                  onPress={() => insertTemplate(t.text || "")}
                  activeOpacity={0.7}
                >
                  <Text style={styles.tplName} numberOfLines={1}>
                    /{t.name}
                  </Text>
                  <Text style={styles.tplPreview} numberOfLines={2}>
                    {t.text}
                  </Text>
                </TouchableOpacity>
              ))}
              <Text style={styles.tplHint}>
                Tap to insert — variables fill from this chat
              </Text>
            </>
          )}
          {/* + New template action sits at the bottom of the picker so it
              doesn't shift around when filtering. Pre-fills the keyword
              with whatever the user has already typed after the slash. */}
          <TouchableOpacity
            style={styles.tplNewBtn}
            onPress={() =>
              setNewTemplateModal({
                name: slashQuery || "",
                text: "",
                saving: false,
              })
            }
            activeOpacity={0.7}
          >
            <Text style={styles.tplNewBtnTxt}>+ New template</Text>
          </TouchableOpacity>
        </View>
      )}
      {/* @-mention picker (v1.130). Same chrome as the slash picker so the
          two feel like a pair. Shows up to 6 candidate teammates. Tapping
          inserts "@Name " into the composer and registers the uid so the
          worker pushes them on send, bypassing strict targeting. */}
      {mentionMatch && (
        <View style={styles.tplPicker}>
          {mentionCandidates.length === 0 ? (
            <View style={styles.tplEmptyWrap}>
              <Text style={styles.tplEmptyTxt}>
                {`No teammates match "@${mentionMatch.query}"`}
              </Text>
            </View>
          ) : (
            <>
              {mentionCandidates.slice(0, 6).map((c) => (
                <TouchableOpacity
                  key={c.uid}
                  style={styles.tplItem}
                  onPress={() => insertMention(c)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.tplName} numberOfLines={1}>
                    @{c.name}
                  </Text>
                  {!c.active && (
                    <Text style={styles.tplPreview} numberOfLines={1}>
                      Hasn't signed in yet — name will go in the message
                      but no push will reach them.
                    </Text>
                  )}
                </TouchableOpacity>
              ))}
              <Text style={styles.tplHint}>
                Tap to insert — they'll get a push even if it's not their
                ticket
              </Text>
            </>
          )}
        </View>
      )}
      <View
        style={[
          styles.composerRow,
          // Stack our base 8px composer padding on top of whatever the OS
          // reports as the bottom inset (gesture-nav pill / home indicator).
          // Phones without a gesture bar report 0 and we end up with 8px,
          // same as before.
          //
          // When the Android keyboard is up (v1.127), the keyboard already
          // covers the gesture-nav area — adding insets.bottom on top of
          // that wastes vertical space and leaves a big gap between the
          // text input and the keyboard. Drop to just 4px in that case so
          // the composer hugs the keyboard like every other chat app.
          {
            paddingBottom:
              Platform.OS === "android" && androidKbHeight > 0
                ? 4
                : insets.bottom + 8,
          },
        ]}
      >
        <TouchableOpacity
          style={[styles.attach, attachBusy && styles.attachBusy]}
          onPress={onAttach}
          disabled={attachBusy}
        >
          <Text style={styles.attachTxt}>📎</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          value={composer}
          onChangeText={setComposer}
          placeholder="Type a message"
          placeholderTextColor={colors.muted}
          multiline
        />
        {/* 🎤 voice-to-note button. Only shown on customer chats (DMs skip
            it — no use case for private notes on internal chats). Hidden if
            expo-audio isn't loaded (older native builds). Records → /transcribe
            → opens a preview modal where the trainer reviews and saves as a
            private note (not sent to the customer). Same flow as the
            webapp's composer mic. */}
        {!isDm && audioMod && (
          <VoiceNoteMic
            onTranscribed={onTranscribed}
            transcribing={transcribing}
          />
        )}
        <TouchableOpacity
          style={[styles.send, !composer.trim() && styles.sendDisabled]}
          disabled={!composer.trim()}
          onPress={send}
        >
          <Text style={styles.sendTxt}>➤</Text>
        </TouchableOpacity>
      </View>

      <NotePreviewModal
        text={notePreview}
        onCancel={() => setNotePreview(null)}
        onSave={saveVoiceNote}
        saving={savingNote}
      />

      <CreateTicketModal
        visible={!!ticketCreateFor}
        message={ticketCreateFor}
        chatId={chatId}
        currentUid={user?.uid ?? ""}
        currentName={user?.displayName || user?.email || ""}
        teamUsers={teamUsers}
        onClose={() => setTicketCreateFor(null)}
      />

      <ReassignModal
        visible={!!reassignTicket}
        ticket={reassignTicket}
        currentUid={user?.uid ?? ""}
        currentName={user?.displayName || user?.email || ""}
        teamUsers={teamUsers}
        onClose={() => setReassignTicket(null)}
      />

      <SummaryModal
        visible={summaryOpen}
        chatId={chatId}
        onClose={() => setSummaryOpen(false)}
      />

      {/* v1.129: New-template composer. Same layout as NotePreviewModal so
          the screen feels familiar — a card with two inputs (slash keyword
          + body text) and Cancel/Save. */}
      <Modal
        visible={!!newTemplateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setNewTemplateModal(null)}
      >
        <View style={styles.previewBack}>
          <View style={styles.previewCard}>
            <View style={styles.previewHead}>
              <Text style={styles.previewTitle}>New template</Text>
              <Text style={styles.previewSub}>
                Shared with the whole team. Variables: {"{firstName}, {name}, {phone}, {trainerName}"}
              </Text>
            </View>
            <Text style={styles.tplFormLabel}>Slash keyword</Text>
            <TextInput
              style={styles.tplFormInput}
              value={newTemplateModal?.name ?? ""}
              onChangeText={(v) =>
                setNewTemplateModal((m) => (m ? { ...m, name: v } : m))
              }
              placeholder="e.g. welcome"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.tplFormLabel}>Message body</Text>
            <TextInput
              style={[styles.tplFormInput, styles.tplFormBody]}
              value={newTemplateModal?.text ?? ""}
              onChangeText={(v) =>
                setNewTemplateModal((m) => (m ? { ...m, text: v } : m))
              }
              placeholder="Hi {firstName}, welcome to Aroleap! I'm {trainerName} — let me know how I can help."
              placeholderTextColor={colors.muted}
              multiline
            />
            <View style={styles.previewActions}>
              <TouchableOpacity
                style={styles.previewBtn}
                onPress={() => setNewTemplateModal(null)}
                disabled={newTemplateModal?.saving}
              >
                <Text style={styles.previewBtnTxt}>Cancel</Text>
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                onPress={saveNewTemplate}
                style={[
                  styles.previewSave,
                  newTemplateModal?.saving && styles.previewSaveDisabled,
                ]}
                disabled={!!newTemplateModal?.saving}
              >
                <Text style={styles.previewSaveTxt}>
                  {newTemplateModal?.saving ? "Saving…" : "Save"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

// Lightweight bottom sheet for long-press actions (Create ticket / Copy).
// Could be a separate file, but it's tightly coupled to the thread screen.
// 🎤 voice-note mic for the thread composer. Only mounted when expo-audio
// loaded at module init, so React's rules-of-hooks stays clean (the hook
// is always called from inside this component, never skipped).
// Tap once → request mic permission → start recording (button turns red ⏹).
// Tap again → stop recording → parent transcribes the URI.
function VoiceNoteMic({
  onTranscribed,
  transcribing,
}: {
  onTranscribed: (uri: string) => Promise<void>;
  transcribing: boolean;
}) {
  const recorder = audioMod.useAudioRecorder(
    audioMod.RecordingPresets.HIGH_QUALITY,
  );
  const recorderState = audioMod.useAudioRecorderState(recorder);
  const isRecording = !!recorderState?.isRecording;

  async function toggle() {
    if (transcribing) return;
    if (isRecording) {
      try {
        await recorder.stop();
        const uri = recorder.uri as string | undefined;
        if (uri) await onTranscribed(uri);
      } catch (e) {
        Alert.alert(
          "Couldn't stop recording",
          String((e as Error)?.message || e),
        );
      }
      return;
    }
    try {
      const perm = await audioMod.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Microphone access denied",
          "Enable microphone permission in your phone's Settings for CommonCommunication.",
        );
        return;
      }
      await audioMod.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
      });
      await recorder.prepareToRecordAsync();
      recorder.record();
    } catch (e) {
      Alert.alert(
        "Couldn't start recording",
        String((e as Error)?.message || e),
      );
    }
  }

  return (
    <TouchableOpacity
      onPress={toggle}
      style={[styles.mic, isRecording && styles.micRecording]}
      disabled={transcribing}
      accessibilityLabel={isRecording ? "Stop recording" : "Record a voice note"}
    >
      {transcribing ? (
        <ActivityIndicator color="white" size="small" />
      ) : (
        <Text style={styles.micTxt}>{isRecording ? "⏹" : "🎤"}</Text>
      )}
    </TouchableOpacity>
  );
}

// Editable preview modal — shown after the mic transcribes audio. Trainer
// reviews the transcript, edits if needed, taps Save to write to the
// chat's /notes feed. Save is disabled while the request is in flight.
function NotePreviewModal({
  text,
  onCancel,
  onSave,
  saving,
}: {
  text: string | null;
  onCancel: () => void;
  onSave: (text: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (text !== null) setDraft(text);
  }, [text]);
  return (
    <Modal
      transparent
      visible={text !== null}
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable style={styles.previewBack} onPress={onCancel}>
        <Pressable style={styles.previewCard} onPress={(e) => e.stopPropagation()}>
          <View style={styles.previewHead}>
            <Text style={styles.previewTitle}>📝 Save as note?</Text>
            <Text style={styles.previewSub}>
              Private to your team. The customer never sees this.
            </Text>
          </View>
          <TextInput
            style={styles.previewInput}
            value={draft}
            onChangeText={setDraft}
            multiline
            autoFocus
            placeholderTextColor={colors.muted}
            editable={!saving}
          />
          <View style={styles.previewActions}>
            <TouchableOpacity
              onPress={onCancel}
              style={styles.previewBtn}
              disabled={saving}
            >
              <Text style={styles.previewBtnTxt}>Cancel</Text>
            </TouchableOpacity>
            <View style={{ flex: 1 }} />
            <TouchableOpacity
              onPress={() => onSave(draft)}
              style={[
                styles.previewSave,
                (!draft.trim() || saving) && styles.previewSaveDisabled,
              ]}
              disabled={!draft.trim() || saving}
            >
              {saving ? (
                <ActivityIndicator color="white" size="small" />
              ) : (
                <Text style={styles.previewSaveTxt}>Save note</Text>
              )}
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ActionSheet({
  message,
  showTicket,
  onClose,
  onTicket,
  onCopy,
}: {
  message: Message | null;
  showTicket: boolean;
  onClose: () => void;
  onTicket: () => void;
  onCopy: () => void;
}) {
  const visible = !!message;
  const quote = message
    ? message.text ||
      message.media?.caption ||
      message.media?.fileName ||
      "[media]"
    : "";
  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.sheetBack} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grab} />
          <Text style={styles.sheetQuote} numberOfLines={2}>
            {quote}
          </Text>
          {showTicket && (
            <TouchableOpacity style={styles.sheetItem} onPress={onTicket}>
              <Text style={styles.sheetItemGlyph}>🎫</Text>
              <Text style={styles.sheetItemTxt}>
                Create ticket from this message
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.sheetItem} onPress={onCopy}>
            <Text style={styles.sheetItemGlyph}>📋</Text>
            <Text style={styles.sheetItemTxt}>Copy text</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.sheetItem, styles.sheetCancel]}
            onPress={onClose}
          >
            <Text style={styles.sheetItemTxt}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  list: { flex: 1, backgroundColor: colors.bg },
  listContent: { paddingHorizontal: 8, paddingVertical: 12 },
  // v1.118: smaller, more subtle date dividers. The old teal pill drew too
  // much attention given how often these recur. Matches WhatsApp's quiet
  // grey-on-white style.
  dayWrap: { alignItems: "center", marginVertical: 6 },
  day: {
    backgroundColor: "rgba(255,255,255,0.85)",
    color: colors.muted,
    fontSize: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden",
  },
  composerRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 6,
    paddingBottom: 8,
    backgroundColor: colors.greenDark,
    gap: 6,
  },
  // Slash-command template picker (v1.126). Anchored above the composer,
  // dark surface so it pops against the message list. Capped at ~240px so
  // the list itself stays visible behind it on short screens.
  tplPicker: {
    maxHeight: 240,
    backgroundColor: "#1f2933",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.15)",
    paddingVertical: 4,
  },
  tplItem: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  tplName: {
    color: "#5eead4",
    fontSize: 13,
    fontWeight: "600",
  },
  tplPreview: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    marginTop: 2,
  },
  tplHint: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 11,
    paddingHorizontal: 14,
    paddingVertical: 6,
    fontStyle: "italic",
  },
  tplEmptyWrap: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  tplEmptyTxt: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    lineHeight: 18,
  },
  // v1.129: "+ New template" action at the bottom of the picker. Reads
  // as a CTA but stays compact (single line, no row separator below) so
  // it doesn't drown out actual matches.
  tplNewBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.12)",
  },
  tplNewBtnTxt: {
    color: "#5eead4",
    fontSize: 13,
    fontWeight: "600",
  },
  // v1.129 new-template modal — re-uses NotePreviewModal's card chrome but
  // adds its own labels/inputs since the layout has two fields stacked.
  tplFormLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: colors.muted,
    marginTop: 6,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  tplFormInput: {
    fontSize: 14,
    color: colors.text,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    marginTop: 4,
    backgroundColor: "#fafafa",
  },
  tplFormBody: {
    minHeight: 80,
    maxHeight: 200,
    textAlignVertical: "top",
  },
  attach: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  attachBusy: { opacity: 0.5 },
  attachTxt: { color: "white", fontSize: 18 },
  input: {
    flex: 1,
    backgroundColor: "white",
    borderRadius: 22,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
    minHeight: 40,
    maxHeight: 120,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { backgroundColor: "#8fb3a8" },
  sendTxt: { color: "white", fontSize: 20 },
  // v1.118: mic gets a distinctly darker background + thin white outline
  // so it reads as a separate, more "primary" affordance vs the 📎 attach
  // button. Both were the same translucent white before and visually merged.
  mic: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.22)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  micRecording: {
    backgroundColor: "#dc2626",
    borderColor: "#dc2626",
  },
  micTxt: { color: "white", fontSize: 18 },
  previewBack: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 20,
  },
  previewCard: {
    backgroundColor: "white",
    borderRadius: 12,
    padding: 16,
    maxHeight: "80%",
  },
  previewHead: { marginBottom: 8 },
  previewTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
  previewSub: { fontSize: 12, color: colors.muted, marginTop: 2 },
  previewInput: {
    minHeight: 80,
    maxHeight: 240,
    fontSize: 14,
    color: colors.text,
    padding: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 8,
    textAlignVertical: "top",
    backgroundColor: "#fff8e7",
    marginVertical: 8,
  },
  previewActions: { flexDirection: "row", alignItems: "center" },
  previewBtn: { paddingVertical: 8, paddingHorizontal: 12 },
  previewBtnTxt: { color: colors.muted, fontSize: 14 },
  previewSave: {
    backgroundColor: colors.greenDark,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 22,
  },
  previewSaveDisabled: { backgroundColor: "#8fb3a8" },
  previewSaveTxt: { color: "white", fontWeight: "600", fontSize: 14 },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  headerBtnTxt: { color: "white", fontSize: 16 },
  headerRightWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  sheetBack: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "white",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingTop: 8,
    paddingBottom: 28,
  },
  grab: {
    width: 36,
    height: 4,
    backgroundColor: "#d1d7db",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 8,
  },
  sheetQuote: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    color: colors.muted,
    fontSize: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sheetItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 14,
    gap: 14,
  },
  sheetCancel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  sheetItemGlyph: { fontSize: 18, width: 24, textAlign: "center" },
  sheetItemTxt: { fontSize: 15, color: colors.text },
});
