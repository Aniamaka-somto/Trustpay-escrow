const FEE_RATE = 0.025;          // 2.5%
const FEE_CAP_KOBO = 500_000;   // ₦5,000 cap

export const calculateFee = (amountKobo) => {
  const fee = Math.round(Number(amountKobo) * FEE_RATE);
  return Math.min(fee, FEE_CAP_KOBO);
};

// ₦380000 → "₦380,000"
export const formatNaira = (kobo) =>
  `₦${(Number(kobo) / 100).toLocaleString('en-NG')}`;

// "50000" → 5000000 (kobo) — validates input
export const parseNairaInput = (input) => {
  const cleaned = String(input).replace(/[^0-9]/g, '');
  const naira = parseInt(cleaned);
  if (!naira || naira < 100) return null;   // Minimum ₦100
  if (naira > 50_000_000) return null;      // Maximum ₦50M per transaction
  return naira * 100;                        // Convert to kobo
};
