import express from 'express';
import prisma from '../utils/prisma.js';
import { triggerDisputeReview } from '../jobs/index.js';
import { payoutToBank } from '../services/paystack.js';
import { sendMessage } from '../services/whatsapp.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Simple token auth — replace with proper auth before going live
router.use((req, res, next) => {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ── STATS ─────────────────────────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  const [txStats, disputeStats, userCount] = await Promise.all([
    prisma.transaction.groupBy({
      by: ['status'],
      _count: true,
      _sum: { amountKobo: true, feeKobo: true },
    }),
    prisma.dispute.groupBy({ by: ['status'], _count: true }),
    prisma.user.count(),
  ]);

  res.json({ txStats, disputeStats, userCount });
});

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  const { status, take = '50', skip = '0' } = req.query;
  const transactions = await prisma.transaction.findMany({
    where: status ? { status } : undefined,
    include: { seller: true, buyer: true },
    orderBy: { createdAt: 'desc' },
    take: parseInt(take),
    skip: parseInt(skip),
  });
  res.json({ transactions });
});

// Force-release a stuck transaction
router.post('/transactions/:id/release', async (req, res) => {
  const tx = await prisma.transaction.findUnique({
    where: { id: req.params.id },
    include: { seller: true },
  });
  if (!tx) return res.status(404).json({ error: 'Not found' });

  try {
    await payoutToBank({
      name: tx.seller.fullName,
      accountNumber: tx.seller.accountNumber,
      bankName: tx.seller.bankName,
      amountKobo: tx.amountKobo,
      reference: `TP-ADMIN-RELEASE-${tx.dealCode}-${Date.now()}`,
      reason: `Admin manual release — ${tx.dealCode}`,
    });
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DISPUTES ──────────────────────────────────────────────────────────────────
router.get('/disputes', async (req, res) => {
  const disputes = await prisma.dispute.findMany({
    include: {
      transaction: { include: { seller: true, buyer: true } },
      evidence: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ disputes });
});

// Trigger AI review on a specific dispute
router.post('/disputes/:id/review', async (req, res) => {
  try {
    const ruling = await triggerDisputeReview(req.params.id);
    res.json({ success: true, ruling });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual override — admin decides outcome
router.post('/disputes/:id/override', async (req, res) => {
  const { decision, reason } = req.body;
  if (!['BUYER', 'SELLER'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be BUYER or SELLER' });
  }

  const dispute = await prisma.dispute.findUnique({
    where: { id: req.params.id },
    include: { transaction: { include: { seller: true, buyer: true } } },
  });
  if (!dispute) return res.status(404).json({ error: 'Not found' });

  await prisma.dispute.update({
    where: { id: req.params.id },
    data: {
      status: `RESOLVED_${decision}`,
      aiRuling: decision,
      aiReasoning: `Admin override: ${reason}`,
      resolvedAt: new Date(),
    },
  });

  const tx = dispute.transaction;
  const note = `📋 Dispute *${tx.dealCode}* resolved by admin: ${reason}`;
  await sendMessage(tx.seller.phoneNumber, note);
  await sendMessage(tx.buyer.phoneNumber, note);

  res.json({ success: true });
});

// ── USERS ─────────────────────────────────────────────────────────────────────
router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  res.json({ users });
});

export default router;
