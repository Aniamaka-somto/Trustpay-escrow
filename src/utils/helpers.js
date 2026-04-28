import crypto from 'crypto';

// Normalise Nigerian phone number to international format
// Accepts: 08012345678, +2348012345678, 2348012345678
export const normalisePhone = (raw) => {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0'))   return `234${digits.slice(1)}`;
  return digits;
};

// Generate a secure random token for payment links
export const generateToken = () => crypto.randomBytes(32).toString('hex');

// Payment link expiry
export const paymentLinkExpiry = () => {
  const minutes = parseInt(process.env.PAYMENT_LINK_EXPIRY_MINUTES || '30');
  return new Date(Date.now() + minutes * 60 * 1000);
};

// Auto-release date
export const autoReleaseDate = (fundedAt) => {
  const days = parseInt(process.env.AUTO_RELEASE_DAYS || '7');
  const base = fundedAt ? new Date(fundedAt) : new Date();
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
};

// Days remaining until a date
export const daysUntil = (date) => {
  const ms = new Date(date) - new Date();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
};
