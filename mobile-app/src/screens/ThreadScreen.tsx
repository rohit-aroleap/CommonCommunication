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
import { db } from "@/firebase";
import { ROOT, MAX_MEDIA_BYTES } from "@/config";
import { colors, space } from "@/theme";
import {
  useAppData,
  openTicketsForChat,
} from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { dayLabel } from "@/lib/format";
import { chatKeyToChatId } from "@/lib/encodeKey";
import { fetchChatInfo, sendMessage } from "@/lib/worker";
import { dedupMessages } from "@/lib/messageDedup";
import { MessageBubble } from "@/components/MessageBubble";
import { TicketBanner } from "@/components/TicketBanner";
import { CreateTicketModal } from "@/components/CreateTicketModal";
import { ReassignModal } from "@/components/ReassignModal";
import { SummaryModal } from "@/components/SummaryModal";
import type { Message, Ticket } from "@/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";

type Props = NativeStackScreenProps<RootStackParamList, "Thread">;

export function ThreadScreen({ route, navigation }: Props) {
  const { chatKey, initialTitle } = route.params;
  const { user } = useAuth();
  const {
    chatMetaByKey,
    tickets,
    teamUsers,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
    markChatSeen,
    bumpSendActivity,
  } = useAppData();

  const meta = chatMetaByKey[chatKey] ?? {};
  const isGroup =
    meta.chatType === "group" ||
    String(meta.chatId || "").endsWith("@g.us");
  const chatId = meta.chatId || chatKeyToChatId(chatKey);
  const phone = meta.phone || chatId.split("@")[0];

  const headerName = useMemo(() => {
    if (initialTitle) return initialTitle;
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
  const [sheetMsg, setSheetMsg] = useState<Message | null>(null);
  const [ticketCreateFor, setTicketCreateFor] = useState<Message | null>(null);
  const [reassignTicket, setReassignTicket] = useState<Ticket | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [attachBusy, setAttachBusy] = useState(false);
  const listRef = useRef<FlatList<Message>>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      // Custom title component so we can make the name itself a tap target
      // that opens the Customer Info screen. Native title text isn't tappable
      // by default on React Navigation's stack header.
      headerTitle: () => (
        <TouchableOpacity
          onPress={() =>
            navigation.navigate("CustomerInfo", { chatKey })
          }
          accessibilityLabel="Open customer info"
          activeOpacity={0.6}
          style={styles.headerTitleWrap}
        >
          <Text style={styles.headerTitleTxt} numberOfLines={1}>
            {headerName}
          </Text>
          <Text style={styles.headerTitleSub}>tap for details</Text>
        </TouchableOpacity>
      ),
      headerRight: () => (
        <TouchableOpacity
          accessibilityLabel="Summarize"
          onPress={() => setSummaryOpen(true)}
          style={styles.headerBtn}
        >
          <Text style={styles.headerBtnTxt}>✨</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, headerName, chatKey]);

  // Live messages listener (last 300).
  useEffect(() => {
    const q = query(
      ref(db, `${ROOT}/chats/${chatKey}/messages`),
      orderByChild("ts"),
      limitToLast(300),
    );
    const unsub = onValue(q, (snap) => {
      const v = snap.val() || {};
      const list: Message[] = Object.entries(
        v as Record<string, Message>,
      ).map(([k, m]) => ({ ...m, id: k }));
      list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      setMessages(list);
      markChatSeen(chatKey);
      // Auto-scroll to bottom after the snapshot lands.
      requestAnimationFrame(() => {
        listRef.current?.scrollToEnd({ animated: false });
      });
    });
    // Fetch group name lazily if missing.
    if (isGroup && !meta.groupName) {
      fetchChatInfo(chatId);
    }
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatKey]);

  // Deduplicate by inner unique id — see lib/messageDedup for the rationale.
  const visible = useMemo(() => dedupMessages(messages), [messages]);

  const banner = useMemo<Ticket[]>(
    () => openTicketsForChat(tickets, chatKey),
    [tickets, chatKey],
  );

  const send = useCallback(async () => {
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
    setComposer("");
    try {
      const res = await sendMessage({
        chatId,
        phone,
        message: text,
        sentByUid: user.uid,
        sentByName: user.displayName || user.email || "",
        localMsgId,
      });
      if (!res.ok) {
        const t = await res.text();
        await update(msgRef, { status: "failed", error: t.slice(0, 300) });
      }
    } catch (e: any) {
      await update(msgRef, { status: "failed", error: String(e) });
    }
  }, [composer, user, chatKey, chatId, phone]);

  const onAttach = useCallback(async () => {
    if (!user || attachBusy) return;
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
  }, [user, attachBusy, composer, chatKey, chatId, phone]);

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
            onLongPress={(m) => setSheetMsg(m)}
          />
        </View>
      );
    },
    [visible, isGroup, resolveSenderName],
  );

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}
    >
      <TicketBanner
        tickets={banner}
        currentUid={user?.uid ?? ""}
        currentName={user?.displayName || user?.email || ""}
        onReassign={(id) => {
          const t = banner.find((x) => x.id === id);
          if (t) setReassignTicket(t);
        }}
      />
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
      <View style={styles.composerRow}>
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
        <TouchableOpacity
          style={[styles.send, !composer.trim() && styles.sendDisabled]}
          disabled={!composer.trim()}
          onPress={send}
        >
          <Text style={styles.sendTxt}>➤</Text>
        </TouchableOpacity>
      </View>

      <ActionSheet
        message={sheetMsg}
        onClose={() => setSheetMsg(null)}
        onTicket={() => {
          const m = sheetMsg;
          setSheetMsg(null);
          if (m) setTicketCreateFor(m);
        }}
        onCopy={async () => {
          const m = sheetMsg;
          setSheetMsg(null);
          if (m?.text) await Clipboard.setStringAsync(m.text);
        }}
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
    </KeyboardAvoidingView>
  );
}

// Lightweight bottom sheet for long-press actions (Create ticket / Copy).
// Could be a separate file, but it's tightly coupled to the thread screen.
function ActionSheet({
  message,
  onClose,
  onTicket,
  onCopy,
}: {
  message: Message | null;
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
          <TouchableOpacity style={styles.sheetItem} onPress={onTicket}>
            <Text style={styles.sheetItemGlyph}>🎫</Text>
            <Text style={styles.sheetItemTxt}>
              Create ticket from this message
            </Text>
          </TouchableOpacity>
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
  dayWrap: { alignItems: "center", marginVertical: 8 },
  day: {
    backgroundColor: "#e1f2fb",
    color: colors.muted,
    fontSize: 11,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
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
  headerTitleWrap: { maxWidth: 240 },
  headerTitleTxt: {
    color: "white",
    fontSize: 17,
    fontWeight: "600",
  },
  headerTitleSub: {
    color: "rgba(255,255,255,0.65)",
    fontSize: 10,
    marginTop: -2,
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
