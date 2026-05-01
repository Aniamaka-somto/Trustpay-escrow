import axios from 'axios';
import https from 'https';
import { normalisePhone } from '../utils/helpers.js';
import { formatNaira } from '../utils/fees.js';
import logger from '../utils/logger.js';
import prisma from '../utils/prisma.js';

const httpsAgent = new https.Agent({ family: 4 });

const WA_API_URL = () =>
  `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_ID}/messages`;

const BOT_NUMBER = () => process.env.WHATSAPP_BOT_NUMBER || '15556365137';

// ─── CORE SEND ────────────────────────────────────────────────────────────────

export const sendMessage = async (to, text, transactionId = null) => {
  const phone = normalisePhone(to);

  try {
    await axios.post(
      WA_API_URL(),
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phone,
        type: 'text',
        text: { body: text, preview_url: false },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
        httpsAgent,
      }
    );

    await logNotification(phone, transactionId, text).catch(() => {});
    logger.debug(`WhatsApp sent to ${phone}`);

  } catch (err) {
    logger.error(`WhatsApp send failed to ${phone}:`, err.response?.data || err.message);
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

export const msg = {

  welcome: () =>
    `👋 Welcome to TrustPay!\n\nI protect your money during WhatsApp trades. Funds are held safely until both parties confirm.\n\nWhat's your full name?`,

  askFullName: () =>
    `What's your full name?`,

  // ── IDEA 2: Bank details only asked when needed (receiving money) ──────────
  askBankDetailsFirstTime: (name) =>
    `Nice to meet you, ${name}! 👍\n\nYou're all set to start trading.\n\n` +
    `• Type *NEW DEAL* — start an escrow as a seller\n` +
    `• Type a deal code — join as a buyer\n\n` +
    `_Your bank details will be requested the first time you need to receive a payment._`,

  askBankDetailsNow: () =>
    `To receive your payment, I need your bank details:\n\nFormat: *BANK NAME / ACCOUNT NUMBER*\nExample: GTBank / 0123456789`,

  bankDetailsSaved: () =>
    `✅ Bank details saved. Processing your payout now...`,

  onboardingComplete: (name) =>
    `✅ You're all set, ${name}!\n\n` +
    `Here's what you can do:\n\n` +
    `• Type *NEW DEAL* — start an escrow as a seller\n` +
    `• Type a deal code (e.g. *TP-AB2C3D*) — join as a buyer\n` +
    `• Type *MY DEALS* — view your active deals\n\n` +
    `Your money is always protected 🔒`,

  askItem: () =>
    `What are you selling?\n\n_Describe it clearly — this becomes the binding agreement_`,

  askAmount: () =>
    `How much is the buyer paying? (Naira only, numbers only)\n\nExample: *380000*`,

  askDeliveryDays: () =>
    `How many days do you need to deliver after payment?\n\nExample: *2*`,

  // ── IDEA 4: Deal created with prefilled wa.me link ────────────────────────
  dealCreated: (tx) => {
    const buyerLink = `https://wa.me/${BOT_NUMBER()}?text=${tx.dealCode}`;
    return (
      `✅ Escrow deal created!\n\n` +
      `📦 *${tx.itemDescription}*\n` +
      `💰 Amount: ${formatNaira(tx.amountKobo)}\n` +
      `🚚 Delivery: ${tx.deliveryDays} day(s)\n\n` +
      `Your deal code: *${tx.dealCode}*\n\n` +
      `Send this link to your buyer — they just tap and send:\n` +
      `${buyerLink}`
    );
  },

  dealPreview: (tx) => {
    const total = BigInt(tx.amountKobo) + BigInt(tx.feeKobo);
    const trustEmoji = tx.seller.trustScore >= 80 ? '🟢' :
                       tx.seller.trustScore >= 60 ? '🟡' : '🔴';
    return (
      `🔍 Deal found!\n\n` +
      `👤 Seller: *${tx.seller.fullName}*\n` +
      `${trustEmoji} Trust Score: *${tx.seller.trustScore}/100* (${tx.seller.totalTransactions} trades)\n` +
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

  // ── IDEA 5: Buyer confirms, seller gets 1 hour to flag issue ─────────────
  deliveryConfirmedBuyer: (tx) =>
    `✅ Delivery confirmed for *${tx.dealCode}*\n\n` +
    `The seller has 1 hour to flag any issue. If no issue is raised, ` +
    `${formatNaira(tx.amountKobo)} will be released to their bank account automatically.\n\n` +
    `How was the transaction? Reply *RATE 1-5* to rate your experience.`,

  deliveryConfirmedSeller: (tx) =>
    `📦 Buyer confirmed delivery for *${tx.dealCode}*\n\n` +
    `${formatNaira(tx.amountKobo)} will be released to your bank in *1 hour*.\n\n` +
    `If there's a problem with this confirmation, reply *FLAG* within 1 hour.`,

  sellerFlaggedIssue: (tx) =>
    `⚠️ Issue flagged for *${tx.dealCode}*\n\n` +
    `The release has been paused. Please describe the problem — our team will review.`,

  sellerFlagNotifBuyer: (tx) =>
    `⚠️ The seller has flagged an issue with deal *${tx.dealCode}*.\n\n` +
    `Funds are temporarily paused. Our team will review and contact both parties.`,

  fundsReleasedBuyer: (tx) =>
    `✅ Payment released to seller.\n\n` +
    `How was the transaction?\n` +
    `Reply *RATE 1*, *RATE 2*, *RATE 3*, *RATE 4*, or *RATE 5*`,

  fundsReleasedSeller: (tx) =>
    `💰 *${formatNaira(tx.amountKobo)}* sent to your bank account!\n\n` +
    `Deal *${tx.dealCode}* is complete ✅`,

  // ── IDEA 3: Pending deal expired notification ─────────────────────────────
  dealExpiredSeller: (tx) =>
    `⏱ Deal *${tx.dealCode}* has expired.\n\n` +
    `${tx.itemDescription} — ${formatNaira(tx.amountKobo)}\n\n` +
    `No buyer paid within 48 hours so the deal has been closed.\n` +
    `Type *NEW DEAL* to create a fresh one.`,

  disputeOpened: (tx) =>
    `⚠️ Dispute opened for *${tx.dealCode}*\n\n` +
    `Funds are frozen until this is resolved.\n\n` +
    `Describe what went wrong:`,

  disputeEvidencePrompt: () =>
    `Got it. Now send your evidence:\n\n` +
    `• 📷 Photos of what you received\n` +
    `• 💬 Any relevant details\n\n` +
    `Type *DONE* when finished.`,

  evidenceSaved: () =>
    `📎 Saved. Send more or type *DONE* when finished.`,

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

  cannotBuyOwnDeal: () =>
    `❌ You can't join your own deal as a buyer.`,

  dealUnavailable: (status) =>
    `❌ This deal is no longer available (status: ${status.toLowerCase()}).`,

  invalidAmount: () =>
    `❌ Invalid amount. Enter a number in Naira.\nExample: *380000*`,

  invalidDays: () =>
    `❌ Please enter a number between 1 and 30.`,

  invalidBankFormat: () =>
    `❌ Invalid format. Reply with:\n*BANK NAME / ACCOUNT NUMBER*\n\nExample: GTBank / 0123456789`,

  invalidRating: () =>
    `❌ Reply with: *RATE 1*, *RATE 2*, *RATE 3*, *RATE 4*, or *RATE 5*`,

  alreadyRated: () =>
    `You've already rated this transaction.`,

  shippedNotifBuyer: (tx) =>
    `📦 Your item is on the way!\n\n` +
    `Deal: *${tx.dealCode}*\n` +
    `Item: ${tx.itemDescription}\n\n` +
    `The seller has marked it as shipped and uploaded proof.\n\n` +
    `Reply *RECEIVED* once it arrives or *DISPUTE* if there's a problem.`,

  shippedConfirmSeller: (tx) =>
    `✅ Shipment proof saved for *${tx.dealCode}*\n\n` +
    `The buyer has been notified that their item is on the way.\n\n` +
    `_Tip: Type STATUS ${tx.dealCode} anytime to check the deal timeline._`,

  unknownCommand: () =>
    `I didn't understand that 🤔\n\n` +
    `Here's what you can do:\n\n` +
    `• *NEW DEAL* — start an escrow deal\n` +
    `• *TP-XXXXXX* — join a deal as buyer\n` +
    `• *MY DEALS* — view your active deals\n` +
    `• *STATUS TP-XXXXXX* — check deal timeline\n` +
    `• *SHIPPED* — mark item as shipped (sellers)\n` +
    `• *RECEIVED* — confirm delivery (buyers)\n` +
    `• *DISPUTE* — raise a problem\n` +
    `• *CANCEL DEAL* — cancel a pending deal\n` +
    `• *RATE 1-5* — rate a completed transaction\n\n` +
    `Need help? Contact support: wa.me/${BOT_NUMBER()}`,

  error: () =>
    `Something went wrong on our end. Please try again in a moment.`,
};
