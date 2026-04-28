import "dotenv/config";
import express from "express";
import cors from "cors";

import whatsappWebhook from "./webhooks/whatsapp.js";
import paystackWebhook from "./webhooks/paystack.js";
import paymentRoute from "./routes/payment.js";
import dashboardRoute from "./routes/dashboard.js";

import { startAutoReleaseJob, startReminderJob } from "./jobs/autoRelease.js";
import { startDisputeReviewJob } from "./jobs/index.js";
import logger from "./utils/logger.js";

const app = express();

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

const allowedOrigins = [
  "https://trustpayv2.lovable.app", // published
  "https://id-preview--2ffae9e3-93d2-46f5-953d-9634f8aadc2c.lovable.app", // preview
  /\.lovable\.app$/, // any lovable subdomain
  "http://localhost:5173", // local dev
];

app.use(
  cors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  }),
);

app.options("*", cors()); // handle preflight for all routes

// Paystack needs raw body for signature verification — must come before json()
app.use("/webhooks/paystack", paystackWebhook);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((rq, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use("/webhooks/whatsapp", whatsappWebhook); // Meta Cloud API webhook
app.use("/pay", paymentRoute); // One-time payment page
app.use("/api/pay", paymentRoute); // One-time payment page
app.use("/admin", dashboardRoute); // Internal admin API

app.get("/health", (_, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use((req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, req, res, next) => {
  logger.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`TrustPay backend running on port ${PORT}`);
  logger.info(`  WhatsApp webhook : POST /webhooks/whatsapp`);
  logger.info(`  Paystack webhook : POST /webhooks/paystack`);
  logger.info(`  Payment page     : GET  /pay/:token`);
  logger.info(`  Admin API        : GET  /admin/stats`);

  startAutoReleaseJob();
  startReminderJob();
  startDisputeReviewJob();
});

export default app;
