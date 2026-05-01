import { createContext, useCallback, useContext, useMemo, useState } from "react";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem("wwabot_token") || null);
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem("wwabot_user");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  const login = useCallback((nextToken, nextUser) => {
    localStorage.setItem("wwabot_token", nextToken);
    localStorage.setItem("wwabot_user", JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("wwabot_token");
    localStorage.removeItem("wwabot_user");
    setToken(null);
    setUser(null);
  }, []);

  const patchUser = useCallback((updates) => {
    setUser((prev) => {
      const next = { ...prev, ...updates };
      localStorage.setItem("wwabot_user", JSON.stringify(next));
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ token, user, login, logout, patchUser }),
    [token, user, login, logout, patchUser]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
