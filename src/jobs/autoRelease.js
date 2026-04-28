import cron from "node-cron";
import prisma from "../utils/prisma.js";
import { payoutToBank } from "../services/paystack.js";
import { sendMessage, msg } from "../services/whatsapp.js";
import { daysUntil } from "../utils/helpers.js";
import logger from "../utils/logger.js";

// ─── AUTO-RELEASE ─────────────────────────────────────────────────────────────
// Daily at 8am WAT — releases funds for silent buyers past deadline

export const startAutoReleaseJob = () => {
  cron.schedule(
    "0 7 * * *",
    async () => {
      logger.info("Running auto-release job...");

      const overdue = await prisma.transaction.findMany({
        where: {
          status: "FUNDED",
          autoReleaseAt: { lt: new Date() },
        },
        include: { seller: true, buyer: true },
      });

      logger.info(`Auto-release: ${overdue.length} overdue transaction(s)`);

      for (const tx of overdue) {
        try {
          await processAutoRelease(tx);
        } catch (err) {
          logger.error(`Auto-release failed for ${tx.dealCode}:`, err.message);
        }
      }
    },
    { timezone: "Africa/Lagos" },
  );

  logger.info("✅ Auto-release job scheduled (daily 8am WAT)");
};

const processAutoRelease = async (tx) => {
  await sendMessage(tx.buyer.phoneNumber, msg.autoReleaseBuyerFinal(tx), tx.id);

  try {
    await payoutToBank({
      name: tx.seller.fullName,
      accountNumber: tx.seller.accountNumber,
      bankName: tx.seller.bankName,
      amountKobo: tx.amountKobo,
      reference: `TP-AUTORELEASE-${tx.dealCode}-${Date.now()}`,
      reason: `TrustPay auto-release — ${tx.dealCode}`,
    });

    await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: "RELEASED", releasedAt: new Date() },
    });

    await sendMessage(tx.seller.phoneNumber, msg.autoReleaseSeller(tx), tx.id);
    logger.info(`Auto-released: ${tx.dealCode}`);
  } catch (err) {
    logger.error(`Auto-release payout failed for ${tx.dealCode}:`, err.message);
  }
};

// ─── BUYER REMINDERS ──────────────────────────────────────────────────────────
// Twice daily — warns buyers approaching auto-release

export const startReminderJob = () => {
  cron.schedule(
    "0 8,17 * * *",
    async () => {
      logger.info("Running reminder job...");

      const upcoming = await prisma.transaction.findMany({
        where: {
          status: "FUNDED",
          autoReleaseAt: {
            gt: new Date(),
            lt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
          },
        },
        include: { buyer: true },
      });

      for (const tx of upcoming) {
        const daysLeft = daysUntil(tx.autoReleaseAt);
        await sendMessage(
          tx.buyer.phoneNumber,
          msg.reminderBuyer(tx, daysLeft),
          tx.id,
        );
      }

      logger.info(`Reminders sent for ${upcoming.length} transaction(s)`);
    },
    { timezone: "Africa/Lagos" },
  );

  logger.info("✅ Reminder job scheduled (8am & 5pm WAT)");
};
