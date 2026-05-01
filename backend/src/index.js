import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import hpp from "hpp";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import authRouter from "./routes/auth.js";
import botRouter from "./routes/bots.js";
import billingRouter from "./routes/billing.js";

const app = express();
const allowedOrigins = env.allowedOrigins.split(",").map((origin) => origin.trim());

app.disable("x-powered-by");
app.use(helmet());
app.use(compression());
app.use(hpp());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  }
}));
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use((req, res, next) => {
  if (req.originalUrl === "/api/billing/webhook") return next();
  return express.json({ limit: "100kb" })(req, res, next);
});

app.get("/api/health", (_, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/bots", botRouter);
app.use("/api/billing", billingRouter);

app.use((err, _req, res, _next) => {
  return res.status(500).json({ error: env.nodeEnv === "production" ? "Internal server error" : err.message });
});

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Botify backend running on http://localhost:${env.port}`);
});
