// v1.264: in-call screen. Renders the Daily.co audio call + the
// mute / hang-up controls. Receives the callId via route params and
// drives state from the Firebase /commonComm/calls/{callId} record
// (status flips remote side accepted → in-progress → ended).
//
// Lazy-requires @daily-co/react-native-daily-js so this file doesn't
// crash to require on builds shipped before the SDK was added (e.g.,
// when checking out an older branch).

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { onValue, ref } from "firebase/database";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { space, useStyles, type Colors } from "@/theme";
import { useAuth } from "@/auth/AuthContext";
import { updateCallStatus, type CallRecord } from "@/lib/calls";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { RootStackParamList } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dailyMod: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  dailyMod = require("@daily-co/react-native-daily-js");
} catch {
  /* SDK not in this build — call screen will surface a clear error */
}

type Props = NativeStackScreenProps<RootStackParamList, "Call">;

export function CallScreen({ route, navigation }: Props) {
  const styles = useStyles(makeStyles);
  const { user } = useAuth();
  const { callId } = route.params;
  const [call, setCall] = useState<CallRecord | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [phase, setPhase] = useState<"connecting" | "ringing" | "in-call" | "ended">("connecting");
  const [error, setError] = useState<string | null>(null);
  const callObjectRef = useRef<unknown>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasJoinedRef = useRef(false);

  // Subscribe to the call's RTDB record. Reflects remote side actions —
  // recipient accepted, declined, ended.
  useEffect(() => {
    if (!callId) return;
    const unsub = onValue(ref(db, `${ROOT}/calls/${callId}`), (snap) => {
      const c = snap.val() as CallRecord | null;
      setCall(c);
      if (!c) return;
      // Caller side: when status flips to "accepted", join the room.
      if (c.status === "accepted" && !hasJoinedRef.current) {
        void joinDailyRoom(c.roomUrl);
      }
      // Either side: remote ended the call.
      if (c.status === "ended" || c.status === "declined") {
        setPhase("ended");
        leaveAndCleanup();
      }
    });
    return () => unsub();
  }, [callId]);

  // Decide initial phase based on whether *I* am the caller or recipient.
  useEffect(() => {
    if (!call || !user) return;
    const iAmCaller = call.initiatorUid === user.uid;
    if (iAmCaller && (call.status === "creating" || call.status === "ringing")) {
      setPhase("ringing");
    }
    // Recipient is brought here from IncomingCallOverlay AFTER they tap
    // Accept, so we already know to join immediately.
    if (!iAmCaller && (call.status === "accepted" || call.status === "in-progress")) {
      if (!hasJoinedRef.current) void joinDailyRoom(call.roomUrl);
    }
  }, [call, user]);

  // Elapsed-time ticker — runs once we're in-call.
  useEffect(() => {
    if (phase !== "in-call") return;
    const startedAt = Date.now();
    tickRef.current = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, [phase]);

  // Cleanup on unmount — leave the room + clear timers.
  useEffect(() => {
    return () => {
      leaveAndCleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function joinDailyRoom(roomUrl: string) {
    if (!dailyMod) {
      setError("Call SDK not in this app build. Reinstall the latest APK.");
      return;
    }
    if (hasJoinedRef.current) return;
    hasJoinedRef.current = true;
    try {
      const obj = dailyMod.default
        ? dailyMod.default.createCallObject({
            audioSource: true,
            videoSource: false,
          })
        : dailyMod.createCallObject({
            audioSource: true,
            videoSource: false,
          });
      callObjectRef.current = obj;
      await obj.join({ url: roomUrl });
      setPhase("in-call");
      // Tell the server we're in progress (idempotent — the worker
      // accepts in-progress for either side).
      void updateCallStatus(callId, "in-progress");
    } catch (e) {
      setError(String((e as Error)?.message || e));
      hasJoinedRef.current = false;
    }
  }

  function leaveAndCleanup() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (callObjectRef.current) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (callObjectRef.current as any).leave?.();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (callObjectRef.current as any).destroy?.();
      } catch {
        /* swallow */
      }
      callObjectRef.current = null;
      hasJoinedRef.current = false;
    }
  }

  function handleToggleMute() {
    const obj = callObjectRef.current;
    if (!obj) return;
    const next = !muted;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (obj as any).setLocalAudio?.(!next);
      setMuted(next);
    } catch (e) {
      Alert.alert("Couldn't toggle mute", String((e as Error)?.message || e));
    }
  }

  async function handleHangUp() {
    leaveAndCleanup();
    setPhase("ended");
    await updateCallStatus(callId, "ended");
    navigation.goBack();
  }

  async function handleCancelRinging() {
    // Caller side: while still ringing, "Cancel" = decline-self.
    await updateCallStatus(callId, "ended");
    navigation.goBack();
  }

  const otherName = useMemo(() => {
    if (!call || !user) return "...";
    return call.initiatorUid === user.uid
      ? call.recipientName || "Recipient"
      : call.initiatorName || "Caller";
  }, [call, user]);

  function formatElapsed(sec: number) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <View style={styles.body}>
        <Text style={styles.name}>{otherName}</Text>
        <Text style={styles.status}>
          {phase === "connecting" && "Connecting…"}
          {phase === "ringing" && "Ringing…"}
          {phase === "in-call" && formatElapsed(elapsedSec)}
          {phase === "ended" && "Call ended"}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {phase === "ringing" && (
          <ActivityIndicator
            size="large"
            color="#16a34a"
            style={{ marginTop: 24 }}
          />
        )}
      </View>
      <View style={styles.actions}>
        {phase === "in-call" && (
          <TouchableOpacity
            onPress={handleToggleMute}
            style={[styles.btn, muted && styles.btnMuted]}
          >
            <Text style={styles.btnTxt}>{muted ? "🔇 Unmute" : "🎙 Mute"}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          onPress={phase === "ringing" ? handleCancelRinging : handleHangUp}
          style={[styles.btn, styles.btnEnd]}
        >
          <Text style={styles.btnEndTxt}>☎ Hang up</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.bg },
    body: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: space.lg,
    },
    name: {
      fontSize: 28,
      fontWeight: "600",
      color: colors.text,
      marginBottom: 12,
    },
    status: {
      fontSize: 16,
      color: colors.muted,
      fontVariant: ["tabular-nums"],
    },
    error: {
      marginTop: 24,
      color: "#d9534f",
      fontSize: 13,
      textAlign: "center",
    },
    actions: {
      flexDirection: "row",
      gap: 14,
      justifyContent: "center",
      padding: space.lg,
    },
    btn: {
      paddingVertical: 14,
      paddingHorizontal: 24,
      borderRadius: 10,
      backgroundColor: colors.panel,
      borderWidth: 1,
      borderColor: colors.border,
      minWidth: 130,
      alignItems: "center",
    },
    btnTxt: { color: colors.text, fontSize: 14, fontWeight: "600" },
    btnMuted: { backgroundColor: "#fef3c7" },
    btnEnd: { backgroundColor: "#d9534f", borderColor: "#d9534f" },
    btnEndTxt: { color: "#fff", fontSize: 14, fontWeight: "600" },
  });
}
