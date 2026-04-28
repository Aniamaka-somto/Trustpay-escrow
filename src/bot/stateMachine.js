import prisma from "../utils/prisma.js";
import { sendMessage, msg } from "../services/whatsapp.js";
import { payoutToBank } from "../services/paystack.js";
import { generateDealCode, isDealCode } from "../utils/dealCode.js";
import { calculateFee, parseNairaInput, formatNaira } from "../utils/fees.js";
import {
  generateToken,
  paymentLinkExpiry,
  autoReleaseDate,
  daysUntil,
} from "../utils/helpers.js";
import logger from "../utils/logger.js";

const sessions = new Map();
const getSession = (phone) => sessions.get(phone) || { step: "idle", data: {} };
const setSession = (phone, step, data = {}) =>
  sessions.set(phone, { step, data });
const clearSession = (phone) => sessions.delete(phone);

export const handleMessage = async (
  phone,
  text,
  messageType = "text",
  mediaId = null,
) => {
  console.log("=== HANDLE MESSAGE ===", { phone, text, messageType });

  const input = (text || "").trim();
  const upper = input.toUpperCase();
  const session = getSession(phone);

  try {
    console.log("=== DB LOOKUP START ===");
    let user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
    console.log(
      "=== DB LOOKUP DONE ===",
      user ? `found: ${user.id}` : "not found",
    );

    if (!user) {
      console.log("=== CREATING USER ===");
      user = await prisma.user.create({ data: { phoneNumber: phone } });
      console.log("=== USER CREATED ===", user.id);
      setSession(phone, "awaiting_name");
      console.log("=== SENDING WELCOME ===");
      await sendMessage(phone, msg.welcome());
      console.log("=== WELCOME SENT ===");
      return;
    }

    if (!user.onboarded) {
      console.log("=== ONBOARDING FLOW ===", session.step);
      return onboardingFlow(phone, user, input, session);
    }

    if (session.step === "collecting_evidence") {
      return evidenceFlow(
        phone,
        user,
        input,
        upper,
        messageType,
        mediaId,
        session,
      );
    }

    if (session.step.startsWith("new_deal_")) {
      return newDealFlow(phone, user, input, session);
    }

    if (upper === "NEW DEAL") {
      setSession(phone, "new_deal_item", {});
      return sendMessage(phone, msg.askItem());
    }

    if (upper === "AGREE") return handleAgree(phone, user, session);
    if (upper === "RECEIVED") return handleConfirmDelivery(phone, user);
    if (upper === "DISPUTE") return handleOpenDispute(phone, user);
    if (upper === "RESPOND") return handleSellerRespond(phone, user);
    if (upper === "DONE") return handleEvidenceDone(phone, user, session);

    if (upper.startsWith("RATE ")) {
      const score = parseInt(upper.split(" ")[1]);
      return handleRating(phone, user, score);
    }

    if (isDealCode(upper)) return handleBuyerJoin(phone, user, upper);

    console.log("=== UNKNOWN COMMAND ===", upper);
    sendMessage(phone, msg.unknownCommand());
  } catch (err) {
    console.log("=== HANDLE MESSAGE ERROR ===", err.message);
    console.log("=== ERROR STACK ===", err.stack);
    logger.error(`Message handler error for ${phone}:`, err);
    sendMessage(phone, msg.error());
  }
};

const onboardingFlow = async (phone, user, input, session) => {
  if (
    !session.step ||
    session.step === "idle" ||
    session.step === "awaiting_name"
  ) {
    if (input.length < 2)
      return sendMessage(phone, `Please enter your full name.`);
    setSession(phone, "awaiting_bank", { fullName: input });
    return sendMessage(phone, msg.askBankDetails(input));
  }

  if (session.step === "awaiting_bank") {
    const parts = input.split("/").map((p) => p.trim());
    if (parts.length !== 2 || !/^\d{10}$/.test(parts[1])) {
      return sendMessage(phone, msg.invalidBankFormat());
    }
    const [bankName, accountNumber] = parts;
    await prisma.user.update({
      where: { phoneNumber: phone },
      data: {
        fullName: session.data.fullName,
        bankName,
        accountNumber,
        onboarded: true,
      },
    });
    clearSession(phone);
    return sendMessage(phone, msg.onboardingComplete(session.data.fullName));
  }
};

const newDealFlow = async (phone, user, input, session) => {
  if (session.step === "new_deal_item") {
    if (input.length < 5)
      return sendMessage(phone, `Please describe the item more clearly.`);
    setSession(phone, "new_deal_amount", { item: input });
    return sendMessage(phone, msg.askAmount());
  }
  if (session.step === "new_deal_amount") {
    const amountKobo = parseNairaInput(input);
    if (!amountKobo) return sendMessage(phone, msg.invalidAmount());
    setSession(phone, "new_deal_days", { ...session.data, amountKobo });
    return sendMessage(phone, msg.askDeliveryDays());
  }
  if (session.step === "new_deal_days") {
    const days = parseInt(input);
    if (!days || days < 1 || days > 30)
      return sendMessage(phone, msg.invalidDays());
    const feeKobo = calculateFee(session.data.amountKobo);
    const tx = await prisma.transaction.create({
      data: {
        dealCode: generateDealCode(),
        sellerId: user.id,
        itemDescription: session.data.item,
        amountKobo: session.data.amountKobo,
        feeKobo,
        deliveryDays: days,
      },
    });
    clearSession(phone);
    return sendMessage(phone, msg.dealCreated(tx), tx.id);
  }
};

const handleBuyerJoin = async (phone, user, dealCode) => {
  const tx = await prisma.transaction.findUnique({
    where: { dealCode },
    include: { seller: true },
  });
  if (!tx) return sendMessage(phone, msg.dealNotFound(dealCode));
  if (tx.sellerId === user.id)
    return sendMessage(phone, msg.cannotBuyOwnDeal());
  if (tx.status !== "PENDING")
    return sendMessage(phone, msg.dealUnavailable(tx.status));
  setSession(phone, "awaiting_agree", { dealCode });
  return sendMessage(phone, msg.dealPreview(tx));
};

const handleAgree = async (phone, user, session) => {
  if (session.step !== "awaiting_agree")
    return sendMessage(phone, msg.unknownCommand());
  const tx = await prisma.transaction.findUnique({
    where: { dealCode: session.data.dealCode },
  });
  if (!tx || tx.status !== "PENDING") {
    clearSession(phone);
    return sendMessage(phone, msg.dealUnavailable(tx?.status || "UNKNOWN"));
  }
  const token = generateToken();
  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      buyerId: user.id,
      paymentLinkToken: token,
      paymentLinkExpiresAt: paymentLinkExpiry(),
    },
  });
  clearSession(phone);
  return sendMessage(phone, msg.paymentLink(token, tx.dealCode), tx.id);
};

const handleConfirmDelivery = async (phone, user) => {
  const tx = await prisma.transaction.findFirst({
    where: { buyerId: user.id, status: "FUNDED" },
    include: { seller: true },
    orderBy: { fundedAt: "desc" },
  });
  if (!tx) return sendMessage(phone, msg.noActiveDeal());
  await prisma.transaction.update({
    where: { id: tx.id },
    data: { status: "CONFIRMED", confirmedAt: new Date() },
  });
  try {
    await payoutToBank({
      name: tx.seller.fullName,
      accountNumber: tx.seller.accountNumber,
      bankName: tx.seller.bankName,
      amountKobo: tx.amountKobo,
      reference: `TP-PAYOUT-${tx.dealCode}-${Date.now()}`,
      reason: `TrustPay escrow release — ${tx.dealCode}`,
    });
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: "RELEASED", releasedAt: new Date() },
    });
  } catch (err) {
    logger.error(`Payout failed for ${tx.dealCode}:`, err.message);
  }
  await sendMessage(phone, msg.fundsReleasedBuyer(tx), tx.id);
  await sendMessage(tx.seller.phoneNumber, msg.fundsReleasedSeller(tx), tx.id);
};

const handleOpenDispute = async (phone, user) => {
  const tx = await prisma.transaction.findFirst({
    where: { buyerId: user.id, status: "FUNDED" },
    include: { seller: true },
    orderBy: { fundedAt: "desc" },
  });
  if (!tx) return sendMessage(phone, msg.noActiveDeal());
  await prisma.transaction.update({
    where: { id: tx.id },
    data: { status: "DISPUTED" },
  });
  setSession(phone, "collecting_evidence", {
    transactionId: tx.id,
    disputeId: null,
  });
  await sendMessage(phone, msg.disputeOpened(tx), tx.id);
  await sendMessage(tx.seller.phoneNumber, msg.disputeNotifySeller(tx), tx.id);
};

const handleSellerRespond = async (phone, user) => {
  const dispute = await prisma.dispute.findFirst({
    where: {
      transaction: { sellerId: user.id },
      status: { in: ["OPEN", "AWAITING_SELLER"] },
    },
    include: { transaction: true },
    orderBy: { createdAt: "desc" },
  });
  if (!dispute) return sendMessage(phone, msg.noActiveDeal());
  setSession(phone, "collecting_evidence", {
    transactionId: dispute.transactionId,
    disputeId: dispute.id,
    isSeller: true,
  });
  await sendMessage(phone, msg.disputeEvidencePrompt());
};

const evidenceFlow = async (
  phone,
  user,
  input,
  upper,
  messageType,
  mediaId,
  session,
) => {
  if (!session.data.disputeId && !session.data.isSeller) {
    const dispute = await prisma.dispute.create({
      data: {
        transactionId: session.data.transactionId,
        raisedById: user.id,
        reason: input,
        status: "OPEN",
      },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { disputesRaised: { increment: 1 } },
    });
    setSession(phone, "collecting_evidence", {
      ...session.data,
      disputeId: dispute.id,
    });
    return sendMessage(phone, msg.disputeEvidencePrompt());
  }
  if (upper === "DONE")
    return handleEvidenceDone(phone, user, getSession(phone));
  const disputeId = session.data.disputeId;
  if (disputeId) {
    await prisma.disputeEvidence.create({
      data: {
        disputeId,
        submittedBy: user.id,
        type: mediaId ? "IMAGE" : "TEXT",
        fileUrl: mediaId || null,
        description: input || null,
      },
    });
  }
  sendMessage(phone, msg.evidenceSaved());
};

const handleEvidenceDone = async (phone, user, session) => {
  if (session.step !== "collecting_evidence" || !session.data.disputeId) return;
  await prisma.dispute.update({
    where: { id: session.data.disputeId },
    data: { status: "AI_REVIEW" },
  });
  clearSession(phone);
  sendMessage(phone, msg.disputeSubmitted());
};

const handleRating = async (phone, user, score) => {
  if (!score || score < 1 || score > 5)
    return sendMessage(phone, msg.invalidRating());
  const tx = await prisma.transaction.findFirst({
    where: { buyerId: user.id, status: { in: ["RELEASED", "CONFIRMED"] } },
    include: { seller: true },
    orderBy: { releasedAt: "desc" },
  });
  if (!tx) return sendMessage(phone, msg.noActiveDeal());
  const existing = await prisma.rating.findUnique({
    where: {
      transactionId_ratedById: { transactionId: tx.id, ratedById: user.id },
    },
  });
  if (existing) return sendMessage(phone, msg.alreadyRated());
  await prisma.rating.create({
    data: {
      transactionId: tx.id,
      ratedById: user.id,
      ratedUserId: tx.sellerId,
      score,
    },
  });
  const ratings = await prisma.rating.aggregate({
    where: { ratedUserId: tx.sellerId },
    _avg: { score: true },
    _count: true,
  });
  await prisma.user.update({
    where: { id: tx.sellerId },
    data: {
      trustScore: Math.round((ratings._avg.score || 0) * 20),
      totalTransactions: { increment: 1 },
    },
  });
  sendMessage(phone, msg.ratingSaved(score, tx.seller.fullName));
};
