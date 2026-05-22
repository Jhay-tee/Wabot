function getEnv(name) {
  return typeof import.meta !== "undefined" ? import.meta.env[name] : "";
}

export function parseRecoveryHash(hash = window.location.hash) {
  const fragment = String(hash ?? "").replace(/^#/, "");
  const params = new URLSearchParams(fragment);

  return {
    accessToken: params.get("access_token") ?? "",
    refreshToken: params.get("refresh_token") ?? "",
    type: params.get("type") ?? "",
    error: params.get("error_description") || params.get("error") || "",
  };
}

export async function updatePasswordWithRecovery(accessToken, password) {
  const supabaseUrl = String(getEnv("VITE_SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const anonKey = String(getEnv("VITE_SUPABASE_ANON_KEY") ?? "").trim();

  if (!supabaseUrl || !anonKey) {
    throw new Error("Password reset is not configured on this frontend. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  }

  const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ password }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.msg || payload?.error_description || payload?.error || "Could not reset password.");
  }

  return payload;
}
