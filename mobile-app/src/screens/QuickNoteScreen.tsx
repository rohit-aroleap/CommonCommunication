// Quick-note capture. Voice-first flow:
//   1. Mount → request mic permission → auto-start recorder. Big Stop
//      button + elapsed timer; user dictates whatever they want.
//   2. Tap Stop → Whisper transcription (respects the Settings cleanup
//      toggle, same as the in-chat 📝 mic).
//   3. Review screen: editable transcript on top, customer picker below
//      (recents from chatRows, search filters into the long tail).
//   4. Pick a customer → write to commonComm/chats/{chatKey}/notes (same
//      bucket the in-chat 📝 mic uses; source flag distinguishes origin).
//   5. Confirm + navigation.goBack(): one note per widget tap.
//
// Reached from the 📝 FAB on Chats / Tickets tabs today, and from the
// upcoming home-screen widgets via the `commoncomm://quick-note` deep
// link (App.tsx → linking.config).

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { push, ref, set } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import { useAppData, isDailyGroup } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveDisplayName } from "@/lib/displayName";
import { transcribeAudio } from "@/lib/worker";
import { makeVoiceNoteRecordingOptions } from "@/lib/voiceRecording";
import { normalizeFerraPhone } from "@/lib/ferra";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";

// Lazy require: matches ThreadScreen's pattern so an older native build
// without expo-audio doesn't crash on import. If audio is unavailable the
// screen renders an explanatory state instead of attempting to record.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let audioMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  audioMod = require("expo-audio");
} catch {
  audioMod = null;
}

type Props = NativeStackScreenProps<RootStackParamList, "QuickNote">;

type Phase =
  | "starting" // first render, permission probe in flight
  | "denied" // mic perm denied — show "Open Settings"
  | "recording" // mic capturing
  | "transcribing" // Whisper request in flight
  | "review" // transcript shown, picker visible
  | "saving" // writing to Firebase
  | "unavailable"; // expo-audio not bundled in this native build

export function QuickNoteScreen({ navigation }: Props) {
  if (!audioMod) {
    return <UnavailableState />;
  }
  return <QuickNoteInner navigation={navigation} />;
}

// Separated from the outer component so the expo-audio hooks below are only
// instantiated on builds that actually have the module. Otherwise React
// would error on the hook calls during the unavailable-state render.
function QuickNoteInner({
  navigation,
}: {
  navigation: Props["navigation"];
}) {
  const {
    chatRows,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
    teamPhones,
  } = useAppData();
  const { user } = useAuth();
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);

  const [phase, setPhase] = useState<Phase>("starting");
  const [transcript, setTranscript] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [search, setSearch] = useState("");

  // expo-audio recorder. The hook returns a stable instance per render and
  // exposes record/stop methods + the file URI after stop.
  const recorder = audioMod.useAudioRecorder(
    makeVoiceNoteRecordingOptions(audioMod),
  );
  const recorderState = audioMod.useAudioRecorderState(recorder);
  const isRecording = !!recorderState?.isRecording;

  // Auto-start on mount. Permission probe + recorder.record() happen in
  // sequence; if any step fails we drop into the matching error phase.
  // The cleanup function below stops the recorder on unmount to avoid
  // leaking the mic if the user backs out mid-recording.
  const didStart = useRef(false);
  useEffect(() => {
    if (didStart.current) return;
    didStart.current = true;
    (async () => {
      try {
        const perm = await audioMod.requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setPhase("denied");
          return;
        }
        await audioMod.setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
        });
        await recorder.prepareToRecordAsync();
        recorder.record();
        setPhase("recording");
      } catch (e) {
        Alert.alert(
          "Couldn't start recording",
          String((e as Error)?.message || e),
          [{ text: "OK", onPress: () => navigation.goBack() }],
        );
      }
    })();
    return () => {
      // Best-effort cleanup. If the user leaves the screen while still
      // recording, stop the mic so the next session can grab it cleanly.
      try {
        if (recorder?.stop) recorder.stop().catch(() => {});
      } catch {
        /* swallow */
      }
    };
    // recorder is a stable hook reference; navigation is stable from React
    // Navigation. Run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Elapsed timer driven by a 1s interval rather than recorderState's own
  // duration field, which not every expo-audio version exposes reliably.
  useEffect(() => {
    if (phase !== "recording") return;
    const start = Date.now();
    setElapsed(0);
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [phase]);

  async function onStop() {
    if (!isRecording) return;
    setPhase("transcribing");
    try {
      await recorder.stop();
      const uri = recorder.uri as string | undefined;
      if (!uri) {
        Alert.alert("No audio captured", "Try recording again.");
        setPhase("denied");
        return;
      }
      // No explicit `cleanup` arg → respects the Settings toggle, matches
      // the in-chat 📝 mic.
      const text = await transcribeAudio(uri);
      if (!text) {
        Alert.alert(
          "No speech detected",
          "Try recording again, closer to the mic.",
          [{ text: "OK", onPress: () => navigation.goBack() }],
        );
        return;
      }
      setTranscript(text);
      setPhase("review");
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (msg.startsWith("groq_unauthorized")) {
        Alert.alert(
          "Groq key was rejected",
          "Open Settings to check or replace your Groq API key.",
          [
            { text: "Cancel", style: "cancel", onPress: () => navigation.goBack() },
            {
              text: "Open Settings",
              onPress: () => {
                navigation.goBack();
                navigation.navigate("Settings");
              },
            },
          ],
        );
      } else {
        Alert.alert("Transcription failed", msg, [
          { text: "OK", onPress: () => navigation.goBack() },
        ]);
      }
    }
  }

  // Candidate customers: chatRows already sorted by lastMsgAt desc. We
  // filter out groups (notes are per-customer), DMs-disguised-as-chats
  // (teamPhones), and resolve display names the same way ChatsScreen does
  // so the picker matches what the trainer sees in the chat list.
  const candidates = useMemo(() => {
    return chatRows
      .filter((r) => r.chatType !== "group" && !isDailyGroup(r))
      .filter((r) => !teamPhones.has(r.phone.replace(/\D/g, "")))
      .map((r) => ({
        chatKey: r.chatKey,
        name: resolveDisplayName(
          r.phone,
          r.explicitName,
          { chatType: r.chatType, groupName: r.groupName },
          { habitUsers, cancelledUsers, ferraIndex, contacts },
        ),
        phone: r.phone,
        lastMsgAt: r.lastMsgAt,
        preview: r.preview,
      }));
  }, [
    chatRows,
    teamPhones,
    habitUsers,
    cancelledUsers,
    ferraIndex,
    contacts,
  ]);

  // Recents = top 20 already-sorted candidates. Search broadens to the
  // full list and filters by name or phone substring.
  const visibleList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates.slice(0, 20);
    return candidates.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.phone.toLowerCase().includes(q) ||
        normalizeFerraPhone(c.phone).includes(q),
    );
  }, [candidates, search]);

  async function saveToCustomer(chatKey: string, name: string) {
    const trimmed = transcript.trim();
    if (!trimmed || !user) return;
    setPhase("saving");
    try {
      const noteRef = push(ref(db, `${ROOT}/chats/${chatKey}/notes`));
      await set(noteRef, {
        text: trimmed,
        authorUid: user.uid,
        authorName: user.displayName || user.email || "(me)",
        createdAt: Date.now(),
        source: "mobile-quick-note",
      });
      // Brief confirmation rather than a navigation animation to a
      // separate "saved" screen; matches the lightweight feel of the
      // capture flow.
      Alert.alert("Saved", `Note saved to ${name}.`, [
        { text: "OK", onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      Alert.alert(
        "Couldn't save note",
        String((e as Error)?.message || e),
      );
      setPhase("review");
    }
  }

  // Renderers per phase. Header is shared so Cancel is always available.
  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={10}
          accessibilityLabel="Cancel"
        >
          <Text style={styles.headerCancel}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Quick Note</Text>
        <View style={styles.headerSpacer} />
      </View>

      {phase === "starting" && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.green} />
          <Text style={styles.muted}>Starting microphone…</Text>
        </View>
      )}

      {phase === "denied" && (
        <View style={styles.center}>
          <Text style={styles.bigGlyph}>🎤</Text>
          <Text style={styles.title}>Microphone access denied</Text>
          <Text style={styles.muted}>
            Enable microphone permission for CommonCommunication in your
            phone's Settings, then come back and try again.
          </Text>
          <TouchableOpacity
            style={styles.primaryBtn}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.primaryBtnTxt}>Open Settings</Text>
          </TouchableOpacity>
        </View>
      )}

      {phase === "recording" && (
        <View style={styles.center}>
          <View style={styles.recordingDot} />
          <Text style={styles.recordingLbl}>Recording</Text>
          <Text style={styles.timer}>{formatElapsed(elapsed)}</Text>
          <TouchableOpacity
            style={styles.stopBtn}
            onPress={onStop}
            accessibilityLabel="Stop recording"
          >
            <Text style={styles.stopBtnGlyph}>⏹</Text>
          </TouchableOpacity>
          <Text style={styles.muted}>
            Tap stop when you're done. You'll pick the customer next.
          </Text>
        </View>
      )}

      {phase === "transcribing" && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.green} size="large" />
          <Text style={styles.muted}>Transcribing…</Text>
        </View>
      )}

      {(phase === "review" || phase === "saving") && (
        <FlatList
          data={visibleList}
          keyExtractor={(c) => c.chatKey}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <View style={styles.reviewHead}>
              <Text style={styles.label}>Transcript</Text>
              <TextInput
                style={styles.transcriptInput}
                value={transcript}
                onChangeText={setTranscript}
                multiline
                placeholderTextColor={colors.muted}
                editable={phase === "review"}
              />
              <Text style={[styles.label, { marginTop: space.lg }]}>
                Save to which customer?
              </Text>
              <TextInput
                style={styles.searchInput}
                value={search}
                onChangeText={setSearch}
                placeholder="Search recents — or anyone else"
                placeholderTextColor={colors.muted}
                autoCorrect={false}
                autoCapitalize="none"
                editable={phase === "review"}
              />
              {!search && (
                <Text style={styles.sectionHint}>
                  Recent customers
                </Text>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[
                styles.customerRow,
                phase === "saving" && styles.customerRowDimmed,
              ]}
              onPress={() => saveToCustomer(item.chatKey, item.name)}
              disabled={phase === "saving" || !transcript.trim()}
              activeOpacity={0.6}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarTxt}>
                  {(item.name?.[0] || "?").toUpperCase()}
                </Text>
              </View>
              <View style={styles.col}>
                <Text style={styles.customerName} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={styles.customerPreview} numberOfLines={1}>
                  {item.preview || item.phone}
                </Text>
              </View>
              {item.lastMsgAt > 0 && (
                <Text style={styles.customerTime}>
                  {formatRelative(item.lastMsgAt)}
                </Text>
              )}
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.muted}>
                {search
                  ? "No customers match that search."
                  : "No customers yet."}
              </Text>
            </View>
          }
          ListFooterComponent={
            phase === "saving" ? (
              <View style={styles.savingFoot}>
                <ActivityIndicator size="small" color={colors.green} />
                <Text style={styles.muted}> Saving…</Text>
              </View>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

function UnavailableState() {
  const styles = useStyles(makeStyles);
  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.center}>
        <Text style={styles.bigGlyph}>🎤</Text>
        <Text style={styles.title}>Voice notes not available</Text>
        <Text style={styles.muted}>
          This build doesn't include the audio module. Update the app from
          TestFlight / Play Store and try again.
        </Text>
      </View>
    </SafeAreaView>
  );
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function formatRelative(ts: number): string {
  if (!ts) return "";
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const hr = Math.floor(diffMin / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(ts);
  return date.toLocaleDateString([], { day: "2-digit", month: "short" });
}

const DM_BLUE = "#3b82f6";

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      backgroundColor: colors.header,
    },
    headerCancel: { color: "white", fontSize: 15 },
    headerTitle: { color: "white", fontSize: 16, fontWeight: "600" },
    headerSpacer: { width: 56 },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: space.lg,
      gap: space.md,
    },
    bigGlyph: { fontSize: 56 },
    title: {
      fontSize: 16,
      fontWeight: "600",
      color: colors.text,
      textAlign: "center",
    },
    muted: {
      fontSize: 13,
      color: colors.muted,
      textAlign: "center",
      lineHeight: 18,
    },
    primaryBtn: {
      backgroundColor: colors.green,
      paddingHorizontal: 20,
      paddingVertical: 12,
      borderRadius: 22,
      marginTop: space.md,
    },
    primaryBtnTxt: { color: "white", fontWeight: "600", fontSize: 14 },
    recordingDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: "#dc2626",
    },
    recordingLbl: {
      fontSize: 13,
      color: "#dc2626",
      fontWeight: "600",
      letterSpacing: 0.5,
    },
    timer: {
      fontSize: 44,
      fontWeight: "300",
      color: colors.text,
      fontVariant: ["tabular-nums"],
    },
    stopBtn: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: "#dc2626",
      alignItems: "center",
      justifyContent: "center",
      marginTop: space.md,
      ...Platform.select({
        ios: {
          shadowColor: "#dc2626",
          shadowOpacity: 0.4,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        },
        android: { elevation: 6 },
      }),
    },
    stopBtnGlyph: { fontSize: 40, color: "white" },
    reviewHead: { padding: space.md, gap: space.xs },
    label: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.muted,
      letterSpacing: 0.6,
    },
    transcriptInput: {
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.text,
      minHeight: 100,
      maxHeight: 240,
      textAlignVertical: "top",
    },
    searchInput: {
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 22,
      paddingHorizontal: 14,
      paddingVertical: 10,
      fontSize: 14,
      color: colors.text,
    },
    sectionHint: {
      fontSize: 11,
      color: colors.muted,
      letterSpacing: 0.4,
      marginTop: space.sm,
      marginLeft: 2,
      fontWeight: "600",
    },
    customerRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: space.md + 2,
      paddingVertical: space.sm + 2,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: space.md,
      backgroundColor: colors.panel,
      minHeight: 62,
    },
    customerRowDimmed: { opacity: 0.4 },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: DM_BLUE,
      alignItems: "center",
      justifyContent: "center",
    },
    avatarTxt: { color: "white", fontSize: 16, fontWeight: "500" },
    col: { flex: 1, minWidth: 0 },
    customerName: { fontSize: 15, fontWeight: "500", color: colors.text },
    customerPreview: { fontSize: 12, color: colors.muted, marginTop: 2 },
    customerTime: { fontSize: 11, color: colors.muted, marginLeft: 8 },
    empty: { padding: 40, alignItems: "center" },
    savingFoot: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      padding: space.md,
    },
  });
}
