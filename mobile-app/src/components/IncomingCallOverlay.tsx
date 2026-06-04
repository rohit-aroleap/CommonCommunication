// v1.264: incoming-call overlay. Mounted once at App root. Listens to
// /commonComm/calls for any record with status="ringing" AND
// recipientUid === current user. When one appears, shows a full-screen
// modal with Accept / Decline buttons.
//
// Foreground-only for Phase A — if the app is killed or backgrounded
// when the call arrives, the overlay won't fire. Phase B adds FCM
// background-message handler + callkeep to ring the phone natively
// even when the app is closed.

import React, { useEffect, useMemo, useState } from "react";
import {
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from "react-native";
import { onValue, ref } from "firebase/database";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { db } from "@/firebase";
import { ROOT } from "@/config";
import { useAuth } from "@/auth/AuthContext";
import { space, useStyles, type Colors } from "@/theme";
import { updateCallStatus, type CallRecord } from "@/lib/calls";
import type { RootStackParamList } from "@/screens/types";

interface RingingCall extends CallRecord {
  callId: string;
}

export function IncomingCallOverlay() {
  const { user } = useAuth();
  const styles = useStyles(makeStyles);
  const [activeRing, setActiveRing] = useState<RingingCall | null>(null);
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // Listener on the full /commonComm/calls node. With light traffic this
  // is fine — at scale we'd want a query indexed on recipientUid +
  // status, but ten-trainer team isn't that.
  useEffect(() => {
    if (!user) return;
    const unsub = onValue(ref(db, `${ROOT}/calls`), (snap) => {
      const all = (snap.val() || {}) as Record<string, CallRecord>;
      // Find a ringing call targeting me.
      const ringingForMe = Object.entries(all)
        .map(([callId, c]) => ({ ...c, callId }))
        .filter(
          (c) =>
            c.status === "ringing" &&
            c.recipientUid === user.uid &&
            // Don't show calls that started more than 60s ago — likely
            // stale "missed" records the server didn't clean up.
            Date.now() - (c.ringAt || c.createdAt || 0) < 60_000,
        )
        .sort((a, b) => (b.ringAt || 0) - (a.ringAt || 0))[0];
      setActiveRing(ringingForMe || null);
    });
    return () => unsub();
  }, [user]);

  // Vibrate while ringing. Pattern: short buzz, pause, short buzz.
  useEffect(() => {
    if (!activeRing) return;
    const pattern = [0, 600, 600, 600];
    Vibration.vibrate(pattern, true);
    return () => Vibration.cancel();
  }, [activeRing]);

  const callerName = useMemo(() => {
    if (!activeRing) return "";
    return activeRing.initiatorName || "Unknown caller";
  }, [activeRing]);

  async function handleAccept() {
    if (!activeRing) return;
    const callId = activeRing.callId;
    setActiveRing(null);
    Vibration.cancel();
    const res = await updateCallStatus(callId, "accepted");
    if (!res.ok) {
      // Surface but still navigate — the CallScreen has its own status
      // listener and will fall through if accept didn't take.
      console.warn("[incoming-call] accept failed:", res.error);
    }
    navigation.navigate("Call", { callId });
  }

  async function handleDecline() {
    if (!activeRing) return;
    const callId = activeRing.callId;
    setActiveRing(null);
    Vibration.cancel();
    void updateCallStatus(callId, "declined");
  }

  return (
    <Modal
      visible={!!activeRing}
      animationType="slide"
      transparent={false}
      onRequestClose={() => {
        /* Block hardware back during ring — Accept or Decline only */
      }}
    >
      <View style={styles.root}>
        <View style={styles.body}>
          <Text style={styles.label}>Incoming call</Text>
          <Text style={styles.name}>{callerName}</Text>
        </View>
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.btn, styles.btnDecline]}
            onPress={handleDecline}
          >
            <Text style={styles.btnDeclineTxt}>✕ Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnAccept]}
            onPress={handleAccept}
          >
            <Text style={styles.btnAcceptTxt}>✓ Accept</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.bg,
      justifyContent: "space-between",
    },
    body: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      padding: space.lg,
    },
    label: {
      fontSize: 14,
      color: colors.muted,
      marginBottom: 16,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    name: { fontSize: 32, fontWeight: "600", color: colors.text },
    actions: {
      flexDirection: "row",
      gap: 14,
      justifyContent: "center",
      padding: space.lg,
    },
    btn: {
      paddingVertical: 14,
      paddingHorizontal: 22,
      borderRadius: 10,
      minWidth: 140,
      alignItems: "center",
    },
    btnAccept: { backgroundColor: "#16a34a" },
    btnAcceptTxt: { color: "#fff", fontSize: 16, fontWeight: "600" },
    btnDecline: { backgroundColor: "#d9534f" },
    btnDeclineTxt: { color: "#fff", fontSize: 16, fontWeight: "600" },
  });
}
