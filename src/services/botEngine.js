import Anthropic from "@anthropic-ai/sdk";
import prisma from "../utils/prisma.js";
import { payoutToBank } from "../services/paystack.js";
import { sendMessage, msg } from "../services/whatsapp.js";
import { formatNaira } from "../utils/fees.js";
import logger from "../utils/logger.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MAIN RESOLVER ────────────────────────────────────────────────────────────

export const resolveDispute = async (disputeId) => {
  logger.info(`[Dispute] Starting AI resolution for ${disputeId}`);

  const dispute = await loadContext(disputeId);
  if (!dispute) throw new Error(`Dispute ${disputeId} not found`);

  const ruling = await getAiRuling(dispute);
  logger.info(
    `[Dispute] Ruling: ${ruling.decision} (${ruling.confidence}% confidence) — ${dispute.transaction.dealCode}`,
  );

  // Save ruling
  await prisma.dispute.update({
    where: { id: disputeId },
    data: {
      status:
        ruling.decision === "INCONCLUSIVE"
          ? "ESCALATED"
          : `RESOLVED_${ruling.decision}`,
      aiRuling: ruling.decision,
      aiReasoning: ruling.reasoning,
      aiConfidence: ruling.confidence,
      resolvedAt: new Date(),
    },
  });

  // Execute ruling
  await executeRuling(dispute, ruling);

  return ruling;
};

// ─── LOAD FULL CONTEXT ────────────────────────────────────────────────────────

const loadContext = async (disputeId) => {
  return prisma.dispute.findUnique({
    where: { id: disputeId },
    include: {
      transaction: {
        include: {
          seller: true,
          buyer: true,
        },
      },
      raisedBy: true,
      evidence: {
        include: { submitter: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
};

// ─── BUILD PROMPT ─────────────────────────────────────────────────────────────

const buildPrompt = (dispute) => {
  const tx = dispute.transaction;
  const seller = tx.seller;
  const buyer = tx.buyer;

  const daysSinceFunded = tx.fundedAt
    ? Math.floor((Date.now() - new Date(tx.fundedAt)) / 86400000)
    : "unknown";

  const evidenceText =
    dispute.evidence.length === 0
      ? "No evidence submitted."
      : dispute.evidence
          .map((e, i) => {
            const party = e.submitter.id === buyer.id ? "BUYER" : "SELLER";
            const type = e.type === "IMAGE" ? "[IMAGE SUBMITTED]" : "";
            return `Evidence ${i + 1} [${party}] ${type}\n${e.description || "(media only)"}`;
          })
          .join("\n\n");

  return `You are an impartial escrow dispute arbitrator for TrustPay, a Nigerian WhatsApp escrow service.

Analyse this trade dispute and deliver a fair, binding ruling.

━━━ TRANSACTION ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Deal code:        ${tx.dealCode}
Item agreed:      ${tx.itemDescription}
Amount:           ${formatNaira(tx.amountKobo)}
Delivery agreed:  ${tx.deliveryDays} day(s)
Days since paid:  ${daysSinceFunded}

━━━ SELLER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name:             ${seller.fullName}
Trust score:      ${seller.trustScore}/100
Completed trades: ${seller.totalTransactions}
Past disputes:    ${seller.disputesRaised}

━━━ BUYER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name:             ${buyer.fullName}
Trust score:      ${buyer.trustScore}/100
Completed trades: ${buyer.totalTransactions}
Past disputes:    ${buyer.disputesRaised}

━━━ DISPUTE REASON ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${dispute.reason}

━━━ EVIDENCE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${evidenceText}

━━━ ANALYSIS GUIDELINES ━━━━━━━━━━━━━━━━━━━━━━━━━━
Consider:
1. Is the buyer's complaint specific, credible, and evidenced?
2. Did the seller provide counter-evidence?
3. Do trust scores/history flag either party as a repeat bad actor?
4. Is the item description specific enough that a bait-and-switch is detectable?
5. Are there red flags of staged or inconsistent evidence?

Common Nigerian trade fraud patterns:
- Buyer claims non-delivery with no proof + has multiple past disputes
- New seller (0 trades, low trust score) with vague item description
- Bait-and-switch (e.g. agreed "iPhone 14 Pro Max" but "iPhone 14" delivered)
- Evidence appears staged or timestamps are inconsistent

━━━ OUTPUT FORMAT ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Respond ONLY with valid JSON — no preamble, no markdown:

{
  "decision": "BUYER" | "SELLER" | "INCONCLUSIVE",
  "confidence": <0-100>,
  "summary": "<one sentence plain English ruling>",
  "reasoning": "<2-4 sentences citing specific evidence>",
  "flags": ["<fraud patterns detected, if any>"]
}

BUYER = refund the buyer in full
SELLER = release funds to seller
INCONCLUSIVE = evidence too contradictory, escalate to human review`;
};

// ─── CALL CLAUDE ──────────────────────────────────────────────────────────────

const getAiRuling = async (dispute) => {
  const prompt = buildPrompt(dispute);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = response.content[0].text;

  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    if (!["BUYER", "SELLER", "INCONCLUSIVE"].includes(parsed.decision)) {
      throw new Error("Invalid decision value");
    }

    return {
      decision: parsed.decision,
      confidence: parsed.confidence || 0,
      summary: parsed.summary || "",
      reasoning: parsed.reasoning || "",
      flags: parsed.flags || [],
    };
  } catch (err) {
    logger.error("[Dispute] Failed to parse AI ruling:", raw);
    return {
      decision: "INCONCLUSIVE",
      confidence: 0,
      summary: "AI could not parse ruling — escalated to manual review",
      reasoning: raw,
      flags: ["parse_error"],
    };
  }
};

// ─── EXECUTE RULING ───────────────────────────────────────────────────────────

const executeRuling = async (dispute, ruling) => {
  const tx = dispute.transaction;
  const seller = tx.seller;
  const buyer = tx.buyer;

  if (ruling.decision === "SELLER") {
    await releaseFundsToSeller(tx, seller, buyer, ruling.summary);
  } else if (ruling.decision === "BUYER") {
    await refundBuyer(tx, seller, buyer, ruling.summary);
  } else {
    // INCONCLUSIVE — keep funds frozen, notify both
    await sendMessage(seller.phoneNumber, msg.disputeEscalated(tx.dealCode));
    await sendMessage(buyer.phoneNumber, msg.disputeEscalated(tx.dealCode));
    logger.warn(`[Dispute] Escalated: ${tx.dealCode} — ${ruling.summary}`);
  }

  // Trust score penalty for the losing party
  await applyTrustPenalty(dispute, ruling);
};

const releaseFundsToSeller = async (tx, seller, buyer, summary) => {
  try {
    await payoutToBank({
      name: seller.fullName,
      accountNumber: seller.accountNumber,
      bankName: seller.bankName,
      amountKobo: tx.amountKobo,
      reference: `TP-DISPUTE-SELLER-${tx.dealCode}-${Date.now()}`,
      reason: `TrustPay dispute ruling (seller wins) — ${tx.dealCode}`,
    });

    await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: "RELEASED", releasedAt: new Date() },
    });

    await sendMessage(
      seller.phoneNumber,
      msg.rulingSellerWins(tx.dealCode, summary),
    );
    await sendMessage(
      buyer.phoneNumber,
      msg.rulingAgainstBuyer(tx.dealCode, summary),
    );
  } catch (err) {
    logger.error(
      `[Dispute] Payout to seller failed for ${tx.dealCode}:`,
      err.message,
    );
    await sendMessage(
      seller.phoneNumber,
      `✅ Ruling in your favour for *${tx.dealCode}* — but payout failed. Our team will process it manually within 24 hours.`,
    );
  }
};

const refundBuyer = async (tx, seller, buyer, summary) => {
  const refundAmount = BigInt(tx.amountKobo) + BigInt(tx.feeKobo);

  try {
    await payoutToBank({
      name: buyer.fullName,
      accountNumber: buyer.accountNumber,
      bankName: buyer.bankName,
      amountKobo: refundAmount,
      reference: `TP-DISPUTE-BUYER-${tx.dealCode}-${Date.now()}`,
      reason: `TrustPay dispute ruling (buyer refund) — ${tx.dealCode}`,
    });

    await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: "REFUNDED" },
    });

    await sendMessage(
      buyer.phoneNumber,
      msg.rulingBuyerWins(tx.dealCode, summary),
    );
    await sendMessage(
      seller.phoneNumber,
      msg.rulingAgainstSeller(tx.dealCode, summary),
    );
  } catch (err) {
    logger.error(
      `[Dispute] Refund to buyer failed for ${tx.dealCode}:`,
      err.message,
    );
    await sendMessage(
      buyer.phoneNumber,
      `✅ Ruling in your favour for *${tx.dealCode}* — but refund failed. Our team will process it manually within 24 hours.`,
    );
  }
};

const applyTrustPenalty = async (dispute, ruling) => {
  if (ruling.decision === "INCONCLUSIVE") return;

  const penalty = Math.round((ruling.confidence / 100) * 15);
  const tx = dispute.transaction;
  const loserId = ruling.decision === "SELLER" ? tx.buyerId : tx.sellerId;

  await prisma.user.update({
    where: { id: loserId },
    data: {
      trustScore: { decrement: penalty },
      disputesRaised: { increment: 1 },
    },
  });

  logger.info(`[Dispute] Trust penalty -${penalty} applied to user ${loserId}`);
};
