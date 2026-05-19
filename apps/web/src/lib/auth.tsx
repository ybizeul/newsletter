import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  oidcEnabled: boolean;
  contactsDisabled: boolean;
  scheduleDisabled: boolean;
  appVersion: string;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  oidcEnabled: false,
  contactsDisabled: false,
  scheduleDisabled: false,
  appVersion: "",
  logout: () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [contactsDisabled, setContactsDisabled] = useState(false);
  const [scheduleDisabled, setScheduleDisabled] = useState(false);
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Fetch runtime config to determine if OIDC is enabled.
        const cfgRes = await fetch("/api/runtime-config");
        if (cfgRes.ok) {
          const cfg = (await cfgRes.json()) as { oidcEnabled?: boolean; contactsDisabled?: boolean; scheduleDisabled?: boolean; appVersion?: string };
          if (!cancelled) setOidcEnabled(!!cfg.oidcEnabled);
          if (!cancelled) setContactsDisabled(!!cfg.contactsDisabled);
          if (!cancelled) setScheduleDisabled(!!cfg.scheduleDisabled);
          if (!cancelled) setAppVersion((cfg.appVersion ?? "").trim());

          if (cfg.oidcEnabled) {
            // Attempt to load current user session.
            const meRes = await fetch("/api/auth/me");
            if (meRes.ok) {
              const me = (await meRes.json()) as AuthUser;
              if (!cancelled) setUser(me);
            }
          }
        }
      } catch {
        // Ignore network errors – will render as unauthenticated.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => { cancelled = true; };
  }, []);

  const logout = () => {
    // POST to /api/auth/logout then hard-reload so cookie clears.
    fetch("/api/auth/logout", { method: "POST" }).finally(() => {
      window.location.href = "/";
    });
  };

  return (
    <AuthContext.Provider value={{ user, loading, oidcEnabled, contactsDisabled, scheduleDisabled, appVersion, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
