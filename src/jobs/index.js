import cron from 'node-cron';
import prisma from '../utils/prisma.js';
import { resolveDispute } from '../services/botEngine.js';
import logger from '../utils/logger.js';

// Hourly — picks up disputes ready for AI review (open > 24h)
export const startDisputeReviewJob = () => {
  cron.schedule('0 * * * *', async () => {
    logger.info('Running dispute review job...');

    const ready = await prisma.dispute.findMany({
      where: {
        status: 'AI_REVIEW',
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      include: { transaction: true },
    });

    logger.info(`Disputes ready for AI review: ${ready.length}`);

    for (const dispute of ready) {
      try {
        const ruling = await resolveDispute(dispute.id);
        logger.info(`Resolved ${dispute.transaction.dealCode}: ${ruling.decision}`);
      } catch (err) {
        logger.error(`Failed to resolve dispute ${dispute.id}:`, err.message);
      }
    }
  }, { timezone: 'Africa/Lagos' });

  logger.info('✅ Dispute review job scheduled (hourly)');
};

// Manual trigger for admin use
export const triggerDisputeReview = (disputeId) => resolveDispute(disputeId);
