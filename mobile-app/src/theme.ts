// Single source of truth for colors / spacing. Mirrors the CSS vars in
// mobile.html so the RN app looks identical to the PWA. When the PWA palette
// changes, update both — there's no shared stylesheet between surfaces.

export const colors = {
  green: "#00a884",
  greenDark: "#008069",
  bg: "#efeae2",
  panel: "#ffffff",
  header: "#008069",
  headerText: "#ffffff",
  bubbleOut: "#d9fdd3",
  bubbleIn: "#ffffff",
  text: "#111b21",
  muted: "#667781",
  border: "#e9edef",
  rowHover: "#f5f6f6",
  red: "#ef4444",
  redDark: "#b91c1c",
  pillActiveBg: "#d1fae5",
  pillActiveFg: "#065f46",
  pillCancelledBg: "#fee2e2",
  pillCancelledFg: "#991b1b",
  pillPausedBg: "#fef3c7",
  pillPausedFg: "#92400e",
  pillStageSetupBg: "#fef3c7",
  pillStageSetupFg: "#92400e",
  pillStageOnboardingBg: "#ffedd5",
  pillStageOnboardingFg: "#9a3412",
  pillStageSaBg: "#dbeafe",
  pillStageSaFg: "#1e40af",
  pillStageOffboardingBg: "#fee2e2",
  pillStageOffboardingFg: "#991b1b",
};

export const radii = { sm: 6, md: 8, lg: 12, pill: 22 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
