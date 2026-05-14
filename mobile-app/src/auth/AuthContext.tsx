// Centralized auth state. Drives the root-level gate (LoginScreen vs the
// app), and exposes signOut so any screen can boot the user without
// reaching into Firebase directly.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithCredential,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { get, ref, update } from "firebase/database";
import { auth, db } from "@/firebase";
import { BOOTSTRAP_ADMINS, ROOT } from "@/config";

type AuthStatus =
  | "loading"
  | "signed-out"
  | "checking-allowlist"
  | "signed-in"
  | "unauthorized";

interface AuthValue {
  status: AuthStatus;
  user: User | null;
  unauthorizedEmail: string | null;
  signInWithGoogleIdToken: (idToken: string) => Promise<void>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

function emailKey(email: string): string {
  return email.toLowerCase().replace(/[.#$\[\]\/]/g, "_");
}

async function isUserAllowed(email: string | null): Promise<boolean> {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (BOOTSTRAP_ADMINS.map((e) => e.toLowerCase()).includes(lower)) return true;
  try {
    const snap = await get(
      ref(db, `${ROOT}/config/allowedEmails/${emailKey(lower)}`),
    );
    return snap.exists() && !!snap.val();
  } catch {
    return false;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [unauthorizedEmail, setUnauthorizedEmail] = useState<string | null>(
    null,
  );

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        setUser(null);
        setStatus("signed-out");
        setUnauthorizedEmail(null);
        return;
      }
      setStatus("checking-allowlist");
      const allowed = await isUserAllowed(u.email);
      if (!allowed) {
        setUnauthorizedEmail(u.email ?? null);
        await fbSignOut(auth).catch(() => {});
        setStatus("unauthorized");
        setUser(null);
        return;
      }
      // Stamp presence — same shape as web's onAuthStateChanged write.
      update(ref(db, `${ROOT}/users/${u.uid}`), {
        name: u.displayName || u.email,
        email: u.email,
        photoURL: u.photoURL || null,
        lastSeen: Date.now(),
      }).catch(() => {});
      setUser(u);
      setUnauthorizedEmail(null);
      setStatus("signed-in");
    });
    return unsub;
  }, []);

  const signInWithGoogleIdToken = useCallback(async (idToken: string) => {
    const cred = GoogleAuthProvider.credential(idToken);
    await signInWithCredential(auth, cred);
  }, []);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
  }, []);

  const isAdmin = useMemo(() => {
    const email = user?.email?.toLowerCase();
    if (!email) return false;
    return BOOTSTRAP_ADMINS.map((e) => e.toLowerCase()).includes(email);
  }, [user]);

  const value: AuthValue = useMemo(
    () => ({
      status,
      user,
      unauthorizedEmail,
      signInWithGoogleIdToken,
      signOut,
      isAdmin,
    }),
    [status, user, unauthorizedEmail, signInWithGoogleIdToken, signOut, isAdmin],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
