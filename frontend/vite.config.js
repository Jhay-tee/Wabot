import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In production builds (npm run build), always use relative /api paths.
// The backend serves the frontend on port 5000 (same-origin), so /api works natively.
// We clear any VITE_API_BASE_URL that may have been injected from the dev environment
// to prevent localhost URLs from being baked into the production bundle.
if (process.env.NODE_ENV === "production" || process.argv.includes("build")) {
  process.env.VITE_API_BASE_URL = "";
}

const replitDomain = process.env.REPLIT_DEV_DOMAIN;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5000,
    allowedHosts: true,
    hmr: replitDomain
      ? { protocol: "wss", host: replitDomain, clientPort: 443 }
      : true,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true
      }
    }
  }
});
