import axios from "axios";
import crypto from "crypto";
import logger from "../utils/logger.js";

const BASE = "https://api.paystack.co";
const headers = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  "Content-Type": "application/json",
});

// ─── PAYMENTS ─────────────────────────────────────────────────────────────────

export const initializePayment = async ({
  email,
  amountKobo,
  reference,
  metadata,
}) => {
  const { data } = await axios.post(
    `${BASE}/transaction/initialize`,
    {
      email,
      amount: Number(amountKobo),
      reference,
      metadata,
      callback_url: `${process.env.APP_URL}/payment/callback`,
    },
    { headers: headers() },
  );
  return data.data; // { authorization_url, access_code, reference }
};

export const verifyTransaction = async (reference) => {
  const { data } = await axios.get(`${BASE}/transaction/verify/${reference}`, {
    headers: headers(),
  });
  return data.data;
};

// ─── PAYOUTS ──────────────────────────────────────────────────────────────────

export const createTransferRecipient = async ({
  name,
  accountNumber,
  bankCode,
}) => {
  const { data } = await axios.post(
    `${BASE}/transferrecipient`,
    {
      type: "nuban",
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: "NGN",
    },
    { headers: headers() },
  );
  return data.data;
};

export const initiateTransfer = async ({
  amountKobo,
  recipientCode,
  reason,
  reference,
}) => {
  const { data } = await axios.post(
    `${BASE}/transfer`,
    {
      source: "balance",
      amount: Number(amountKobo),
      recipient: recipientCode,
      reason,
      reference,
    },
    { headers: headers() },
  );
  return data.data;
};

// Full payout: create recipient → transfer
export const payoutToBank = async ({
  name,
  accountNumber,
  bankName,
  amountKobo,
  reference,
  reason,
}) => {
  const bankCode = getBankCode(bankName);
  if (!bankCode) throw new Error(`Unknown bank: ${bankName}`);

  const recipient = await createTransferRecipient({
    name,
    accountNumber,
    bankCode,
  });
  const transfer = await initiateTransfer({
    amountKobo,
    recipientCode: recipient.recipient_code,
    reason,
    reference,
  });

  logger.info(
    `Payout initiated: ${reference} → ${name} (${formatNaira(amountKobo)})`,
  );
  return transfer;
};

// ─── WEBHOOK ──────────────────────────────────────────────────────────────────

export const verifySignature = (rawBody, signature) => {
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest("hex");
  return hash === signature;
};

// ─── BANK CODES ───────────────────────────────────────────────────────────────

const BANKS = {
  "access bank": "044",
  access: "044",
  citibank: "023",
  ecobank: "050",
  "fidelity bank": "070",
  fidelity: "070",
  "first bank": "011",
  "first bank of nigeria": "011",
  fcmb: "214",
  "first city monument bank": "214",
  gtbank: "058",
  "guaranty trust bank": "058",
  "gt bank": "058",
  "heritage bank": "030",
  "keystone bank": "082",
  kuda: "090267",
  "kuda bank": "090267",
  moniepoint: "090405",
  opay: "100004",
  palmpay: "100033",
  "polaris bank": "076",
  "providus bank": "101",
  "stanbic ibtc": "221",
  stanbic: "221",
  "sterling bank": "232",
  sterling: "232",
  uba: "033",
  "united bank for africa": "033",
  "union bank": "032",
  "unity bank": "215",
  "wema bank": "035",
  wema: "035",
  "zenith bank": "057",
  zenith: "057",
};

export const getBankCode = (name) => BANKS[name?.toLowerCase().trim()] || null;

const formatNaira = (kobo) =>
  `₦${(Number(kobo) / 100).toLocaleString("en-NG")}`;
