// Customer info — opened by tapping the name in the Thread header.
// Mirrors the right-side drawer on the desktop dashboard: subscription stage,
// habit metrics, acquisition source, ticket history. Read-only for now.

import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { Modal } from "react-native";
import { onValue, push, ref, set } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import { useAppData, openTicketsForChat } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { chatKeyToChatId } from "@/lib/encodeKey";
import { getFerraUserByPhone, normalizeFerraPhone } from "@/lib/ferra";
import {
  formatPhoneDisplay,
  normalizePhone,
  samePhone,
} from "@/lib/normalizePhone";
import { transcribeAudio } from "@/lib/worker";
import {
  makeSaRecordingOptions,
  makeVoiceNoteRecordingOptions,
} from "@/lib/voiceRecording";
// v1.249: local-only SA flow. File stays on the tablet (in documentDirectory),
// queue retries the worker call until it succeeds.
import * as FileSystem from "expo-file-system/legacy";
import {
  addToQueue as addSaToQueue,
  generateClientSessionId,
  kickProcessor as kickSaProcessor,
} from "@/lib/saTranscriptionQueue";
import { FERRA_TAG_STAGE } from "@/config";
import type { FerraSubscription, Ticket } from "@/types";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";

// Lazy require for expo-audio so an older native build (one that doesn't
// yet have the audio module bundled) doesn't crash on import. Mic button
// is rendered as a separate sub-component only when this module loads —
// hooks always run unconditionally inside that sub-component, so React's
// rules-of-hooks stay happy.
// Typed as `any` because TypeScript can't resolve expo-audio types until
// the package is installed (the v1.115 swap from expo-av → expo-audio).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let audioMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  audioMod = require("expo-audio");
} catch {
  audioMod = null;
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

export function CustomerInfoScreen({ route, navigation }: Props) {
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
    subsByPhone,
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

  // v1.243 (Phase E mobile): list of subscriptions this phone belongs
  // to. Built once per render off the reverse index in AppDataContext.
  // Empty when the phone doesn't match any Ferra subscription — the
  // panel below hides itself in that case.
  const mySubs = useMemo(() => {
    const np = normalizePhone(phone);
    if (!np) return [];
    return subsByPhone.get(np) || [];
  }, [phone, subsByPhone]);

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

  // v1.236: SA sessions for this customer. Same Firebase node the
  // desktop SA Sessions panel reads from (chats/{chatKey}/saSessions),
  // so any session created from either surface shows up everywhere
  // without further sync work. Status field flips queued → transcribing
  // → ready/failed via the worker's background job — onValue picks each
  // update up in real time.
  const [saSessions, setSaSessions] = useState<
    Array<{
      id: string;
      audioUrl?: string | null;
      audioFileName?: string;
      sizeBytes?: number;
      durationSec?: number | null;
      sessionAt?: number;
      uploadedAt?: number;
      uploadedByName?: string | null;
      status?: string;
      transcript?: string;
      transcriptError?: string;
      multipart?: { totalChunks?: number; uploadedChunks?: number };
    }>
  >([]);
  useEffect(() => {
    const saRef = ref(db, `${ROOT}/chats/${chatKey}/saSessions`);
    const unsub = onValue(saRef, (snap) => {
      const v = snap.val() || {};
      const list = Object.entries(
        v as Record<string, Record<string, unknown>>,
      )
        .filter(([, s]) => s && !s.placeholder)
        .map(([id, s]) => ({ id, ...s } as (typeof saSessions)[number]));
      list.sort(
        (a, b) =>
          (b.sessionAt || b.uploadedAt || 0) - (a.sessionAt || a.uploadedAt || 0),
      );
      setSaSessions(list);
    });
    return unsub;
  }, [chatKey]);

  // SA recording modal visibility + upload state. Recording itself lives
  // inside the modal component so the recorder lifecycle is bounded by
  // the modal mount — no zombie recorders when the trainer navigates
  // away mid-session.
  const [saModalOpen, setSaModalOpen] = useState(false);
  const [saUploading, setSaUploading] = useState(false);

  // Add-note state machine.
  //   composing    — input box is open (otherwise just the "+ Add note" trigger)
  //   transcribing — uploading the recorded audio to /transcribe
  //   saving       — writing the final note to Firebase
  // The "recording" flag lives inside the MicButton sub-component since it's
  // tied to the expo-audio hook lifecycle.
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);

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
    setDraft("");
    setComposing(false);
  }

  // Called by the MicButton sub-component once recording stops + a URI is
  // ready. transcribeAudio handles the Groq-vs-Worker branching internally
  // (v1.133). Appends to draft so the trainer can type + dictate together.
  async function onTranscribe(uri: string) {
    setTranscribing(true);
    try {
      const text = await transcribeAudio(uri);
      setDraft((prev) => (prev ? prev + " " + text : text).trim());
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg.startsWith("groq_unauthorized")) {
        Alert.alert(
          "Groq key was rejected",
          "Open Settings to check or replace your Groq API key.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Open Settings",
              onPress: () => navigation.navigate("Settings"),
            },
          ],
        );
      } else {
        Alert.alert("Transcription failed", msg);
      }
    } finally {
      setTranscribing(false);
    }
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
              <Text style={[styles.pillTxt, styles.pillTxtActive]}>
                Customer
              </Text>
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
              <Text
                style={[
                  styles.pillTxt,
                  isActive
                    ? styles.pillTxtActive
                    : isCancelled
                      ? styles.pillTxtCancelled
                      : styles.pillTxtNeutral,
                ]}
              >
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
              <Text style={[styles.pillTxt, styles.pillTxtStage]}>
                {subTag}
              </Text>
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

      {/* v1.236: Strength Assessment recording section. Tap "Start SA
          Recording" → full-screen modal records audio (background-safe),
          uploads on stop to the worker's /sa-upload endpoint. The list
          below mirrors the desktop SA Sessions panel — same Firebase
          node, same status states. Hidden in group chats since SAs are
          per-customer, not per-group. */}
      {/* v1.243 (Phase E mobile): subscription-siblings panel — mirrors
          the v1.242 web build. Shows one card per Ferra subscription
          this phone is on, with the OTHER members listed as tappable
          rows that navigate to that person's chat (or create a fresh
          chatMeta record + open if no thread exists yet). Hidden when
          the phone doesn't match any subscription. */}
      {!isGroup && mySubs.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>
            👥 SUBSCRIPTION MEMBERS
          </Text>
          {mySubs.map((sub, i) => (
            <SubSiblingCard
              key={sub._subId || `sub-${i}`}
              sub={sub}
              currentPhone={phone}
              onOpenMember={(targetPhone, targetName) =>
                openOrCreateChatForPhone(
                  targetPhone,
                  targetName,
                  navigation,
                )
              }
            />
          ))}
        </View>
      )}

      {!isGroup && audioMod && (
        <View style={styles.section}>
          <View style={styles.notesHeader}>
            <Text style={styles.sectionTitle}>
              🎙️ STRENGTH ASSESSMENT ({saSessions.length})
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setSaModalOpen(true)}
            style={styles.saStartBtn}
            disabled={saUploading}
            accessibilityLabel="Start strength assessment recording"
          >
            {saUploading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.saStartBtnTxt}>▶ Start SA Recording</Text>
            )}
          </TouchableOpacity>
          {saSessions.length === 0 ? (
            <Text style={styles.saEmpty}>
              No sessions yet. Tap to record this customer's first SA.
            </Text>
          ) : (
            saSessions.map((s) => <SaSessionRow key={s.id} session={s} />)
          )}
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
                  : "Type a note, or tap 🎤 to dictate"
              }
              placeholderTextColor={colors.muted}
              multiline
              editable={!transcribing && !saving}
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
              {/* Mic moved to the thread composer in v1.116 — single
                  affordance for voice notes, used from inside any chat.
                  Customer Info keeps a text-only add-note flow for when
                  trainers prefer to type a longer note in one go. */}
              <TouchableOpacity
                onPress={saveNote}
                style={[
                  styles.sendBtn,
                  (!draft.trim() || saving) && styles.sendBtnDisabled,
                ]}
                disabled={!draft.trim() || saving || transcribing}
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

      {/* v1.236: SA recording modal. Mounted at the end of the
          ScrollView (above it in the visual stack via Modal's portal).
          Only rendered when expo-audio loaded — old binaries skip the
          whole feature instead of crashing on the require. */}
      {audioMod && (
        <Modal
          visible={saModalOpen}
          animationType="slide"
          onRequestClose={() => {
            // Android hardware-back close. Disabled while uploading so
            // the trainer can't accidentally lose the recording.
            if (!saUploading) setSaModalOpen(false);
          }}
        >
          <SaRecorderModal
            chatKey={chatKey}
            customerName={displayName}
            uploadedByUid={user?.uid || ""}
            uploadedByName={user?.displayName || user?.email || ""}
            onClose={() => setSaModalOpen(false)}
            onUploadStart={() => setSaUploading(true)}
            onUploadEnd={() => setSaUploading(false)}
          />
        </Modal>
      )}
    </ScrollView>
  );
}

// MicButton — only mounted when expo-audio loaded at module init. Because
// it's only rendered conditionally at the call site (audioMod && <MicButton/>),
// React's rules-of-hooks is satisfied: when MicButton renders, its hooks
// always run; when audioMod is null, the component never mounts at all.
// Tap once → start recording (button turns red, becomes ⏹).
// Tap again → stop + invoke onTranscribe(uri) with the captured audio file.
function MicButton({
  onTranscribe,
  transcribing,
  disabled,
}: {
  onTranscribe: (uri: string) => Promise<void>;
  transcribing: boolean;
  disabled: boolean;
}) {
  const styles = useStyles(makeStyles);
  // Whisper-tuned options: 16 kHz mono AAC @ 32 kbps. ~8× smaller upload
  // than HIGH_QUALITY with no transcription accuracy loss.
  const recorder = audioMod.useAudioRecorder(
    makeVoiceNoteRecordingOptions(audioMod),
  );
  const recorderState = audioMod.useAudioRecorderState(recorder);
  const isRecording = !!recorderState?.isRecording;

  // True once the recorder has been prepared and can call .record() instantly
  // without first awaiting prepareToRecordAsync. Prepared on mount and re-
  // prepared in the background after every stop.
  const preparedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const perm = await audioMod.getRecordingPermissionsAsync?.();
        if (cancelled) return;
        if (perm && !perm.granted) return;
        await recorder.prepareToRecordAsync();
        if (!cancelled) preparedRef.current = true;
      } catch {
        /* swallow — toggle() will redo the full prepare on first tap */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorder]);

  async function toggle() {
    if (transcribing || disabled) return;
    if (isRecording) {
      try {
        await recorder.stop();
        // Re-prepare in the background so the *next* tap is instant. This
        // overlaps with the upload/transcribe roundtrip happening below.
        preparedRef.current = false;
        recorder
          .prepareToRecordAsync()
          .then(() => {
            preparedRef.current = true;
          })
          .catch(() => {});
        const uri = recorder.uri as string | undefined;
        if (uri) await onTranscribe(uri);
      } catch (e) {
        Alert.alert(
          "Couldn't stop recording",
          String((e as Error)?.message || e),
        );
      }
      return;
    }

    // Fast path: recorder already prepared. record() with no awaits in front.
    if (preparedRef.current) {
      try {
        recorder.record();
        return;
      } catch {
        preparedRef.current = false;
      }
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
      preparedRef.current = true;
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
      style={[styles.micBtn, isRecording && styles.micBtnRecording]}
      disabled={transcribing || disabled}
      accessibilityLabel={isRecording ? "Stop recording" : "Record voice note"}
    >
      {transcribing ? (
        <ActivityIndicator color="white" size="small" />
      ) : (
        <Text style={styles.micBtnTxt}>{isRecording ? "⏹" : "🎤"}</Text>
      )}
    </TouchableOpacity>
  );
}

function Chip({ label, accent }: { label: string; accent?: boolean }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.chip, accent && styles.chipAccent]}>
      <Text style={[styles.chipTxt, accent && styles.chipTxtAccent]}>
        {label}
      </Text>
    </View>
  );
}

// v1.243 (Phase E mobile): one card per Ferra subscription this phone
// is on. Shows the plan tier, holder vs member badge, current step,
// and a tappable list of OTHER members. Mirrors the web v1.242 layout
// in feature parity if not pixel-perfect.
function SubSiblingCard({
  sub,
  currentPhone,
  onOpenMember,
}: {
  sub: FerraSubscription;
  currentPhone: string;
  onOpenMember: (phone: string, name: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const isHolder = samePhone(sub.customerPhone, currentPhone);

  // Collect every OTHER member on this subscription (i.e., everyone
  // except the phone whose chat the trainer is currently viewing). The
  // customerPhone is included when it's not the current phone, because
  // for a member viewing their card, the HOLDER is "another member"
  // worth surfacing.
  const others: Array<{ phone: string; name: string; isHolder: boolean }> = [];
  if (sub.customerPhone && !samePhone(sub.customerPhone, currentPhone)) {
    const cp = normalizePhone(sub.customerPhone);
    if (cp) {
      others.push({
        phone: cp,
        name: sub.customerName || "",
        isHolder: true,
      });
    }
  }
  const phones = sub.memberPhones || [];
  const names = sub.memberNames || [];
  for (let i = 0; i < phones.length; i++) {
    const p = normalizePhone(phones[i]);
    if (!p) continue;
    if (samePhone(p, currentPhone)) continue;
    if (others.some((o) => o.phone === p)) continue;
    others.push({
      phone: p,
      name: names[i] || "",
      isHolder: false,
    });
  }

  const planLabel = sub.planTier
    ? String(sub.planTier).replace(/_/g, " ")
    : "subscription";
  const stepLabel = sub.currentStep
    ? String(sub.currentStep).replace(/_/g, " ")
    : "";

  return (
    <View style={styles.subCard}>
      <View style={styles.subCardHead}>
        <Text style={styles.subTier}>{planLabel}</Text>
        <View
          style={[
            styles.subPill,
            isHolder ? styles.subPillHolder : styles.subPillMember,
          ]}
        >
          <Text
            style={[
              styles.subPillTxt,
              isHolder
                ? styles.subPillTxtHolder
                : styles.subPillTxtMember,
            ]}
          >
            {isHolder ? "you are the holder" : "you are a member"}
          </Text>
        </View>
      </View>
      {stepLabel ? (
        <Text style={styles.subStepLine}>{stepLabel}</Text>
      ) : null}
      {!isHolder && sub.customerName ? (
        <Text style={styles.subHolderLine}>
          Holder: <Text style={{ fontWeight: "700" }}>{sub.customerName}</Text>
        </Text>
      ) : null}

      <Text style={styles.subSectionLabel}>OTHER MEMBERS</Text>
      {others.length === 0 ? (
        <Text style={styles.subEmpty}>No other members on this subscription.</Text>
      ) : (
        others.map((o, i) => (
          <TouchableOpacity
            key={`${o.phone}-${i}`}
            onPress={() => onOpenMember(o.phone, o.name)}
            style={styles.subMemberRow}
            accessibilityLabel={`Open chat with ${o.name || o.phone}`}
          >
            <Text style={styles.subMemberPhone}>
              {formatPhoneDisplay(o.phone)}
            </Text>
            {o.name ? (
              <Text style={styles.subMemberName}> — {o.name}</Text>
            ) : null}
            {o.isHolder ? (
              <View style={[styles.subPill, styles.subPillHolder, { marginLeft: 6 }]}>
                <Text style={[styles.subPillTxt, styles.subPillTxtHolder]}>
                  holder
                </Text>
              </View>
            ) : null}
          </TouchableOpacity>
        ))
      )}
    </View>
  );
}

// v1.243 (Phase E mobile): open another customer's chat (creating the
// chatMeta record if no thread exists yet). Mirrors the v1.242 web
// build's openOrCreateChatForPhone — same logic, same chat-key
// encoding rules. Returns Promise so caller can await if needed.
async function openOrCreateChatForPhone(
  rawPhone: string,
  knownName: string,
  navigation: NativeStackScreenProps<RootStackParamList, "CustomerInfo">["navigation"],
): Promise<void> {
  const np = normalizePhone(rawPhone);
  if (!np) return;
  const targetChatId = `${np}@c.us`;
  const targetChatKey = targetChatId.replace(/[.#$[\]/]/g, "_");

  // Quick sanity peek for an existing chatMeta record. If it exists,
  // straight push to Thread. If not, prompt — same UX as web — and
  // write the meta first so the chat list lights up immediately.
  const metaRef = ref(db, `${ROOT}/chats/${targetChatKey}/meta`);
  try {
    const snap = await new Promise<{ exists: boolean }>((resolve, reject) => {
      const unsub = onValue(
        metaRef,
        (s) => {
          unsub();
          resolve({ exists: s.exists() });
        },
        (err) => {
          unsub();
          reject(err);
        },
      );
    });
    const label = knownName
      ? `${knownName} (${formatPhoneDisplay(np)})`
      : formatPhoneDisplay(np);
    if (snap.exists) {
      navigation.push("Thread", {
        chatKey: targetChatKey,
        initialTitle: knownName || undefined,
      });
      return;
    }
    Alert.alert(
      "Start a new chat?",
      `No existing chat with ${label}. Start one now?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start chat",
          onPress: async () => {
            try {
              await set(ref(db, `${ROOT}/chats/${targetChatKey}/meta`), {
                chatId: targetChatId,
                phone: np,
                displayName: knownName || null,
                contactName: knownName || null,
                lastMsgAt: Date.now(),
                lastMsgPreview: "(opened via subscription siblings)",
                lastMsgDirection: "out",
              });
              navigation.push("Thread", {
                chatKey: targetChatKey,
                initialTitle: knownName || undefined,
              });
            } catch (e) {
              Alert.alert(
                "Couldn't open chat",
                String((e as Error)?.message || e),
              );
            }
          },
        },
      ],
    );
  } catch (e) {
    Alert.alert(
      "Couldn't open chat",
      String((e as Error)?.message || e),
    );
  }
}

function Row({ k, v }: { k: string; v: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.rowK}>{k}</Text>
      <Text style={styles.rowV}>{v}</Text>
    </View>
  );
}

// v1.236: Compact status pill + transcript row for a single SA session,
// rendered in the customer-info SA Sessions section. Matches the
// desktop SA Sessions panel visually so trainers see the same shape on
// both surfaces.
function SaSessionRow({
  session,
}: {
  session: {
    id: string;
    audioFileName?: string;
    sizeBytes?: number;
    durationSec?: number | null;
    sessionAt?: number;
    uploadedAt?: number;
    uploadedByName?: string | null;
    status?: string;
    transcript?: string;
    transcriptError?: string;
    // v1.250: Dropbox auto-backup fields populated by worker after
    // /sa-transcribe-local completes the off-tablet upload.
    dropboxShareUrl?: string | null;
    dropboxError?: string | null;
  };
}) {
  const styles = useStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const s = session;
  const dateStr = (() => {
    const ts = s.sessionAt || s.uploadedAt;
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleString();
  })();
  const dur = s.durationSec
    ? `${Math.floor(s.durationSec / 60)}m ${Math.round(s.durationSec % 60)}s`
    : "";
  const sizeMB = s.sizeBytes ? `${(s.sizeBytes / 1024 / 1024).toFixed(1)} MB` : "";
  const meta = [dur, sizeMB].filter(Boolean).join(" · ");
  const status = String(s.status || "");
  const isReady = status === "ready" && s.transcript;
  const isFailed = status === "failed";
  const isInProgress =
    !isReady && !isFailed && status !== "";
  let pillBg = "#e5e7eb", pillFg = "#374151", pillLabel = status || "—";
  if (isReady) { pillBg = "#d1fae5"; pillFg = "#065f46"; pillLabel = "✓ ready"; }
  else if (isFailed) { pillBg = "#fee2e2"; pillFg = "#991b1b"; pillLabel = "✕ failed"; }
  else if (status.startsWith("uploading")) { pillBg = "#fef3c7"; pillFg = "#92400e"; pillLabel = status; }
  else if (status.startsWith("transcribing")) { pillBg = "#dbeafe"; pillFg = "#1e3a8a"; pillLabel = status; }
  else if (status === "queued") { pillBg = "#fef3c7"; pillFg = "#92400e"; pillLabel = "queued"; }
  return (
    <View style={styles.saRow}>
      <View style={styles.saRowHead}>
        <Text style={styles.saRowDate}>{dateStr || s.audioFileName || "Session"}</Text>
        <View style={[styles.saPill, { backgroundColor: pillBg }]}>
          <Text style={[styles.saPillTxt, { color: pillFg }]}>{pillLabel}</Text>
        </View>
      </View>
      {meta ? <Text style={styles.saRowMeta}>{meta}</Text> : null}
      {s.uploadedByName ? (
        <Text style={styles.saRowMeta}>by {s.uploadedByName}</Text>
      ) : null}
      {/* v1.250: Dropbox link (populated by worker after Dropbox upload). */}
      {s.dropboxShareUrl ? (
        <TouchableOpacity
          onPress={() => Linking.openURL(s.dropboxShareUrl!).catch(() => {})}
        >
          <Text style={[styles.saLink, { marginTop: 2 }]}>
            🗂️ Open in Dropbox
          </Text>
        </TouchableOpacity>
      ) : s.dropboxError ? (
        <Text style={[styles.saRowMeta, { color: "#d9534f" }]}>
          ⚠ Dropbox backup failed
        </Text>
      ) : null}
      {isReady && s.transcript ? (
        expanded ? (
          <>
            <Text style={styles.saTranscript} selectable>
              {s.transcript}
            </Text>
            <View style={{ flexDirection: "row", gap: 12, marginTop: 6 }}>
              <TouchableOpacity onPress={() => setExpanded(false)}>
                <Text style={styles.saLink}>▲ Hide</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={async () => {
                  await Clipboard.setStringAsync(s.transcript || "");
                  Alert.alert("Copied transcript");
                }}
              >
                <Text style={styles.saLink}>📋 Copy</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <Text style={styles.saTranscriptPreview} numberOfLines={2}>
              {s.transcript}
            </Text>
            <TouchableOpacity onPress={() => setExpanded(true)}>
              <Text style={styles.saLink}>▼ Show full transcript</Text>
            </TouchableOpacity>
          </>
        )
      ) : null}
      {isFailed ? (
        <Text style={styles.saError}>
          {s.transcriptError || "Transcription failed."}
        </Text>
      ) : null}
      {isInProgress ? (
        <Text style={styles.saRowMeta}>
          ⏳ {status.startsWith("uploading")
            ? "Uploading…"
            : status.startsWith("transcribing")
              ? "Transcribing — usually ~30s per minute of audio."
              : "Queued…"}
        </Text>
      ) : null}
    </View>
  );
}

// v1.251: filesystem-safe name sanitizer for the SA folder/filename
// pattern. Strips ONLY characters illegal on Windows / macOS / Linux /
// Dropbox: / \ : * ? " < > |. Preserves spaces, hyphens, parentheses,
// AND any Unicode letters (so Hindi/Kannada/accented Latin customer
// names survive into the file path). Caps at 80 chars to keep paths
// from blowing the 255-byte filesystem limit.
function sanitizeNameForFs(s: string): string {
  return String(s || "")
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// v1.236: Full-screen SA recording modal. Owns the expo-audio recorder
// lifecycle — created on mount, torn down on unmount.
//
// v1.251: replaces the auto-split + cloud-storage flow. One continuous
// recording → local persistent storage → AsyncStorage queue → worker
// /sa-transcribe-local → transcript to RTDB + audio backed up to
// Dropbox via worker. See stopAndQueue() for the full Stop→save path.
function SaRecorderModal({
  chatKey,
  customerName,
  uploadedByUid,
  uploadedByName,
  onClose,
  onUploadStart,
  onUploadEnd,
}: {
  chatKey: string;
  customerName: string;
  uploadedByUid: string;
  uploadedByName: string;
  onClose: () => void;
  onUploadStart: () => void;
  onUploadEnd: () => void;
}) {
  const styles = useStyles(makeStyles);
  // The recorder lives for the modal's lifetime. Re-creating it on every
  // start would defeat the prepareToRecordAsync warmup; expo-audio's
  // useAudioRecorder is the right pattern.
  const recorder = audioMod.useAudioRecorder(makeSaRecordingOptions(audioMod));
  const recorderState = audioMod.useAudioRecorderState(recorder);
  const isRecording = !!recorderState?.isRecording;

  const [elapsedSec, setElapsedSec] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<string>("");
  // v1.249: "saving" covers the file-copy + queue-add window between
  // tapping Stop and the modal closing. Brief (sub-second on flash
  // storage), but the spinner lets the trainer know something is
  // happening so they don't double-tap.
  const [saving, setSaving] = useState(false);

  // v1.249: hard cap on recording length. At 24 kbps (the SA bitrate),
  // 130 min = ~23.4 MB, leaving 1.6 MB of slack under Groq's 25 MB
  // single-request transcription limit. If a session is going to run
  // long, the trainer needs to manually stop + start a fresh one.
  const MAX_RECORDING_SEC = 130 * 60;
  // Soft warning at 120 min ("you have 10 minutes left before the
  // recording auto-stops"). Fires once, then noops.
  const SOFT_WARN_SEC = 120 * 60;

  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const softWarnedRef = useRef(false);
  // v1.244: keep a live ref to onClose so the prepare effect can call the
  // latest closure without listing onClose in deps. The parent passes
  // onClose as an inline arrow (`() => setSaModalOpen(false)`), so its
  // reference changes on every parent re-render — including renders
  // triggered by Firebase listener updates while the modal is open. With
  // onClose in deps, the effect re-fires those renders, hitting
  // prepareToRecordAsync on the already-prepared native session and
  // throwing "AudioRecorder has already been prepared".
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Prepare the recorder on mount; request mic permission if needed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const perm = await audioMod.requestRecordingPermissionsAsync();
        if (cancelled) return;
        if (!perm.granted) {
          Alert.alert(
            "Microphone access denied",
            "Enable microphone permission for CommonCommunication in your phone's Settings.",
            [{ text: "OK", onPress: () => onCloseRef.current() }],
          );
          return;
        }
        // staysActiveInBackground keeps the recorder running when the
        // app loses foreground — pairs with UIBackgroundModes audio
        // (iOS) + foreground service (Android, expo-audio handles
        // automatically given the FOREGROUND_SERVICE_MICROPHONE perm).
        await audioMod.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          staysActiveInBackground: true,
        });
        // v1.244: defensive prepare. expo-audio's native AudioRecorder
        // holds session state outside the JS object, so a previous mount
        // (modal closed without explicit stop) can leak a "prepared"
        // session into the next mount's recorder. Catch the specific
        // "already been prepared" error and treat it as success — the
        // recorder is, after all, ready to record, which is what this
        // call was trying to ensure.
        try {
          await recorder.prepareToRecordAsync();
        } catch (e) {
          const msg = String((e as Error)?.message || e);
          if (!msg.toLowerCase().includes("already been prepared")) {
            throw e;
          }
          // else: silently swallow, recorder is good to go.
        }
      } catch (e) {
        if (cancelled) return;
        Alert.alert(
          "Couldn't initialise recorder",
          String((e as Error)?.message || e),
        );
      }
    })();
    return () => {
      cancelled = true;
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      // v1.244: best-effort release on unmount so the native session
      // doesn't outlive the modal. stop() fails if the recorder was
      // never started (i.e. user opened then closed without hitting
      // record) — swallow that, it's expected.
      recorder.stop().catch(() => {});
    };
    // v1.244: deliberately NOT including onClose — see onCloseRef above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recorder]);

  // v1.249: REDESIGNED — local-only recording with persistent queue.
  //
  // Old flow (deleted):
  //   start → tick to 60 min → autoSplit() stops + restarts + uploads
  //   in parallel → race conditions at boundary → silent failures.
  //
  // New flow:
  //   start → tick to MAX_RECORDING_SEC (130 min hard cap) → tick force-stops
  //   if reached → user taps Stop → file copied to documentDirectory →
  //   queued for upload → modal closes → background processor uploads to
  //   /sa-transcribe-local → retries indefinitely on failure → on success,
  //   worker's RTDB write surfaces the transcript via the existing
  //   saSessions onValue listener.
  //
  // Key invariants:
  //   - Audio NEVER leaves the tablet via cloud storage. Source of truth
  //     is the local file in documentDirectory. The worker only sees the
  //     bytes long enough to forward them to Groq for transcription.
  //   - Stop button → modal closes within ~1 second (the file-copy step).
  //     Upload itself happens in the background AFTER modal close.
  //   - Network unavailability at Stop is fine — queue persists across
  //     app restarts and retries with exponential backoff.

  // Start recording. Resets timer, fires recorder.record(), starts the
  // tick that drives the elapsed display + soft-warn + hard-stop at
  // MAX_RECORDING_SEC.
  async function start() {
    try {
      recorder.record();
      startedAtRef.current = Date.now();
      setElapsedSec(0);
      softWarnedRef.current = false;
      tickRef.current = setInterval(() => {
        const t = startedAtRef.current
          ? Math.floor((Date.now() - startedAtRef.current) / 1000)
          : 0;
        setElapsedSec(t);
        if (t >= SOFT_WARN_SEC && !softWarnedRef.current) {
          softWarnedRef.current = true;
          Alert.alert(
            "10 minutes left",
            "Recording will auto-stop at 130 minutes to keep the file under the transcription size limit. If you need to keep recording past then, tap Stop now to save this session and start a fresh one.",
          );
        }
        if (t >= MAX_RECORDING_SEC) {
          // Hard cap reached. Force-stop and save the file to the queue.
          if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
          }
          void stopAndQueue(true);
        }
      }, 1000);
    } catch (e) {
      Alert.alert(
        "Couldn't start recording",
        String((e as Error)?.message || e),
      );
    }
  }

  // Stop the recorder, copy the file to documentDirectory (persistent
  // across app close / OS storage pressure), add the file to the
  // transcription queue. Returns when the file copy + queue-add are
  // done; the actual upload happens asynchronously in the background.
  //
  // If `forcedByMaxCap` is true, also shows an alert explaining why the
  // recording was force-stopped.
  async function stopAndQueue(forcedByMaxCap = false) {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    onUploadStart();
    setSaving(true);
    setUploadStatus("Saving locally…");
    let stopUri: string | undefined;
    try {
      await recorder.stop();
      stopUri = recorder.uri as string | undefined;
    } catch (e) {
      Alert.alert(
        "Couldn't stop recording",
        String((e as Error)?.message || e),
      );
      setSaving(false);
      setUploadStatus("");
      onUploadEnd();
      return;
    }
    if (!stopUri) {
      Alert.alert(
        "Recording didn't capture",
        "The recorder didn't produce an audio file. Please try again, and if this keeps happening let Rohit know.",
      );
      setSaving(false);
      setUploadStatus("");
      onUploadEnd();
      return;
    }

    const clientSessionId = generateClientSessionId();
    const sessionAt = startedAtRef.current || Date.now();

    // v1.251: build the per-customer folder + date-time filename used on
    // BOTH the tablet's documentDirectory AND in Dropbox.
    //   folderName = "{phone} - {customerName}"  (or just "{phone}" when
    //                 customerName is empty / non-Ferra contact)
    //   fileName   = "YYYY-MM-DD HH-MM-SS.m4a"  (tablet's local time)
    const phone = chatKey.split("_")[0].replace(/\D/g, "") || "unknown";
    const cleanName = sanitizeNameForFs(customerName);
    const folderName = cleanName ? `${phone} - ${cleanName}` : phone;
    const d = new Date(sessionAt);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const fileName = `${yyyy}-${mm}-${dd} ${hh}-${min}-${ss}.m4a`;

    const persistentDir = `${FileSystem.documentDirectory}sa-recordings/${folderName}/`;
    const destUri = `${persistentDir}${fileName}`;

    try {
      // Make sure the per-customer directory exists.
      await FileSystem.makeDirectoryAsync(persistentDir, {
        intermediates: true,
      });
      // Move the recorder's cache file into our persistent directory.
      // We use move (not copy) since the cache file is already finalized
      // and we don't need it in two places.
      await FileSystem.moveAsync({ from: stopUri, to: destUri });
    } catch (e) {
      // Fallback: try copy if move failed (some Android variants restrict
      // cross-storage move). If even copy fails, queue the original cache
      // path — risky (could be evicted) but better than data loss.
      try {
        await FileSystem.copyAsync({ from: stopUri, to: destUri });
      } catch (e2) {
        console.warn(
          "[sa-recorder] couldn't persist file, queueing cache path:",
          e,
          e2,
        );
      }
    }

    // Inspect the saved file for size (best-effort; queue accepts null).
    let sizeBytes: number | null = null;
    try {
      const info = await FileSystem.getInfoAsync(destUri);
      if (info.exists && !info.isDirectory) {
        sizeBytes = info.size ?? null;
      }
    } catch {
      /* swallow — purely informational */
    }

    const durationSec = startedAtRef.current
      ? Math.floor((Date.now() - startedAtRef.current) / 1000)
      : null;

    await addSaToQueue({
      clientSessionId,
      chatKey,
      localUri: destUri,
      fileName,
      uploadedByUid,
      uploadedByName,
      durationSec,
      sizeBytes,
      customerName: cleanName || undefined,
      dropboxFolderName: folderName,
      dropboxFileName: fileName,
    });
    kickSaProcessor();

    setSaving(false);
    setUploadStatus("");
    onUploadEnd();

    if (forcedByMaxCap) {
      Alert.alert(
        "Recording auto-stopped at 130 minutes",
        "Saved locally. The transcript will appear in the SA Sessions list once the upload finishes.",
      );
    }
  }

  // User pressed the Stop button — finalize, queue, close the modal.
  async function onStop() {
    await stopAndQueue(false);
    onClose();
  }

  function formatElapsed(sec: number) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return (
    <View style={styles.saModalRoot}>
      <View style={styles.saModalHeader}>
        <Text style={styles.saModalTitle}>Strength Assessment</Text>
        <Text style={styles.saModalSubtitle}>{customerName}</Text>
      </View>

      <View style={styles.saModalBody}>
        <View
          style={[
            styles.saTimerCircle,
            isRecording && styles.saTimerCircleRec,
          ]}
        >
          <Text style={styles.saTimerText}>{formatElapsed(elapsedSec)}</Text>
          <Text style={styles.saTimerLabel}>
            {isRecording ? "● Recording" : saving ? "Saving…" : "Ready"}
          </Text>
        </View>

        {/* v1.249: hint copy updated to reflect the new local-only flow.
            Recording no longer auto-splits — it's one continuous file,
            capped at 130 min, saved locally and transcribed in the
            background once Stop is tapped. */}
        <Text style={styles.saHint}>
          Keep this screen open. Audio keeps recording if the phone locks.
          Stops automatically at 130 minutes if you don't tap Stop first.
        </Text>

        {uploadStatus ? (
          <Text style={styles.saUploadStatus}>{uploadStatus}</Text>
        ) : null}
      </View>

      <View style={styles.saModalActions}>
        {!isRecording && elapsedSec === 0 ? (
          <>
            <TouchableOpacity
              onPress={onClose}
              style={[styles.saActionBtn, styles.saActionBtnSecondary]}
              disabled={saving}
            >
              <Text style={styles.saActionBtnSecondaryTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={start}
              style={[styles.saActionBtn, styles.saActionBtnStart]}
              disabled={saving}
            >
              <Text style={styles.saActionBtnStartTxt}>● Start</Text>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            onPress={() => {
              if (saving) return; // already in the file-copy + queue-add window
              Alert.alert(
                "Stop recording?",
                "The recording will be saved on this tablet and transcribed in the background.",
                [
                  { text: "Keep recording", style: "cancel" },
                  { text: "Stop and save", onPress: onStop },
                ],
              );
            }}
            style={[
              styles.saActionBtn,
              styles.saActionBtnStop,
              saving && { opacity: 0.5 },
            ]}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.saActionBtnStopTxt}>■ Stop and save</Text>
            )}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  section: {
    backgroundColor: colors.panel,
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
  // v1.245: pill text colors are theme-INDEPENDENT and always dark, because
  // the pill backgrounds are always pale (#d1fae5, #fee2e2, #dbeafe). Using
  // the theme's foreground color (colors.text) made the text white in dark
  // mode and invisible against the pale pill background. The web's
  // .pill-sm.status-* / .stage-* classes already use these per-variant
  // dark colors; mobile now matches.
  pillTxt: { fontSize: 11, fontWeight: "600", color: "#065f46" },
  pillTxtActive: { color: "#065f46" },
  pillTxtCancelled: { color: "#991b1b" },
  pillTxtStage: { color: "#1e40af" },
  pillTxtNeutral: { color: "#374151" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 8 },
  chip: {
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
  },
  chipAccent: { backgroundColor: "#d1fae5" },
  // v1.245: same dark-mode bug as pillTxt above — habit chip text was
  // invisible against the pale chip background in dark mode. Hardcoded
  // dark gray (#374151) since the base chip bg is always light gray.
  chipTxt: { fontSize: 12, fontWeight: "600", color: "#374151" },
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
    backgroundColor: colors.bg,
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
  notesSection: { backgroundColor: colors.panel },
  noteCard: {
    backgroundColor: colors.bg,
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
    backgroundColor: colors.green,
  },
  addNoteBtnTxt: { color: "white", fontSize: 11, fontWeight: "600" },
  notesEmpty: {
    fontSize: 12,
    color: colors.muted,
    fontStyle: "italic",
    paddingVertical: 4,
  },
  composer: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
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
    backgroundColor: colors.green,
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
    backgroundColor: colors.bg,
  },
  copyBtnTxt: { fontSize: 12, color: colors.muted },
  empty: {
    padding: 24,
    alignItems: "center",
  },
  emptyTxt: { color: colors.muted, fontSize: 13, textAlign: "center" },
  bottomPad: { height: 40 },

  // v1.236: SA Sessions section + recorder modal styles. Raw px values
  // throughout — `space` from theme.ts is a constants object, not a
  // function. Spacing scale follows the rest of the file (multiples of 4).
  saStartBtn: {
    backgroundColor: colors.green,
    borderRadius: 10,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: "center",
    marginTop: 8,
    marginBottom: 12,
  },
  saStartBtnTxt: {
    color: "white",
    fontWeight: "700",
    fontSize: 15,
  },
  saEmpty: {
    color: colors.muted,
    fontSize: 13,
    fontStyle: "italic",
    marginTop: 4,
  },
  // Individual session row in the list under the Start button.
  saRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingVertical: 10,
  },
  saRowHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  saRowDate: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
    flex: 1,
  },
  saRowMeta: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 4,
  },
  saPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  saPillTxt: {
    fontSize: 10,
    fontWeight: "700",
  },
  saTranscript: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
    padding: 10,
    backgroundColor: colors.bg,
    borderRadius: 8,
  },
  saTranscriptPreview: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 6,
    lineHeight: 17,
  },
  saLink: {
    color: colors.green,
    fontSize: 12,
    fontWeight: "600",
    marginTop: 4,
  },
  saError: {
    color: "#d9534f",
    fontSize: 12,
    marginTop: 6,
  },

  // Recorder modal — full-screen layout: title at top, big timer in
  // the center, action buttons pinned to the bottom safe area.
  saModalRoot: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 32,
  },
  saModalHeader: {
    alignItems: "center",
    marginBottom: 32,
  },
  saModalTitle: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 22,
  },
  saModalSubtitle: {
    color: colors.muted,
    fontSize: 14,
    marginTop: 4,
  },
  saModalBody: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 24,
  },
  saTimerCircle: {
    width: 220,
    height: 220,
    borderRadius: 110,
    borderWidth: 4,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  saTimerCircleRec: {
    borderColor: "#d9534f",
    backgroundColor: "rgba(217, 83, 79, 0.06)",
  },
  saTimerText: {
    color: colors.text,
    fontSize: 48,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  saTimerLabel: {
    color: colors.muted,
    fontSize: 13,
    marginTop: 4,
  },
  saHint: {
    color: colors.muted,
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 32,
    lineHeight: 17,
  },
  saUploadStatus: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "500",
    textAlign: "center",
  },
  saModalActions: {
    flexDirection: "row",
    gap: 16,
    justifyContent: "center",
    paddingTop: 16,
  },
  saActionBtn: {
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 140,
  },
  saActionBtnSecondary: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.border,
  },
  saActionBtnSecondaryTxt: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  saActionBtnStart: {
    backgroundColor: "#d9534f",
  },
  saActionBtnStartTxt: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },
  saActionBtnStop: {
    backgroundColor: colors.text,
  },
  saActionBtnStopTxt: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },

  // v1.243 (Phase E mobile): subscription-siblings panel styles.
  subCard: {
    backgroundColor: colors.bg,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 8,
  },
  subCardHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 4,
  },
  subTier: {
    color: colors.text,
    fontWeight: "700",
    fontSize: 14,
    textTransform: "capitalize",
  },
  subPill: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  subPillHolder: { backgroundColor: "rgba(0,168,132,0.15)" },
  subPillMember: { backgroundColor: "rgba(99,102,241,0.15)" },
  subPillTxt: { fontSize: 10, fontWeight: "700" },
  subPillTxtHolder: { color: colors.green },
  subPillTxtMember: { color: "#4338ca" },
  subStepLine: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2,
  },
  subHolderLine: {
    color: colors.text,
    fontSize: 13,
    marginTop: 4,
  },
  subSectionLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginTop: 10,
    marginBottom: 4,
  },
  subEmpty: {
    color: colors.muted,
    fontSize: 13,
    fontStyle: "italic",
  },
  subMemberRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    paddingVertical: 6,
  },
  subMemberPhone: {
    color: colors.green,
    fontFamily: "Courier",
    fontSize: 13,
  },
  subMemberName: {
    color: colors.text,
    fontSize: 13,
  },
  });
}
