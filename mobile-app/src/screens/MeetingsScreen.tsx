// v1.256: Meetings tab — mobile parity for the web's Meetings feature.
//
// Constraints: mobile uploads as a single file (no browser-side chunking),
// so recordings are practically capped at ~25 MB (~3 hr at 24 kbps). For
// longer meetings, recommend the web flow. Otherwise the UI mirrors web:
// list of meetings with name, attendees, status, transcript, AI summary,
// edit / delete / generate-summary actions.

import React, { useEffect, useMemo, useState, useRef } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { onValue, ref } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { space, useStyles, useTheme, type Colors } from "@/theme";
import { useAppData } from "@/data/AppDataContext";
import { useAuth } from "@/auth/AuthContext";
import { resolveTeammateName } from "@/lib/teamFilter";
import { makeSaRecordingOptions } from "@/lib/voiceRecording";
import {
  createMeeting,
  uploadMeetingSingleChunk,
  getMeetingDropboxUrl,
  setMeetingDropbox,
  deleteMeeting,
  summarizeMeeting,
} from "@/lib/worker";
import * as FileSystem from "expo-file-system/legacy";

// Lazy expo-audio require so old binaries without it gracefully no-op.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let audioMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  audioMod = require("expo-audio");
} catch {
  /* expo-audio not available in this binary */
}

interface MeetingRecord {
  id: string;
  name?: string;
  attendees?: Array<{ uid: string; name: string; email: string }>;
  startedAt?: number;
  durationSec?: number | null;
  sizeBytes?: number | null;
  status?: string;
  transcript?: string;
  transcriptError?: string | null;
  dropboxShareUrl?: string | null;
  dropboxError?: string | null;
  summary?: string;
  summaryStatus?: string;
  summaryError?: string;
}

export function MeetingsScreen() {
  const styles = useStyles(makeStyles);
  // v1.257: meetings list is admin-only. Anyone can record (the + New
  // button is always available) but the list of past meetings — with
  // transcripts, summaries, Dropbox links — is hidden from non-admins.
  // Matches the web's visibility gate.
  const { user, isAdmin } = useAuth();
  const { teamUsers } = useAppData();
  const [meetings, setMeetings] = useState<Record<string, MeetingRecord>>({});
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [recorderModalOpen, setRecorderModalOpen] = useState(false);

  useEffect(() => {
    const unsub = onValue(ref(db, `${ROOT}/meetings`), (snap) => {
      setMeetings(snap.val() || {});
    });
    return () => unsub();
  }, []);

  const rows: MeetingRecord[] = useMemo(() => {
    // v1.257: non-admins see an empty list. Data is still fetched by
    // Firebase but we never render it. (RTDB rules would be a stronger
    // gate; this is UI-only for now.)
    if (!isAdmin) return [];
    return Object.entries(meetings)
      .map(([id, m]) => ({ id, ...(m as Omit<MeetingRecord, "id">) }))
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }, [meetings, isAdmin]);

  return (
    <SafeAreaView style={styles.root} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>🎤 Meetings</Text>
        <TouchableOpacity
          style={styles.newBtn}
          onPress={() => setNewModalOpen(true)}
        >
          <Text style={styles.newBtnTxt}>+ New</Text>
        </TouchableOpacity>
      </View>
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTxt}>
            {isAdmin
              ? "No meetings yet. Tap + New to record the first one."
              : "Tap + New to record a meeting.\n\nPast meetings are only visible to admins."}
          </Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => <MeetingRow meeting={item} />}
          contentContainerStyle={{ padding: 12 }}
        />
      )}
      <NewMeetingModal
        visible={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        onStartRecording={() => {
          setNewModalOpen(false);
          setRecorderModalOpen(true);
        }}
        teamUsers={teamUsers}
        currentUser={user}
        setRecorderState={setRecorderModalOpen}
      />
    </SafeAreaView>
  );
}

function MeetingRow({ meeting: m }: { meeting: MeetingRecord }) {
  const styles = useStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
  const startedAt = m.startedAt ? new Date(m.startedAt).toLocaleString() : "";
  const dur = m.durationSec
    ? `${Math.floor(m.durationSec / 60)}m ${Math.round(m.durationSec % 60)}s`
    : "";
  const sizeMB = m.sizeBytes
    ? `${(m.sizeBytes / 1024 / 1024).toFixed(1)} MB`
    : "";
  const status = String(m.status || "");
  const isReady = status === "ready" && m.transcript;
  const isFailed = status === "failed";
  let pillBg = "#e5e7eb",
    pillFg = "#374151",
    pillLabel = status || "—";
  if (isReady) {
    pillBg = "#d1fae5";
    pillFg = "#065f46";
    pillLabel = "✓ ready";
  } else if (isFailed) {
    pillBg = "#fee2e2";
    pillFg = "#991b1b";
    pillLabel = "✕ failed";
  } else if (status === "recording") {
    pillBg = "#fef3c7";
    pillFg = "#92400e";
    pillLabel = "● recording";
  } else if (status.startsWith("uploading") || status.startsWith("transcribing")) {
    pillBg = "#dbeafe";
    pillFg = "#1e3a8a";
    pillLabel = status;
  }
  const attendeeNames = (m.attendees || [])
    .map((a) => a?.name || a?.email || "?")
    .join(", ");

  function handleDelete() {
    Alert.alert(
      "Delete meeting?",
      `"${m.name || "this meeting"}" — transcript, Dropbox file, and metadata will be permanently removed.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            const res = await deleteMeeting(m.id);
            if (!res.ok) Alert.alert("Delete failed", res.error || "unknown");
          },
        },
      ],
    );
  }

  async function handleSummarize() {
    const res = await summarizeMeeting(m.id);
    if (!res.ok) Alert.alert("Summary failed", res.error || "unknown");
  }

  return (
    <View style={styles.row}>
      <View style={styles.rowHead}>
        <Text style={styles.rowName} numberOfLines={1}>
          {m.name || "Untitled meeting"}
        </Text>
        <View style={[styles.pill, { backgroundColor: pillBg }]}>
          <Text style={[styles.pillTxt, { color: pillFg }]}>{pillLabel}</Text>
        </View>
        <TouchableOpacity onPress={handleDelete} style={styles.iconBtn}>
          <Text style={styles.iconBtnTxt}>🗑</Text>
        </TouchableOpacity>
      </View>
      <Text style={styles.rowMeta}>
        {[startedAt, dur, sizeMB].filter(Boolean).join(" · ")}
      </Text>
      {attendeeNames ? (
        <Text style={styles.rowMeta}>Attendees: {attendeeNames}</Text>
      ) : null}
      {m.dropboxShareUrl ? (
        <TouchableOpacity
          onPress={() => Linking.openURL(m.dropboxShareUrl!).catch(() => {})}
        >
          <Text style={styles.dropboxLink}>🗂️ Open in Dropbox</Text>
        </TouchableOpacity>
      ) : m.dropboxError ? (
        <Text style={styles.errorTxt}>⚠ Dropbox upload failed</Text>
      ) : null}
      {isReady ? (
        <>
          {m.summaryStatus === "ready" && m.summary ? (
            <View style={styles.summaryBox}>
              <Text style={styles.summaryHead}>✨ Summary</Text>
              <Text style={styles.summaryTxt}>{m.summary}</Text>
              <TouchableOpacity onPress={handleSummarize}>
                <Text style={styles.summaryRetry}>↻ Regenerate</Text>
              </TouchableOpacity>
            </View>
          ) : m.summaryStatus === "generating" ? (
            <Text style={styles.summaryGenerating}>⏳ Generating summary…</Text>
          ) : m.summaryStatus === "failed" ? (
            <Text style={styles.errorTxt}>
              ✕ Summary failed: {m.summaryError}
              <Text onPress={handleSummarize} style={styles.summaryRetry}>
                {"  ↻ Retry"}
              </Text>
            </Text>
          ) : (
            <TouchableOpacity onPress={handleSummarize} style={styles.summaryBtn}>
              <Text style={styles.summaryBtnTxt}>✨ Generate AI summary</Text>
            </TouchableOpacity>
          )}
          {expanded ? (
            <>
              <Text style={styles.transcript} selectable>
                {m.transcript}
              </Text>
              <TouchableOpacity onPress={() => setExpanded(false)}>
                <Text style={styles.toggleLink}>▲ Hide transcript</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <Text style={styles.transcriptPreview} numberOfLines={2}>
                {m.transcript}
              </Text>
              <TouchableOpacity onPress={() => setExpanded(true)}>
                <Text style={styles.toggleLink}>▼ Show full transcript</Text>
              </TouchableOpacity>
            </>
          )}
        </>
      ) : isFailed ? (
        <Text style={styles.errorTxt}>
          {m.transcriptError || "Transcription failed."}
        </Text>
      ) : null}
    </View>
  );
}

function NewMeetingModal({
  visible,
  onClose,
  onStartRecording,
  teamUsers,
  currentUser,
  setRecorderState,
}: {
  visible: boolean;
  onClose: () => void;
  onStartRecording: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  teamUsers: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  currentUser: any;
  setRecorderState: (open: boolean) => void;
}) {
  const styles = useStyles(makeStyles);
  const [name, setName] = useState("");
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Recorder state (replaces the new-meeting form once recording starts).
  const [recording, setRecording] = useState(false);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [meetingName, setMeetingName] = useState("");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [recorderStatus, setRecorderStatus] = useState<string>("");
  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const recorder = useMemo(() => {
    if (!audioMod || !visible) return null;
    return audioMod.useAudioRecorder
      ? null // we'll create via hook below
      : null;
  }, [visible]);

  // expo-audio hook MUST be called unconditionally if the module is loaded.
  // Guard with a defensive check on audioMod.
  const expoRecorder = audioMod?.useAudioRecorder
    ? audioMod.useAudioRecorder(makeSaRecordingOptions(audioMod))
    : null;

  const teamCandidates = useMemo(() => {
    return Object.entries(teamUsers || {})
      .map(([uid, u]) => ({
        uid,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        name: resolveTeammateName(uid, (u as any)?.email),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        email: ((u as any)?.email as string) || "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [teamUsers]);

  async function handleStart() {
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    if (!currentUser) {
      setError("Sign in first.");
      return;
    }
    if (!audioMod || !expoRecorder) {
      setError("Audio recording isn't available in this app build.");
      return;
    }
    setError("");
    setBusy(true);
    try {
      const perm = await audioMod.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError("Microphone permission denied. Enable in phone settings.");
        setBusy(false);
        return;
      }
      const attendees = teamCandidates
        .filter((c) => selectedUids.has(c.uid))
        .map((c) => ({ uid: c.uid, name: c.name, email: c.email }));

      const res = await createMeeting({
        name: name.trim(),
        attendees,
        createdByUid: currentUser.uid,
        createdByName: currentUser.displayName || currentUser.email || "",
      });
      if (!res.ok) {
        setError("Couldn't create meeting: " + res.error);
        setBusy(false);
        return;
      }
      setMeetingId(res.meetingId!);
      setMeetingName(res.name || name);

      // Configure audio session + start recording.
      await audioMod.setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        staysActiveInBackground: true,
      });
      try {
        await expoRecorder.prepareToRecordAsync();
      } catch (e) {
        const msg = String((e as Error)?.message || e);
        if (!msg.toLowerCase().includes("already been prepared")) throw e;
      }
      expoRecorder.record();
      startedAtRef.current = Date.now();
      setElapsedSec(0);
      tickRef.current = setInterval(() => {
        const t = startedAtRef.current
          ? Math.floor((Date.now() - startedAtRef.current) / 1000)
          : 0;
        setElapsedSec(t);
      }, 1000);
      setRecording(true);
      setRecorderStatus("● Recording — keep this screen on");
    } catch (e) {
      setError("Start failed: " + (e as Error)?.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleStop() {
    Alert.alert("Stop recording?", "Upload for transcription.", [
      { text: "Keep recording", style: "cancel" },
      {
        text: "Stop and save",
        onPress: async () => {
          if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
          }
          setRecorderStatus("Finalizing…");
          try {
            await expoRecorder.stop();
          } catch (e) {
            Alert.alert("Stop failed", String((e as Error)?.message || e));
            return;
          }
          const uri = expoRecorder.uri as string | undefined;
          if (!uri || !meetingId) {
            Alert.alert("No recording captured");
            resetState();
            return;
          }
          const durationSec = startedAtRef.current
            ? Math.floor((Date.now() - startedAtRef.current) / 1000)
            : 0;

          // Upload original to Dropbox via temporary link.
          setRecorderStatus("Uploading to Dropbox…");
          try {
            const linkRes = await getMeetingDropboxUrl({
              meetingId,
              fileExt: "m4a",
            });
            if (linkRes.ok && linkRes.url) {
              const fileInfo = await FileSystem.getInfoAsync(uri);
              const fileBytes = await FileSystem.readAsStringAsync(uri, {
                encoding: FileSystem.EncodingType.Base64,
              });
              // POST to Dropbox upload URL with binary body.
              const binary = atob(fileBytes);
              const len = binary.length;
              const buffer = new Uint8Array(len);
              for (let i = 0; i < len; i++) buffer[i] = binary.charCodeAt(i);
              const dbRes = await fetch(linkRes.url, {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: buffer,
              });
              if (dbRes.ok && linkRes.path) {
                await setMeetingDropbox({
                  meetingId,
                  dropboxPath: linkRes.path,
                  sizeBytes:
                    fileInfo.exists && !fileInfo.isDirectory
                      ? fileInfo.size
                      : undefined,
                  durationSec,
                });
              }
            }
          } catch (e) {
            console.warn("[meeting] dropbox upload failed:", e);
          }

          // Upload as single chunk for transcription.
          setRecorderStatus("Uploading for transcription…");
          const upRes = await uploadMeetingSingleChunk({
            meetingId,
            fileUri: uri,
            fileName: `meeting-${meetingId}.m4a`,
          });
          if (!upRes.ok) {
            Alert.alert("Upload failed", upRes.error || "unknown");
          }
          setRecorderStatus("✓ Uploaded. Transcribing in background.");
          setTimeout(() => {
            resetState();
            onClose();
          }, 1500);
        },
      },
    ]);
  }

  function resetState() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setName("");
    setSelectedUids(new Set());
    setError("");
    setBusy(false);
    setRecording(false);
    setMeetingId(null);
    setMeetingName("");
    setElapsedSec(0);
    setRecorderStatus("");
    startedAtRef.current = null;
    setRecorderState(false);
  }

  function formatElapsed(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={() => {
        if (!recording && !busy) {
          resetState();
          onClose();
        }
      }}
    >
      <SafeAreaView style={styles.modalRoot} edges={["top", "bottom"]}>
        {recording ? (
          <View style={styles.recorderRoot}>
            <Text style={styles.recorderName}>{meetingName}</Text>
            <Text style={styles.recorderTimer}>{formatElapsed(elapsedSec)}</Text>
            <Text style={styles.recorderStatus}>{recorderStatus}</Text>
            <TouchableOpacity
              style={styles.stopBtn}
              onPress={handleStop}
            >
              <Text style={styles.stopBtnTxt}>■ Stop and save</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.newRoot}>
            <View style={styles.newHeader}>
              <Text style={styles.newTitle}>New meeting</Text>
              <TouchableOpacity onPress={() => { resetState(); onClose(); }}>
                <Text style={styles.newClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="e.g. Q1 Planning"
              placeholderTextColor="#9ca3af"
            />
            <Text style={styles.label}>Attendees</Text>
            <View style={styles.attendeesList}>
              {teamCandidates.map((c) => {
                const checked = selectedUids.has(c.uid);
                return (
                  <TouchableOpacity
                    key={c.uid}
                    style={styles.attendeeRow}
                    onPress={() => {
                      const next = new Set(selectedUids);
                      if (checked) next.delete(c.uid);
                      else next.add(c.uid);
                      setSelectedUids(next);
                    }}
                  >
                    <Text style={styles.attendeeCheck}>
                      {checked ? "✓" : "○"}
                    </Text>
                    <Text style={styles.attendeeName}>{c.name}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {error ? <Text style={styles.errorTxt}>{error}</Text> : null}
            <TouchableOpacity
              style={[styles.startBtn, busy && { opacity: 0.5 }]}
              onPress={handleStart}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={styles.startBtnTxt}>● Start Recording</Text>
              )}
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    header: {
      flexDirection: "row",
      alignItems: "center",
      padding: space.md,
      backgroundColor: colors.header,
      gap: 12,
    },
    headerTitle: { flex: 1, color: "#fff", fontSize: 18, fontWeight: "600" },
    newBtn: {
      backgroundColor: "#fff",
      paddingHorizontal: 14,
      paddingVertical: 6,
      borderRadius: 16,
    },
    newBtnTxt: { color: colors.header, fontWeight: "600", fontSize: 13 },
    empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
    emptyTxt: { color: colors.muted, fontSize: 13, textAlign: "center" },
    row: {
      backgroundColor: colors.panel,
      borderRadius: 8,
      padding: 12,
      marginBottom: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    rowHead: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
    rowName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.text },
    pill: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
    },
    pillTxt: { fontSize: 10, fontWeight: "600" },
    iconBtn: { padding: 4 },
    iconBtnTxt: { fontSize: 14 },
    rowMeta: { fontSize: 11, color: colors.muted, marginTop: 2 },
    dropboxLink: { fontSize: 12, color: "#16a34a", marginTop: 6 },
    errorTxt: { fontSize: 12, color: "#d9534f", marginTop: 4 },
    transcript: {
      marginTop: 8,
      fontSize: 12,
      color: colors.text,
      backgroundColor: "#f5f5f5",
      padding: 8,
      borderRadius: 6,
      maxHeight: 280,
    },
    transcriptPreview: {
      marginTop: 6,
      fontSize: 12,
      color: colors.muted,
    },
    toggleLink: { fontSize: 11, color: "#16a34a", marginTop: 4 },
    summaryBox: {
      marginTop: 8,
      padding: 10,
      backgroundColor: "#f5f3ff",
      borderLeftWidth: 3,
      borderLeftColor: "#8b5cf6",
      borderRadius: 4,
    },
    summaryHead: { fontSize: 11, fontWeight: "600", color: "#5b21b6", marginBottom: 4 },
    summaryTxt: { fontSize: 12, color: colors.text, lineHeight: 18 },
    summaryRetry: { fontSize: 11, color: "#5b21b6", marginTop: 4 },
    summaryGenerating: {
      marginTop: 8,
      padding: 8,
      backgroundColor: "#dbeafe",
      borderRadius: 6,
      fontSize: 12,
      color: "#1e3a8a",
    },
    summaryBtn: {
      marginTop: 8,
      backgroundColor: "#f5f3ff",
      borderColor: "#ddd6fe",
      borderWidth: 1,
      padding: 8,
      borderRadius: 6,
      alignSelf: "flex-start",
    },
    summaryBtnTxt: { fontSize: 12, color: "#5b21b6" },
    // Modal styles
    modalRoot: { flex: 1, backgroundColor: colors.bg },
    newRoot: { flex: 1, padding: space.md },
    newHeader: { flexDirection: "row", alignItems: "center", marginBottom: 16 },
    newTitle: { flex: 1, fontSize: 20, fontWeight: "600", color: colors.text },
    newClose: { fontSize: 24, color: colors.muted, padding: 4 },
    label: { fontSize: 12, color: colors.muted, marginBottom: 4 },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      padding: 10,
      fontSize: 14,
      color: colors.text,
      backgroundColor: colors.panel,
      marginBottom: 16,
    },
    attendeesList: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      maxHeight: 280,
      marginBottom: 16,
    },
    attendeeRow: {
      flexDirection: "row",
      alignItems: "center",
      padding: 10,
      gap: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    attendeeCheck: { fontSize: 14, color: "#16a34a", width: 18 },
    attendeeName: { fontSize: 13, color: colors.text },
    startBtn: {
      backgroundColor: "#16a34a",
      padding: 14,
      borderRadius: 8,
      alignItems: "center",
      marginTop: 4,
    },
    startBtnTxt: { color: "#fff", fontSize: 14, fontWeight: "600" },
    recorderRoot: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: space.md,
    },
    recorderName: { fontSize: 18, fontWeight: "600", color: colors.text, marginBottom: 24 },
    recorderTimer: {
      fontSize: 56,
      fontWeight: "600",
      color: "#16a34a",
      marginBottom: 16,
    },
    recorderStatus: { fontSize: 12, color: colors.muted, marginBottom: 24, minHeight: 14 },
    stopBtn: {
      backgroundColor: "#d9534f",
      padding: 14,
      borderRadius: 8,
      alignItems: "center",
      minWidth: 200,
    },
    stopBtnTxt: { color: "#fff", fontSize: 14, fontWeight: "600" },
  });
}
