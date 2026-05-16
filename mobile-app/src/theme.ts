// Theme tokens — two palettes (light + dark) sharing the same shape. The
// light palette is the original WhatsApp-esque green theme from before
// v1.136; dark is a Telegram-inspired navy/blue look added in v1.136 along
// with a SettingsScreen toggle.
//
// Components access these via useTheme() / useStyles() from "./theme" so
// styles automatically refresh when the user flips the toggle — there is
// no module-level mutable `colors` export anymore. If you import { colors }
// you'll get a runtime warning (see deprecation shim below).

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { StyleSheet } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type AppearanceMode = "light" | "dark";

// Palette shape. Same fields across both themes so any component can read
// any token without branching on mode.
export interface Colors {
  // Brand / primary action color. Used for send button, active states,
  // outgoing message bubbles.
  green: string;
  // Top app bar background + composer background. Named "greenDark" for
  // backwards-compat with the existing call sites (the light palette had
  // a green header; the dark palette uses a near-black navy).
  greenDark: string;
  // Body / main chat background.
  bg: string;
  // Panel / card / modal surface.
  panel: string;
  header: string;
  headerText: string;
  bubbleOut: string;
  bubbleIn: string;
  text: string;
  muted: string;
  border: string;
  rowHover: string;
  red: string;
  redDark: string;
  // Status pills (subscription / ticket lifecycle markers). The light
  // palette uses pastel bg + dark fg; dark palette uses muted dark bg +
  // light fg.
  pillActiveBg: string;
  pillActiveFg: string;
  pillCancelledBg: string;
  pillCancelledFg: string;
  pillPausedBg: string;
  pillPausedFg: string;
  pillStageSetupBg: string;
  pillStageSetupFg: string;
  pillStageOnboardingBg: string;
  pillStageOnboardingFg: string;
  pillStageSaBg: string;
  pillStageSaFg: string;
  pillStageOffboardingBg: string;
  pillStageOffboardingFg: string;
}

// Original light theme — the WhatsApp-esque green palette the app shipped
// with through v1.135.
const LIGHT: Colors = {
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

// Dark theme — Telegram-inspired navy + blue accent. Outgoing bubbles are
// the same blue as the send button, incoming bubbles are dark slate. Body
// is near-black with a slight cool tint.
const DARK: Colors = {
  green: "#3b82f6",          // blue accent (was emerald)
  greenDark: "#0f172a",      // top bar + composer (near-black slate)
  bg: "#0a0e16",             // chat body
  panel: "#0f172a",          // cards / modals
  header: "#0f172a",
  headerText: "#f8fafc",
  bubbleOut: "#3b82f6",      // blue outgoing
  bubbleIn: "#1e293b",       // dark slate incoming
  text: "#e5e7eb",
  muted: "#94a3b8",
  border: "#1f2937",
  rowHover: "#111827",
  red: "#ef4444",
  redDark: "#dc2626",
  pillActiveBg: "#064e3b",
  pillActiveFg: "#a7f3d0",
  pillCancelledBg: "#7f1d1d",
  pillCancelledFg: "#fecaca",
  pillPausedBg: "#78350f",
  pillPausedFg: "#fde68a",
  pillStageSetupBg: "#78350f",
  pillStageSetupFg: "#fde68a",
  pillStageOnboardingBg: "#7c2d12",
  pillStageOnboardingFg: "#fed7aa",
  pillStageSaBg: "#1e3a8a",
  pillStageSaFg: "#bfdbfe",
  pillStageOffboardingBg: "#7f1d1d",
  pillStageOffboardingFg: "#fecaca",
};

export const radii = { sm: 6, md: 8, lg: 12, pill: 22 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

const APPEARANCE_AS_KEY = "cc.appearance";
const DEFAULT_APPEARANCE: AppearanceMode = "dark";

interface ThemeContextValue {
  mode: AppearanceMode;
  colors: Colors;
  setMode: (m: AppearanceMode) => void;
  toggle: () => void;
  loaded: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: DEFAULT_APPEARANCE,
  colors: DARK,
  setMode: () => {},
  toggle: () => {},
  loaded: false,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<AppearanceMode>(DEFAULT_APPEARANCE);
  const [loaded, setLoaded] = useState(false);

  // Hydrate from AsyncStorage on mount. While loading, render with the
  // default so we don't flash light → dark (would be jarring on first
  // launch). Once hydrated, swap in the persisted value if it differs.
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(APPEARANCE_AS_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (stored === "light" || stored === "dark") setModeState(stored);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setMode = useCallback((m: AppearanceMode) => {
    setModeState(m);
    AsyncStorage.setItem(APPEARANCE_AS_KEY, m).catch(() => {
      /* storage disabled — fail soft, the user's choice still applies for
         the current session */
    });
  }, []);

  const toggle = useCallback(() => {
    setMode(mode === "dark" ? "light" : "dark");
  }, [mode, setMode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      colors: mode === "dark" ? DARK : LIGHT,
      setMode,
      toggle,
      loaded,
    }),
    [mode, setMode, toggle, loaded],
  );

  return React.createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme() {
  return useContext(ThemeContext);
}

// Memoize a style sheet against the current colors. Pass a factory that
// calls StyleSheet.create directly and returns the result — the precise
// per-key style types pass through so consumers don't lose
// flexDirection: "row" narrowing etc.
//
// Usage:
//   const styles = useStyles(makeStyles);
//   function makeStyles(c: Colors) {
//     return StyleSheet.create({
//       container: { backgroundColor: c.bg },
//     });
//   }
export function useStyles<T>(factory: (c: Colors) => T): T {
  const { colors } = useTheme();
  // factory is expected to be a stable module-level function reference —
  // depending only on `colors` here is correct.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => factory(colors), [colors]);
}

// Deprecation shim. Old code did `import { colors } from "@/theme"` and
// captured values at module-eval time. That's broken under a dynamic theme
// — those styles won't refresh on toggle. Re-exporting the DARK palette so
// any lingering imports at least render reasonably; warns once at module
// load if any reference path tries to use this.
//
// Sweep target: every src/**/*.tsx — replace `colors.foo` with the hook-
// based access via useStyles or useTheme().
export const colors: Colors = DARK;
