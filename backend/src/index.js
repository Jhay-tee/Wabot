import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import hpp from "hpp";

import { env } from "./config/env.js";
import { apiLimiter } from "./middleware/rateLimiter.js";
import adminRouter from "./routes/admin.js";
import authRouter from "./routes/auth.js";
import billingRouter from "./routes/billing.js";
import botsRouter from "./routes/bots.js";
import v1Router from "./routes/v1.js";
import { dashboardRealtime } from "./services/realtime/DashboardRealtime.js";
import { contactLifecycleService } from "./services/maintenance/ContactLifecycleService.js";
import { statusPostScheduler } from "./services/maintenance/StatusPostScheduler.js";
import { botManager } from "./services/whatsapp/BotManager.js";
import { logger } from "./utils/logger.js";

const app = express();
let server = null;

function buildAllowedOrigins() {
  return String(env.allowedOrigins || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const allowedOrigins = buildAllowedOrigins();

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Origin not allowed by CORS"));
  },
  credentials: true,
});

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(corsMiddleware);
app.use(helmet({
  crossOriginResourcePolicy: false,
}));
app.use(compression());
app.use(hpp());

const jsonParser = express.json({ limit: "25mb" });
const urlencodedParser = express.urlencoded({ extended: true, limit: "25mb" });

app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook") return next();
  return jsonParser(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/api/billing/webhook") return next();
  return urlencodedParser(req, res, next);
});

app.get("/health", (_req, res) => {
  const liveInstances = [...botManager.instances.values()];
  const pairingStates = new Set(["awaiting_code", "code_generated", "awaiting_link", "awaiting_pairing"]);
  const qrStates = new Set(["awaiting_qr", "awaiting_qr_scan", "qr_generated"]);
  res.json({
    ok: true,
    status: "ok",
    environment: env.nodeEnv,
    uptimeSeconds: Math.floor(process.uptime()),
    bots: {
      total: liveInstances.length,
      connected: liveInstances.filter((inst) => inst.status === "connected").length,
      pairing: liveInstances.filter((inst) => pairingStates.has(inst.status)).length,
      qr: liveInstances.filter((inst) => qrStates.has(inst.status)).length,
    },
    realtimeInitialized: dashboardRealtime.initialized,
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/auth", authRouter);
app.use("/api/billing", billingRouter);
app.use("/api", apiLimiter);
app.use("/api/bots", botsRouter);
app.use("/api/v1", v1Router);
app.use("/api/admin", adminRouter);

app.use((req, res) => {
  res.status(404).json({ error: "Route not found." });
});

app.use((err, _req, res, _next) => {
  logger.error({ err }, "Unhandled Express error");

  if (err?.message === "Origin not allowed by CORS") {
    return res.status(403).json({ error: err.message });
  }

  return res.status(500).json({ error: "Internal server error." });
});

async function shutdown(signal) {
  logger.info({ signal }, "Shutting down");

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }

  const stops = [...botManager.instances.values()].map((inst) =>
    inst.stop().catch((err) => {
      logger.warn({ err, botId: inst.botId }, "Bot stop failed during shutdown");
    })
  );
  await Promise.allSettled(stops);
  await contactLifecycleService.shutdown();
  await statusPostScheduler.shutdown();
  process.exit(0);
}

async function bootstrap() {
  await dashboardRealtime.initialize();
  await contactLifecycleService.initialize();
  await statusPostScheduler.initialize();
  await botManager.initialize();

  server = app.listen(env.port, () => {
    logger.info({ port: env.port, env: env.nodeEnv }, "WaBot API listening");
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT").catch((err) => {
    logger.error({ err }, "Shutdown failed");
    process.exit(1);
  });
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch((err) => {
    logger.error({ err }, "Shutdown failed");
    process.exit(1);
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
});

bootstrap().catch((err) => {
  logger.fatal({ err }, "Failed to bootstrap WaBot API");
  process.exit(1);
});
