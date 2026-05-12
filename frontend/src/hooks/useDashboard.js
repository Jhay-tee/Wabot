import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate }  from "react-router-dom";
import { botsApi }      from "../api/bots.js";
import { openEventStream } from "../api/client.js";
import { useAuth }      from "../context/AuthContext.jsx";

const POLL_MS = 30_000;
const REFRESH_DEBOUNCE_MS = 400;

export function useDashboard() {
  const auth     = useAuth();
  const navigate = useNavigate();

  const [data, setData]       = useState({ user: auth.user, bots: [], activity: [], stats: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const pollRef               = useRef(null);
  const refreshTimerRef       = useRef(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const d = await botsApi.dashboard();
      setData(d);
      if (d.user) auth.patchUser(d.user);
    } catch (err) {
      if (err.status === 401) { auth.logout(); navigate("/login", { replace: true }); }
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [auth.logout, navigate]); /* stable refs — won't cause extra re-renders */

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => load(true), POLL_MS);
    const closeStream = openEventStream(
      "/bots/dashboard/events",
      () => {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => load(true), REFRESH_DEBOUNCE_MS);
      }
    );

    return () => {
      clearInterval(pollRef.current);
      clearTimeout(refreshTimerRef.current);
      closeStream();
    };
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { data, loading, error, refresh };
}
