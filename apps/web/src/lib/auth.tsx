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
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  oidcEnabled: false,
  contactsDisabled: false,
  scheduleDisabled: false,
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

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        // Fetch runtime config to determine if OIDC is enabled.
        const cfgRes = await fetch("/api/runtime-config");
        if (cfgRes.ok) {
          const cfg = (await cfgRes.json()) as { oidcEnabled?: boolean; contactsDisabled?: boolean; scheduleDisabled?: boolean };
          if (!cancelled) setOidcEnabled(!!cfg.oidcEnabled);
          if (!cancelled) setContactsDisabled(!!cfg.contactsDisabled);
          if (!cancelled) setScheduleDisabled(!!cfg.scheduleDisabled);

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
    <AuthContext.Provider value={{ user, loading, oidcEnabled, contactsDisabled, scheduleDisabled, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
