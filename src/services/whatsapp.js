import axios from "axios";
import { normalisePhone } from "../utils/helpers.js";
import { formatNaira } from "../utils/fees.js";
import logger from "../utils/logger.js";
import prisma from "../utils/prisma.js";
import https from "https";

const httpsAgent = new https.Agent({ family: 4 });
const WA_API_URL = () =>
  `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

// ─── CORE SEND ────────────────────────────────────────────────────────────────

export const sendMessage = async (to, text, transactionId = null) => {
  const phone = normalisePhone(to);
  console.log("=== SENDING TO URL ===", WA_API_URL());
  console.log("=== SENDING WHATSAPP ===", phone, text?.slice(0, 30));
  console.log("=== USING TOKEN ===", process.env.WHATSAPP_TOKEN?.slice(0, 15));
  console.log("=== USING PHONE ID ===", process.env.WHATSAPP_PHONE_ID);

  try {
    const response = await axios.post(
      WA_API_URL(),
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: phone,
        type: "text",
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
        httpsAgent,
      },
    );

    // Log notification
    await logNotification(phone, transactionId, text).catch(() => {});
    logger.debug(`WhatsApp sent to ${phone}`);

    // } catch (err) {
    //   logger.error(`WhatsApp send failed to ${phone}:`, err.response?.data || err.message);
    //   // Never throw — messaging failure should not break transaction logic
    // }
  } catch (err) {
    console.log("=== SEND ERROR FULL ===", JSON.stringify(err.response?.data));
    console.log("=== SEND ERROR MESSAGE ===", err.message);
    console.log("=== SEND ERROR CODE ===", err.code);
    logger.error(
      `WhatsApp send failed to ${phone}:`,
      err.response?.data || err.message,
    );
  }
};

const logNotification = async (phone, transactionId, message) => {
  const user = await prisma.user.findUnique({ where: { phoneNumber: phone } });
  if (!user) return;
  await prisma.notification.create({
    data: {
      userId: user.id,
      transactionId: transactionId || undefined,
      message,
      sent: true,
      sentAt: new Date(),
    },
  });
};

// ─── ALL BOT MESSAGES ─────────────────────────────────────────────────────────
// Centralised here so copy changes don't require touching logic files

export const msg = {
  welcome: () =>
    `👋 Welcome to TrustPay!\n\nI protect your money during WhatsApp trades. Funds are held safely until you confirm delivery.\n\nWhat's your full name?`,

  askBankDetails: (name) =>
    `Nice to meet you, ${name}! 👍\n\nEnter your bank details for receiving payments:\n\nFormat: *BANK NAME / ACCOUNT NUMBER*\nExample: GTBank / 0123456789`,

  onboardingComplete: (name) =>
    `✅ You're all set, ${name}!\n\n` +
    `Here's what you can do:\n\n` +
    `• Type *NEW DEAL* — start an escrow as a seller\n` +
    `• Type a deal code (e.g. *TP-AB2C3D*) — join as a buyer\n\n` +
    `Your money is always protected 🔒`,

  askItem: () =>
    `What are you selling?\n\n_Describe it clearly — this becomes the binding agreement_`,

  askAmount: () =>
    `How much is the buyer paying? (Naira only, numbers only)\n\nExample: *380000*`,

  askDeliveryDays: () =>
    `How many days do you need to deliver after payment?\n\nExample: *2*`,

  dealCreated: (tx) =>
    `✅ Escrow deal created!\n\n` +
    `📦 *${tx.itemDescription}*\n` +
    `💰 Amount: ${formatNaira(tx.amountKobo)}\n` +
    `🚚 Delivery: ${tx.deliveryDays} day(s)\n\n` +
    `Your deal code is:\n\n` +
    `*${tx.dealCode}*\n\n` +
    `Send this code to your buyer on WhatsApp. They'll use it to pay into escrow.`,

  dealPreview: (tx) => {
    const total = BigInt(tx.amountKobo) + BigInt(tx.feeKobo);
    return (
      `🔍 Deal found!\n\n` +
      `👤 Seller: *${tx.seller.fullName}*\n` +
      `📦 Item: ${tx.itemDescription}\n` +
      `💰 Price: ${formatNaira(tx.amountKobo)}\n` +
      `📋 Fee (1.5%): ${formatNaira(tx.feeKobo)}\n` +
      `💳 *Total: ${formatNaira(total)}*\n` +
      `🚚 Delivery: ${tx.deliveryDays} day(s)\n\n` +
      `Type *AGREE* to proceed to payment.`
    );
  },

  paymentLink: (token, dealCode) =>
    `💳 Pay securely here:\n${process.env.APP_URL}/pay/${token}\n\n` +
    `⏱ Link expires in 30 minutes\n\n` +
    `Your money goes to escrow — *not* to the seller — until you confirm delivery.\n\n` +
    `Deal code: *${dealCode}*`,

  paymentConfirmedBuyer: (tx) =>
    `✅ Payment confirmed!\n\n` +
    `${formatNaira(BigInt(tx.amountKobo) + BigInt(tx.feeKobo))} is now held in escrow.\n\n` +
    `The seller has been notified to deliver *${tx.itemDescription}* within *${tx.deliveryDays} day(s)*.\n\n` +
    `Once it arrives, reply *RECEIVED* to release payment to the seller.\n` +
    `If there's a problem, reply *DISPUTE*.`,

  paymentConfirmedSeller: (tx) =>
    `🎉 Payment secured in escrow!\n\n` +
    `Deal: *${tx.dealCode}*\n` +
    `Item: ${tx.itemDescription}\n` +
    `You'll receive: *${formatNaira(tx.amountKobo)}*\n\n` +
    `Please deliver within *${tx.deliveryDays} day(s)*. Once the buyer confirms receipt, funds go straight to your bank.`,

  reminderBuyer: (tx, daysLeft) =>
    `⏰ Reminder — deal *${tx.dealCode}*\n\n` +
    `Has your *${tx.itemDescription}* arrived?\n\n` +
    `• Reply *RECEIVED* to release payment\n` +
    `• Reply *DISPUTE* if there's a problem\n\n` +
    `*${daysLeft} day(s)* left before auto-release to seller.`,

  autoReleaseBuyerFinal: (tx) =>
    `⏱ Auto-release triggered — *${tx.dealCode}*\n\n` +
    `No response received after ${process.env.AUTO_RELEASE_DAYS} days.\n\n` +
    `Funds have been released to the seller per escrow terms.\n\n` +
    `If you have a genuine complaint, contact support within 48 hours.`,

  autoReleaseSeller: (tx) =>
    `💰 Payment released — *${tx.dealCode}*\n\n` +
    `${formatNaira(tx.amountKobo)} is on its way to your bank account.\n\n` +
    `_(Auto-released after buyer did not respond)_`,

  fundsReleasedBuyer: (tx) =>
    `✅ Payment released to seller.\n\n` +
    `How was the transaction?\n` +
    `Reply *RATE 1*, *RATE 2*, *RATE 3*, *RATE 4*, or *RATE 5*`,

  fundsReleasedSeller: (tx) =>
    `💰 *${formatNaira(tx.amountKobo)}* sent to your bank account!\n\n` +
    `Deal *${tx.dealCode}* is complete ✅`,

  disputeOpened: (tx) =>
    `⚠️ Dispute opened for *${tx.dealCode}*\n\n` +
    `Funds are frozen until this is resolved.\n\n` +
    `Describe what went wrong:`,

  disputeEvidencePrompt: () =>
    `Got it. Now send your evidence:\n\n` +
    `• 📷 Photos of what you received\n` +
    `• 💬 Any relevant details\n\n` +
    `Type *DONE* when finished.`,

  evidenceSaved: () => `📎 Saved. Send more or type *DONE* when finished.`,

  disputeSubmitted: () =>
    `📋 Evidence submitted. The seller has 24 hours to respond.\n\n` +
    `We'll review everything and notify you of the ruling within 48 hours.\n` +
    `Funds remain frozen until resolved.`,

  disputeNotifySeller: (tx) =>
    `⚠️ Dispute raised on your deal *${tx.dealCode}*\n\n` +
    `Item: ${tx.itemDescription}\n\n` +
    `The buyer has raised an issue. You have 24 hours to respond.\n\n` +
    `Type *RESPOND* to submit your side.`,

  rulingBuyerWins: (dealCode, summary) =>
    `✅ Dispute ruling — *${dealCode}*\n\n` +
    `*Ruling: Refund approved*\n\n` +
    `${summary}\n\n` +
    `Your refund is being processed.`,

  rulingSellerWins: (dealCode, summary) =>
    `✅ Dispute ruling — *${dealCode}*\n\n` +
    `*Ruling: Funds released to you*\n\n` +
    `${summary}\n\n` +
    `Payment is on its way to your bank account.`,

  rulingAgainstBuyer: (dealCode, summary) =>
    `📋 Dispute ruling — *${dealCode}*\n\n` +
    `*Ruling: In favour of seller*\n\n` +
    `${summary}\n\n` +
    `If you believe this is wrong, contact support within 48 hours.`,

  rulingAgainstSeller: (dealCode, summary) =>
    `📋 Dispute ruling — *${dealCode}*\n\n` +
    `*Ruling: Refund issued to buyer*\n\n` +
    `${summary}\n\n` +
    `If you believe this is wrong, contact support within 48 hours.`,

  disputeEscalated: (dealCode) =>
    `⚠️ Dispute *${dealCode}* escalated to manual review.\n\n` +
    `A team member will contact both parties within 24 hours.\n` +
    `Funds remain frozen and safe.`,

  ratingSaved: (score, name) =>
    `⭐ Rating saved (${score}/5) — ${name}'s trust score updated.\n\n` +
    `Type *NEW DEAL* to start another transaction.`,

  noActiveDeal: () =>
    `You don't have an active deal right now.\n\n` +
    `Type *NEW DEAL* to start one, or enter a deal code to join as a buyer.`,

  dealNotFound: (code) =>
    `❌ Deal *${code}* not found. Check the code and try again.`,

  cannotBuyOwnDeal: () => `❌ You can't join your own deal as a buyer.`,

  dealUnavailable: (status) =>
    `❌ This deal is no longer available (status: ${status.toLowerCase()}).`,

  invalidAmount: () =>
    `❌ Invalid amount. Enter a number in Naira.\nExample: *380000*`,

  invalidDays: () => `❌ Please enter a number between 1 and 30.`,

  invalidBankFormat: () =>
    `❌ Invalid format. Reply with:\n*BANK NAME / ACCOUNT NUMBER*\n\nExample: GTBank / 0123456789`,

  invalidRating: () =>
    `❌ Reply with: *RATE 1*, *RATE 2*, *RATE 3*, *RATE 4*, or *RATE 5*`,

  alreadyRated: () => `You've already rated this transaction.`,

  unknownCommand: () =>
    `I didn't understand that 🤔\n\n` +
    `Here's what you can do:\n\n` +
    `• *NEW DEAL* — start an escrow deal\n` +
    `• *TP-XXXXXX* — join a deal as buyer\n` +
    `• *RECEIVED* — confirm delivery\n` +
    `• *DISPUTE* — raise a problem\n` +
    `• *RATE 1-5* — rate a completed transaction`,

  error: () => `Something went wrong on our end. Please try again in a moment.`,
};
