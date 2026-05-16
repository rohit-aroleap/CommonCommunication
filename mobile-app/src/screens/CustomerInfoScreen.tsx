// Customer info — opened by tapping the name in the Thread header.
// Mirrors the right-side drawer on the desktop dashboard: subscription stage,
// habit metrics, acquisition source, ticket history. Read-only for now.

import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import { onValue, push, ref, set } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { colors, space } from "@/theme";
import { useAppData, openTicketsForChat } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { chatKeyToChatId } from "@/lib/encodeKey";
import { getFerraUserByPhone, normalizeFerraPhone } from "@/lib/ferra";
import { transcribeAudio } from "@/lib/worker";
import { FERRA_TAG_STAGE } from "@/config";
import type { Ticket } from "@/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";

// Lazy require for expo-av so an older native build (one that doesn't yet
// have the audio module bundled) doesn't crash on import. Mic button shows
// only when this resolves and the runtime call succeeds — otherwise we
// surface a "needs rebuild" message and the trainer can still type the note.
// Typed as `any` because TypeScript can't resolve expo-av types until the
// package is installed (added in v1.109 but the dep isn't bundled yet by
// older native builds — and we tolerate that gracefully at runtime).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let AvAudio: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  AvAudio = require("expo-av").Audio;
} catch {
  AvAudio = null;
}

// Internal note (yellow panel on desktop). Auto-mirrored to here when a
// ticket is resolved with a note; can also be written directly via the
// desktop UI. Mobile is read-only for now.
interface ChatNote {
  id: string;
  text: string;
  authorName?: string;
  createdAt?: number;
  source?: string;
  ticketId?: string;
}

type Props = NativeStackScreenProps<RootStackParamList, "CustomerInfo">;

export function CustomerInfoScreen({ route }: Props) {
  const { chatKey } = route.params;
  const { user } = useAuth();
  const {
    chatMetaByKey,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
    sharedSubsByPhone,
    sharedCustomerDetails,
    tickets,
  } = useAppData();

  const meta = chatMetaByKey[chatKey] ?? {};
  const isGroup =
    meta.chatType === "group" ||
    String(meta.chatId || "").endsWith("@g.us");
  const chatId = meta.chatId || chatKeyToChatId(chatKey);
  const phone = meta.phone || chatId.split("@")[0];

  const displayName = useMemo(
    () =>
      resolveDisplayName(
        phone,
        meta.contactName || meta.displayName,
        {
          chatType: isGroup ? "group" : "user",
          groupName: meta.groupName,
        },
        { habitUsers, cancelledUsers, ferraIndex, contacts },
      ),
    [
      phone,
      isGroup,
      meta.contactName,
      meta.displayName,
      meta.groupName,
      habitUsers,
      cancelledUsers,
      ferraIndex,
      contacts,
    ],
  );

  const ferraUser = useMemo(
    () => getFerraUserByPhone(phone, habitUsers, cancelledUsers, ferraIndex),
    [phone, habitUsers, cancelledUsers, ferraIndex],
  );

  const normalizedPhone = normalizeFerraPhone(phone);
  const subscriptionStatus = ferraIndex.phoneToStatus[normalizedPhone] ?? null;
  const isActive = subscriptionStatus === "ACTIVE";
  const isCancelled = ferraIndex.cancelledPhones.has(normalizedPhone);

  // Customer details from ferraSubscriptions/v1/customerDetails — synced from
  // the upstream Ferra Cloud Function. Contains address, email, plan tier,
  // last payment status, etc. Keyed by normalized phone.
  const customerDetail = sharedCustomerDetails?.[normalizedPhone] ?? null;

  const subTag = sharedSubsByPhone?.[normalizedPhone] ?? null;
  const subStage = subTag ? FERRA_TAG_STAGE[subTag] : null;

  const chatTickets = useMemo<Ticket[]>(() => {
    const out: Ticket[] = [];
    for (const [id, t] of Object.entries(tickets || {})) {
      if (!t) continue;
      const anchor = String(t.anchorChatId || "");
      if (anchor.replace(/[.#$\[\]\/]/g, "_") !== chatKey) continue;
      out.push({ ...t, id });
    }
    return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [tickets, chatKey]);

  const openTix = useMemo(
    () => openTicketsForChat(tickets, chatKey),
    [tickets, chatKey],
  );

  // Internal notes — yellow-banner trainer notes from desktop, plus the
  // auto-mirrored resolution-note entries from v1.090+. Live listener so
  // newly-added notes show up without a refresh.
  const [notes, setNotes] = useState<ChatNote[]>([]);
  useEffect(() => {
    const notesRef = ref(db, `${ROOT}/chats/${chatKey}/notes`);
    const unsub = onValue(notesRef, (snap) => {
      const v = snap.val() || {};
      const list: ChatNote[] = Object.entries(
        v as Record<string, Omit<ChatNote, "id">>,
      ).map(([id, n]) => ({ ...n, id }));
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      setNotes(list);
    });
    return unsub;
  }, [chatKey]);

  // Add-note state machine. Three flags so the UI can show the right buttons:
  //   composing   — input box is open (otherwise just the "+ Add note" trigger)
  //   recording   — actively capturing audio via expo-av
  //   transcribing — uploading the recorded audio to /transcribe
  //   saving      — writing the final note to Firebase
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Hold the active Recording instance across renders without re-creating it.
  // Typed as any since expo-av types aren't resolved at compile time (see
  // the AvAudio lazy require comment).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recordingRef = React.useRef<any>(null);

  async function startRecording() {
    if (!AvAudio) {
      Alert.alert(
        "Voice notes need a rebuild",
        "This build of the app was made before voice recording was added. Ask the admin to rebuild and reinstall.",
      );
      return;
    }
    try {
      const perm = await AvAudio.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Microphone access denied",
          "Enable microphone permission in your phone's Settings for CommonCommunication.",
        );
        return;
      }
      await AvAudio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const rec = new AvAudio.Recording();
      // Use HIGH_QUALITY preset — Whisper is robust to compression, this just
      // makes file sizes manageable for the base64 upload.
      await rec.prepareToRecordAsync(
        AvAudio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      await rec.startAsync();
      recordingRef.current = rec;
      setRecording(true);
    } catch (e) {
      Alert.alert("Couldn't start recording", String((e as Error)?.message || e));
    }
  }

  async function stopRecordingAndTranscribe() {
    const rec = recordingRef.current;
    if (!rec) return;
    setRecording(false);
    setTranscribing(true);
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      recordingRef.current = null;
      if (!uri) throw new Error("recording produced no file");
      // Read the raw audio bytes as base64 and POST to /transcribe. The worker
      // runs Whisper + a Claude cleanup pass and returns the cleaned text.
      const b64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const text = await transcribeAudio(b64);
      // Append (don't overwrite) so a trainer can keep typing then dictate
      // more, or vice versa.
      setDraft((prev) => (prev ? prev + " " + text : text).trim());
    } catch (e) {
      Alert.alert("Transcription failed", String((e as Error)?.message || e));
    } finally {
      setTranscribing(false);
    }
  }

  async function saveNote() {
    const txt = draft.trim();
    if (!txt || !user) return;
    setSaving(true);
    try {
      const noteRef = push(ref(db, `${ROOT}/chats/${chatKey}/notes`));
      await set(noteRef, {
        text: txt,
        authorUid: user.uid,
        authorName: user.displayName || user.email || "(me)",
        createdAt: Date.now(),
        source: "mobile",
      });
      setDraft("");
      setComposing(false);
    } catch (e) {
      Alert.alert("Couldn't save note", String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  }

  function cancelCompose() {
    if (recording) {
      // Abort an in-flight recording cleanly.
      const rec = recordingRef.current;
      recordingRef.current = null;
      rec?.stopAndUnloadAsync().catch(() => {});
      setRecording(false);
    }
    setDraft("");
    setComposing(false);
  }

  if (isGroup) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.empty}>
        <Text style={styles.emptyTxt}>
          Customer info isn't shown for group chats — a group has many members.
        </Text>
      </ScrollView>
    );
  }

  // Pre-format some values once so the JSX stays readable.
  const ageGenderLine = [
    ferraUser?.age ? `${ferraUser.age}y` : null,
    ferraUser?.gender || null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Tap-the-phone action sheet. Three useful options:
  //   Call    — opens native dialer (tel: scheme)
  //   WhatsApp — opens chat with this customer in the WhatsApp app
  //   Copy    — to clipboard for any other use
  // Wrapped so it's a clear top-level handler instead of inline onPress.
  function handlePhonePress() {
    const e164 = phone.startsWith("+") ? phone : `+${phone}`;
    Alert.alert(e164, undefined, [
      {
        text: "Call",
        onPress: () => {
          Linking.openURL(`tel:${e164}`).catch(() =>
            Alert.alert("Couldn't open dialer"),
          );
        },
      },
      {
        text: "WhatsApp",
        onPress: () => {
          // whatsapp:// scheme works if WhatsApp is installed; falls back
          // to the universal wa.me web link otherwise.
          const digits = e164.replace(/\D/g, "");
          Linking.openURL(`whatsapp://send?phone=${digits}`).catch(() => {
            Linking.openURL(`https://wa.me/${digits}`).catch(() =>
              Alert.alert("Couldn't open WhatsApp"),
            );
          });
        },
      },
      {
        text: "Copy",
        onPress: async () => {
          await Clipboard.setStringAsync(e164);
          Alert.alert("Copied", e164);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }

  return (
    <ScrollView style={styles.root}>
      {/* Header */}
      <View style={styles.section}>
        <Text style={styles.name} selectable>
          {displayName}
        </Text>
        <View style={styles.sublineRow}>
          <TouchableOpacity onPress={handlePhonePress} activeOpacity={0.5}>
            <Text style={styles.phoneLink}>{phone}</Text>
          </TouchableOpacity>
          {ageGenderLine ? (
            <Text style={styles.sublineMuted}> · {ageGenderLine}</Text>
          ) : null}
        </View>
        <View style={styles.pillRow}>
          {ferraUser && (
            <View style={styles.pillCustomer}>
              <Text style={styles.pillTxt}>Customer</Text>
            </View>
          )}
          {subscriptionStatus && (
            <View
              style={[
                styles.pill,
                isActive
                  ? styles.pillActive
                  : isCancelled
                    ? styles.pillCancelled
                    : styles.pillNeutral,
              ]}
            >
              <Text style={styles.pillTxt}>
                {isActive
                  ? "Active"
                  : isCancelled
                    ? "Cancelled"
                    : subscriptionStatus}
              </Text>
            </View>
          )}
          {subStage && subTag && (
            <View style={[styles.pill, styles.pillStage]}>
              <Text style={styles.pillTxt}>{subTag}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Address — pulled from Ferra subscriptions via the ferra-sync worker.
          Shown right under the header since it's the field trainers will
          most often reference (delivery checks, installation queries).
          selectable so trainers can long-press to copy / share the address. */}
      {customerDetail?.address && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📍 ADDRESS</Text>
          <Text style={styles.address} selectable>
            {customerDetail.address}
          </Text>
          <TouchableOpacity
            onPress={async () => {
              await Clipboard.setStringAsync(customerDetail.address!);
              Alert.alert("Copied address");
            }}
            style={styles.copyBtn}
            accessibilityLabel="Copy address"
          >
            <Text style={styles.copyBtnTxt}>📋 Copy address</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Notes — internal trainer notes about this customer. Persist across
          tickets; the yellow-banner panel on desktop. Newest first. The
          "+ Add note" row at the top opens an inline composer with a mic
          button for voice → transcription → editable text. */}
      <View style={[styles.section, styles.notesSection]}>
        <View style={styles.notesHeader}>
          <Text style={styles.sectionTitle}>
            📝 NOTES ({notes.length})
          </Text>
          {!composing && (
            <TouchableOpacity
              onPress={() => setComposing(true)}
              style={styles.addNoteBtn}
              accessibilityLabel="Add note"
            >
              <Text style={styles.addNoteBtnTxt}>+ Add note</Text>
            </TouchableOpacity>
          )}
        </View>

        {composing && (
          <View style={styles.composer}>
            <TextInput
              style={styles.composerInput}
              value={draft}
              onChangeText={setDraft}
              placeholder={
                transcribing
                  ? "Transcribing…"
                  : recording
                    ? "Recording — tap stop to transcribe"
                    : "Type a note, or tap 🎤 to dictate"
              }
              placeholderTextColor={colors.muted}
              multiline
              editable={!recording && !transcribing && !saving}
            />
            <View style={styles.composerActions}>
              <TouchableOpacity
                onPress={cancelCompose}
                style={styles.composerBtn}
                disabled={saving || transcribing}
              >
                <Text style={styles.composerBtnTxt}>Cancel</Text>
              </TouchableOpacity>
              <View style={{ flex: 1 }} />
              {/* Mic button — only when expo-av loaded. Tap to start, tap
                  again to stop + transcribe. Hidden entirely on old builds
                  that don't have the native module. */}
              {AvAudio && (
                <TouchableOpacity
                  onPress={recording ? stopRecordingAndTranscribe : startRecording}
                  style={[
                    styles.micBtn,
                    recording && styles.micBtnRecording,
                  ]}
                  disabled={transcribing || saving}
                  accessibilityLabel={recording ? "Stop recording" : "Record voice note"}
                >
                  {transcribing ? (
                    <ActivityIndicator color="white" size="small" />
                  ) : (
                    <Text style={styles.micBtnTxt}>
                      {recording ? "⏹" : "🎤"}
                    </Text>
                  )}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={saveNote}
                style={[
                  styles.sendBtn,
                  (!draft.trim() || saving) && styles.sendBtnDisabled,
                ]}
                disabled={!draft.trim() || saving || recording || transcribing}
                accessibilityLabel="Save note"
              >
                {saving ? (
                  <ActivityIndicator color="white" size="small" />
                ) : (
                  <Text style={styles.sendBtnTxt}>➤</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        )}

        {notes.map((n) => (
          <View key={n.id} style={styles.noteCard}>
            <Text style={styles.noteTxt} selectable>
              {n.text}
            </Text>
            <Text style={styles.noteMeta}>
              {n.authorName || "(unknown)"}
              {n.createdAt
                ? ` · ${new Date(n.createdAt).toLocaleDateString()}`
                : ""}
            </Text>
          </View>
        ))}
        {notes.length === 0 && !composing && (
          <Text style={styles.notesEmpty}>
            No notes yet. Tap "+ Add note" to add the first.
          </Text>
        )}
      </View>

      {/* Habit */}
      {ferraUser && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>HABIT</Text>
          <View style={styles.chipRow}>
            {ferraUser.habitScore != null && (
              <Chip label={`${Math.round(ferraUser.habitScore * 10) / 10} habit`} />
            )}
            {ferraUser.tierLabel && <Chip label={ferraUser.tierLabel} accent />}
            {ferraUser.streak && (
              <Chip
                label={`${ferraUser.streak.days}d streak${ferraUser.streak.active ? " · active" : ""}`}
                accent={ferraUser.streak.active}
              />
            )}
            {ferraUser.daysSinceLastSession != null && (
              <Chip label={`${ferraUser.daysSinceLastSession}d since session`} />
            )}
            {ferraUser.trend14d != null && (
              <Chip
                label={`${ferraUser.trend14d > 0 ? "+" : ""}${ferraUser.trend14d} 14d trend`}
              />
            )}
          </View>
          {ferraUser.lastActiveDate && (
            <Text style={styles.muted}>
              Last active: {ferraUser.lastActiveDate}
            </Text>
          )}
        </View>
      )}

      {/* Subscription */}
      {(ferraUser?.subscriptionPlanTier ||
        ferraUser?.subscriptionStartDate ||
        ferraUser?.subscriptionSource ||
        customerDetail?.email ||
        customerDetail?.lastPaymentStatus) && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SUBSCRIPTION</Text>
          {ferraUser?.subscriptionPlanTier && (
            <Row k="Plan" v={ferraUser.subscriptionPlanTier} />
          )}
          {ferraUser?.subscriptionStatus && (
            <Row k="Status" v={ferraUser.subscriptionStatus} />
          )}
          {ferraUser?.subscriptionStartDate && (
            <Row
              k="Started"
              v={new Date(ferraUser.subscriptionStartDate).toLocaleDateString()}
            />
          )}
          {ferraUser?.userAgeDays != null && (
            <Row k="Age" v={`${ferraUser.userAgeDays}d`} />
          )}
          {ferraUser?.segment && <Row k="Segment" v={ferraUser.segment} />}
          {ferraUser?.subscriptionSource && (
            <Row k="Source" v={ferraUser.subscriptionSource} />
          )}
          {customerDetail?.email && <Row k="Email" v={customerDetail.email} />}
          {customerDetail?.lastPaymentStatus && (
            <Row
              k="Last payment"
              v={
                customerDetail.lastPaymentDate
                  ? `${customerDetail.lastPaymentStatus} · ${new Date(customerDetail.lastPaymentDate).toLocaleDateString()}`
                  : customerDetail.lastPaymentStatus
              }
            />
          )}
        </View>
      )}

      {/* Acquisition (UTM / ad attribution). Only shows if any UTM field is
          present — most organic signups won't have these. */}
      {ferraUser &&
        (ferraUser.adSource ||
          ferraUser.adMedium ||
          ferraUser.adCampaign ||
          ferraUser.adContent ||
          ferraUser.adTerm ||
          ferraUser.landingPage ||
          ferraUser.referrer) && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>ACQUISITION</Text>
            {ferraUser.adSource && <Row k="Source" v={ferraUser.adSource} />}
            {ferraUser.adMedium && <Row k="Medium" v={ferraUser.adMedium} />}
            {ferraUser.adCampaign && (
              <Row k="Campaign" v={ferraUser.adCampaign} />
            )}
            {ferraUser.adContent && (
              <Row k="Content" v={ferraUser.adContent} />
            )}
            {ferraUser.adTerm && <Row k="Term" v={ferraUser.adTerm} />}
            {ferraUser.landingPage && (
              <Row k="Landing" v={ferraUser.landingPage} />
            )}
            {ferraUser.referrer && <Row k="Referrer" v={ferraUser.referrer} />}
          </View>
        )}

      {/* Tickets */}
      {chatTickets.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            TICKETS ({chatTickets.length}) ·{" "}
            {openTix.length} OPEN
          </Text>
          {chatTickets.map((t) => (
            <View key={t.id} style={styles.ticketCard}>
              <View style={styles.ticketTop}>
                <Text style={styles.ticketTitle} numberOfLines={2}>
                  {t.title || "(no title)"}
                </Text>
                <View
                  style={[
                    styles.statusBadge,
                    t.status === "open"
                      ? styles.statusOpen
                      : styles.statusResolved,
                  ]}
                >
                  <Text style={styles.statusTxt}>{t.status || "?"}</Text>
                </View>
              </View>
              <Text style={styles.ticketMeta}>
                {t.assigneeName ? `🎫 ${t.assigneeName}` : "(unassigned)"}
                {t.createdAt
                  ? ` · created ${new Date(t.createdAt).toLocaleDateString()}`
                  : ""}
              </Text>
              {t.resolutionNote && (
                <Text style={styles.ticketNote}>{t.resolutionNote}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      {!ferraUser && chatTickets.length === 0 && (
        <View style={styles.empty}>
          <Text style={styles.emptyTxt}>
            No Ferra data for {phone}. This customer isn't in Ferra yet, or
            the data hasn't synced — try the ↻ Ferra refresh from the
            desktop dashboard.
          </Text>
        </View>
      )}

      <View style={styles.bottomPad} />
    </ScrollView>
  );
}

function Chip({ label, accent }: { label: string; accent?: boolean }) {
  return (
    <View style={[styles.chip, accent && styles.chipAccent]}>
      <Text style={[styles.chipTxt, accent && styles.chipTxtAccent]}>
        {label}
      </Text>
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowK}>{k}</Text>
      <Text style={styles.rowV}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  section: {
    backgroundColor: "white",
    padding: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    color: colors.muted,
    marginBottom: space.sm,
  },
  name: { fontSize: 18, fontWeight: "600", color: colors.text },
  subline: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
    marginBottom: space.sm,
  },
  sublineRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    marginTop: 2,
    marginBottom: space.sm,
  },
  phoneLink: {
    fontSize: 13,
    color: "#1d4ed8",
    textDecorationLine: "underline",
    fontWeight: "500",
  },
  sublineMuted: {
    fontSize: 13,
    color: colors.muted,
  },
  pillRow: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  pillCustomer: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: "#d1fae5",
  },
  pillActive: { backgroundColor: "#d1fae5" },
  pillCancelled: { backgroundColor: "#fee2e2" },
  pillNeutral: { backgroundColor: "#e5e7eb" },
  pillStage: { backgroundColor: "#dbeafe" },
  pillTxt: { fontSize: 11, fontWeight: "600", color: colors.text },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  chip: {
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  chipAccent: { backgroundColor: "#d1fae5" },
  chipTxt: { fontSize: 12, fontWeight: "600", color: colors.text },
  chipTxtAccent: { color: "#065f46" },
  muted: { fontSize: 12, color: colors.muted },
  row: {
    flexDirection: "row",
    paddingVertical: 4,
    gap: 8,
  },
  rowK: { width: 100, fontSize: 13, color: colors.muted },
  rowV: { flex: 1, fontSize: 13, color: colors.text, flexWrap: "wrap" },
  ticketCard: {
    backgroundColor: "#f9fafb",
    borderRadius: 6,
    padding: 10,
    marginBottom: 8,
  },
  ticketTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 6,
  },
  ticketTitle: {
    flex: 1,
    fontSize: 13,
    fontWeight: "600",
    color: colors.text,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
  },
  statusOpen: { backgroundColor: "#fee2e2" },
  statusResolved: { backgroundColor: "#d1fae5" },
  statusTxt: { fontSize: 10, fontWeight: "600", color: colors.text },
  ticketMeta: { fontSize: 11, color: colors.muted, marginTop: 4 },
  ticketNote: {
    fontSize: 12,
    color: colors.text,
    marginTop: 4,
    fontStyle: "italic",
  },
  notesSection: { backgroundColor: "#fff8e7" },
  noteCard: {
    backgroundColor: "white",
    borderRadius: 6,
    padding: 10,
    marginBottom: 6,
    borderLeftWidth: 3,
    borderLeftColor: "#f59e0b",
  },
  noteTxt: { fontSize: 13, color: colors.text, lineHeight: 18 },
  noteMeta: { fontSize: 10, color: colors.muted, marginTop: 4 },
  notesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  addNoteBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: colors.greenDark,
  },
  addNoteBtnTxt: { color: "white", fontSize: 11, fontWeight: "600" },
  notesEmpty: {
    fontSize: 12,
    color: colors.muted,
    fontStyle: "italic",
    paddingVertical: 4,
  },
  composer: {
    backgroundColor: "white",
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#f0e3a0",
  },
  composerInput: {
    minHeight: 60,
    maxHeight: 140,
    fontSize: 14,
    color: colors.text,
    padding: 6,
    textAlignVertical: "top",
  },
  composerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
  },
  composerBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  composerBtnTxt: { color: colors.muted, fontSize: 13 },
  micBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.greenDark,
    alignItems: "center",
    justifyContent: "center",
  },
  micBtnRecording: { backgroundColor: "#dc2626" },
  micBtnTxt: { color: "white", fontSize: 16 },
  sendBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.green,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: { backgroundColor: "#8fb3a8" },
  sendBtnTxt: { color: "white", fontSize: 16 },
  address: { fontSize: 14, color: colors.text, lineHeight: 20 },
  copyBtn: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingVertical: 4,
    paddingHorizontal: 8,
    borderRadius: 4,
    backgroundColor: "#f3f4f6",
  },
  copyBtnTxt: { fontSize: 12, color: colors.muted },
  empty: {
    padding: 24,
    alignItems: "center",
  },
  emptyTxt: { color: colors.muted, fontSize: 13, textAlign: "center" },
  bottomPad: { height: 40 },
});
