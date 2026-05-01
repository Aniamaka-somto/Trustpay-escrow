import express from "express";
import { verifySignature } from "../services/paystack.js";
import { sendMessage, msg } from "../services/whatsapp.js";
import { autoReleaseDate } from "../utils/helpers.js";
import prisma from "../utils/prisma.js";
import logger from "../utils/logger.js";

const router = express.Router();

router.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["x-paystack-signature"];

    if (!verifySignature(req.body, signature)) {
      logger.warn("Invalid Paystack webhook signature");
      return res.sendStatus(401);
    }

    res.sendStatus(200);

    try {
      const event = JSON.parse(req.body);
      logger.info(`Paystack event: ${event.event}`);

      switch (event.event) {
        case "charge.success":
          await onChargeSuccess(event.data);
          break;
        case "transfer.success":
          logger.info(`Transfer confirmed: ${event.data.reference}`);
          break;
        case "transfer.failed":
          await onTransferFailed(event.data);
          break;
        case "transfer.reversed":
          logger.warn(`Transfer reversed: ${event.data.reference}`);
          break;
      }
    } catch (err) {
      logger.error(`Paystack webhook processing error: ${err.message}`);
    }
  },
);

// ─── CHARGE SUCCESS ───────────────────────────────────────────────────────────

const onChargeSuccess = async (data) => {
  const transactionId = data.metadata?.transactionId;
  if (!transactionId) {
    logger.warn("Paystack charge.success with no transactionId in metadata");
    return;
  }

  // FIX: fetch deal first to verify amount before marking as funded
  const deal = await prisma.transaction.findUnique({
    where: { id: transactionId },
  });

  if (!deal) {
    logger.warn(`Transaction ${transactionId} not found`);
    return;
  }

  const expectedKobo = Number(deal.amountKobo) + Number(deal.feeKobo);
  if (data.amount !== expectedKobo) {
    logger.error(
      `Amount mismatch on ${transactionId}: got ${data.amount}, expected ${expectedKobo} — NOT funding`,
    );
    return;
  }

  const tx = await prisma.transaction
    .update({
      where: { id: transactionId, status: "PENDING" },
      data: {
        status: "FUNDED",
        paystackRef: data.reference,
        fundedAt: new Date(),
        autoReleaseAt: autoReleaseDate(new Date()),
      },
      include: { seller: true, buyer: true },
    })
    .catch(() => null);

  if (!tx) {
    logger.warn(
      `Transaction ${transactionId} not in PENDING state — skipping (idempotent)`,
    );
    return;
  }

  logger.info(`Funded: ${tx.dealCode} — ${tx.buyer.phoneNumber} paid`);

  await sendMessage(tx.buyer.phoneNumber, msg.paymentConfirmedBuyer(tx), tx.id);
  await sendMessage(
    tx.seller.phoneNumber,
    msg.paymentConfirmedSeller(tx),
    tx.id,
  );
};

// ─── TRANSFER FAILED ──────────────────────────────────────────────────────────

const onTransferFailed = async (data) => {
  logger.error(`Transfer FAILED: ${data.reference} — ${data.reason}`);

  const match = data.reference?.match(/TP-[A-Z0-9]{6}/);
  if (!match) return;

  const tx = await prisma.transaction.findUnique({
    where: { dealCode: match[0] },
    include: { seller: true },
  });

  if (tx?.seller) {
    await sendMessage(
      tx.seller.phoneNumber,
      `⚠️ Payout failed for deal *${tx.dealCode}*.\n\n` +
        `Reason: ${data.reason}\n\n` +
        `Your funds are safe. Our team will resolve this within 24 hours.`,
    );
  }
};

export default router;
