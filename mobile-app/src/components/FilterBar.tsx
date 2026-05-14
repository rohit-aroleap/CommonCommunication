// Search input + two filter dropdowns (subscription status + stage). The
// subscription dropdown also exposes the "Daily groups" bucket per the
// user-requested clubbing of Daily-Workout-Ferra-C cohorts.
//
// We use a plain horizontal button row that pops a Modal-based picker rather
// than a native <select> equivalent, because RN doesn't ship one and a
// custom sheet feels more native.

import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { colors, space } from "@/theme";
import { DAILY_SENTINEL, type ChatRow } from "@/types";
import { isDailyGroup } from "@/data/AppDataContext";
import { normalizeFerraPhone } from "@/lib/ferra";
import { prettyStatus } from "@/lib/format";

interface Props {
  rows: ChatRow[];
  phoneToStatus: Record<string, string>;
  statusFilter: string;
  stageFilter: string;
  search: string;
  onChangeStatus: (v: string) => void;
  onChangeStage: (v: string) => void;
  onChangeSearch: (v: string) => void;
}

const STAGE_OPTIONS = [
  { value: "", label: "All stages" },
  { value: "setup", label: "Setup" },
  { value: "onboarding", label: "Onboarding" },
  { value: "sa", label: "SA" },
  { value: "active", label: "Active" },
  { value: "offboarding", label: "Offboarding" },
];

export function FilterBar({
  rows,
  phoneToStatus,
  statusFilter,
  stageFilter,
  search,
  onChangeStatus,
  onChangeStage,
  onChangeSearch,
}: Props) {
  // Build the status dropdown options from what's actually present in the
  // data — empty buckets would just confuse the user. Daily-groups gets its
  // own pseudo-option above the real statuses.
  const statusOptions = useMemo(() => {
    const counts: Record<string, number> = {};
    let dailyCount = 0;
    for (const r of rows) {
      if (isDailyGroup(r)) {
        dailyCount++;
        continue;
      }
      const s = phoneToStatus[normalizeFerraPhone(r.phone)];
      if (s) counts[s] = (counts[s] || 0) + 1;
    }
    const opts: Array<{ value: string; label: string }> = [
      { value: "", label: "All subscriptions" },
    ];
    if (dailyCount > 0) {
      opts.push({
        value: DAILY_SENTINEL,
        label: `Daily groups (${dailyCount})`,
      });
    }
    for (const s of Object.keys(counts).sort()) {
      opts.push({ value: s, label: `${prettyStatus(s)} (${counts[s]})` });
    }
    return opts;
  }, [rows, phoneToStatus]);

  const [openSheet, setOpenSheet] = useState<null | "status" | "stage">(null);

  const statusLabel =
    statusOptions.find((o) => o.value === statusFilter)?.label ??
    "All subscriptions";
  const stageLabel =
    STAGE_OPTIONS.find((o) => o.value === stageFilter)?.label ?? "All stages";

  return (
    <View style={styles.bar}>
      <View style={styles.searchWrap}>
        <Text style={styles.searchIcn}>🔍</Text>
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={onChangeSearch}
          placeholder="Search by name or number"
          placeholderTextColor={colors.muted}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => onChangeSearch("")}>
            <Text style={styles.clearTxt}>×</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.dropRow}>
        <TouchableOpacity
          style={[styles.drop, !!statusFilter && styles.dropActive]}
          onPress={() => setOpenSheet("status")}
        >
          <Text
            style={[styles.dropTxt, !!statusFilter && styles.dropTxtActive]}
            numberOfLines={1}
          >
            {statusLabel}
          </Text>
          <Text
            style={[styles.caret, !!statusFilter && styles.dropTxtActive]}
          >
            ▾
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.drop, !!stageFilter && styles.dropActive]}
          onPress={() => setOpenSheet("stage")}
        >
          <Text
            style={[styles.dropTxt, !!stageFilter && styles.dropTxtActive]}
            numberOfLines={1}
          >
            {stageLabel}
          </Text>
          <Text style={[styles.caret, !!stageFilter && styles.dropTxtActive]}>
            ▾
          </Text>
        </TouchableOpacity>
      </View>

      <PickerSheet
        visible={openSheet === "status"}
        title="Subscription"
        options={statusOptions}
        selected={statusFilter}
        onPick={(v) => {
          onChangeStatus(v);
          setOpenSheet(null);
        }}
        onClose={() => setOpenSheet(null)}
      />
      <PickerSheet
        visible={openSheet === "stage"}
        title="Stage"
        options={STAGE_OPTIONS}
        selected={stageFilter}
        onPick={(v) => {
          onChangeStage(v);
          setOpenSheet(null);
        }}
        onClose={() => setOpenSheet(null)}
      />
    </View>
  );
}

function PickerSheet({
  visible,
  title,
  options,
  selected,
  onPick,
  onClose,
}: {
  visible: boolean;
  title: string;
  options: Array<{ value: string; label: string }>;
  selected: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
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
          <Text style={styles.sheetTitle}>{title}</Text>
          {options.map((o) => {
            const sel = o.value === selected;
            return (
              <TouchableOpacity
                key={o.value || "__all__"}
                style={[styles.sheetItem, sel && styles.sheetItemSel]}
                onPress={() => onPick(o.value)}
              >
                <Text
                  style={[styles.sheetItemTxt, sel && styles.sheetItemTxtSel]}
                >
                  {o.label}
                </Text>
                {sel && <Text style={styles.sheetCheck}>✓</Text>}
              </TouchableOpacity>
            );
          })}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: "white",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    gap: space.sm,
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f0f2f5",
    borderRadius: 22,
    paddingHorizontal: 12,
  },
  searchIcn: { color: colors.muted, fontSize: 13, marginRight: 8 },
  searchInput: {
    flex: 1,
    paddingVertical: 10,
    fontSize: 15,
    color: colors.text,
  },
  clearTxt: { fontSize: 20, color: colors.muted, paddingHorizontal: 6 },
  dropRow: { flexDirection: "row", gap: space.sm },
  drop: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#f0f2f5",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "transparent",
  },
  dropActive: {
    backgroundColor: "#d1f4cc",
    borderColor: colors.green,
  },
  dropTxt: { fontSize: 13, color: colors.text },
  dropTxtActive: { color: colors.greenDark, fontWeight: "500" },
  caret: { fontSize: 10, color: colors.muted, marginLeft: 6 },

  sheetBack: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "white",
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingBottom: 24,
    paddingTop: 8,
    maxHeight: "75%",
  },
  grab: {
    width: 36,
    height: 4,
    backgroundColor: "#d1d7db",
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 8,
  },
  sheetTitle: {
    fontSize: 13,
    color: colors.muted,
    paddingHorizontal: 18,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sheetItem: {
    paddingVertical: 14,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
  },
  sheetItemSel: { backgroundColor: "#f0f2f5" },
  sheetItemTxt: { fontSize: 15, color: colors.text, flex: 1 },
  sheetItemTxtSel: { fontWeight: "500", color: colors.greenDark },
  sheetCheck: { fontSize: 16, color: colors.greenDark },
});
