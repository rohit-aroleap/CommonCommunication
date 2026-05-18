// v1.196: "Add customer by phone" modal for limited-access trainers.
// Limited trainers' chat list starts empty; this modal is the way they
// unlock a customer they need to work on. Phone gets normalized to a
// chatKey, a grant is written to /userGrants/{uid}/{chatKey}, and the
// chat appears in their list for 14 days (or longer if a teammate
// later assigns them a ticket).

import React, { useState } from "react";
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from "react-native";
import { useStyles, useTheme, type Colors } from "@/theme";
import { encodeKey } from "@/lib/encodeKey";

interface Props {
  visible: boolean;
  onCancel: () => void;
  onAdd: (chatKey: string, phone: string) => Promise<void>;
}

export function AddCustomerModal({ visible, onCancel, onAdd }: Props) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();

  const submit = async () => {
    if (busy) return;
    setError(null);
    const result = phoneToChatKey(phone);
    if (!result) {
      setError("Enter a valid phone number (10+ digits).");
      return;
    }
    setBusy(true);
    try {
      await onAdd(result.chatKey, result.normalizedPhone);
      setPhone("");
      onCancel();
    } catch (e) {
      setError((e as Error)?.message || "Couldn't add customer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <View style={styles.back}>
        <TouchableWithoutFeedback onPress={onCancel}>
          <View style={StyleSheet.absoluteFill} />
        </TouchableWithoutFeedback>
        <View style={styles.card}>
          <Text style={styles.title}>Add customer</Text>
          <Text style={styles.sub}>
            Enter the customer's phone number to unlock their chat. Access
            lasts 14 days. If a teammate later assigns you a ticket on this
            customer, access stays until the ticket is resolved.
          </Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="+91 98765 43210"
            placeholderTextColor={colors.muted}
            keyboardType="phone-pad"
            style={styles.input}
            autoFocus
            editable={!busy}
            onSubmitEditing={submit}
          />
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <View style={styles.btnRow}>
            <TouchableOpacity
              style={styles.btn}
              onPress={onCancel}
              disabled={busy}
            >
              <Text style={styles.btnTxt}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
              onPress={submit}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color="white" />
              ) : (
                <Text style={[styles.btnTxt, styles.btnTxtPrimary]}>Add</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

// Normalize an Indian-style phone input into a stable Periskope chatId
// then encode it into the same chatKey scheme used everywhere else.
// "+91 98765 43210" → digits "919876543210" → chatId "919876543210@c.us"
// → chatKey "919876543210@c_us".
//
// If the input is 10 digits and looks like an Indian mobile (starts with
// 6-9), prefix with "91". Anything else is taken as-is — trainers can
// still enter explicit country codes.
export function phoneToChatKey(
  input: string,
): { chatKey: string; normalizedPhone: string } | null {
  const digits = (input || "").replace(/\D/g, "");
  if (!digits || digits.length < 7) return null;
  let normalized = digits;
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    normalized = "91" + digits;
  }
  const chatId = `${normalized}@c.us`;
  return { chatKey: encodeKey(chatId), normalizedPhone: normalized };
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    back: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "center",
      alignItems: "center",
      padding: 20,
    },
    card: {
      width: "100%",
      maxWidth: 380,
      backgroundColor: colors.panel,
      borderRadius: 14,
      padding: 20,
      gap: 8,
    },
    title: { fontSize: 17, fontWeight: "600", color: colors.text },
    sub: { fontSize: 12, color: colors.muted, marginBottom: 8, lineHeight: 17 },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 16,
      color: colors.text,
      backgroundColor: colors.bg,
    },
    error: { color: colors.redDark, fontSize: 12 },
    btnRow: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 8,
      marginTop: 8,
    },
    btn: {
      paddingVertical: 9,
      paddingHorizontal: 16,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      minWidth: 90,
      alignItems: "center",
    },
    btnPrimary: { backgroundColor: colors.green, borderColor: colors.green },
    btnDisabled: { opacity: 0.6 },
    btnTxt: { fontSize: 14, color: colors.text },
    btnTxtPrimary: { color: "white", fontWeight: "500" },
  });
}
