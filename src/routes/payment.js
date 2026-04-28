import express from "express";
import prisma from "../utils/prisma.js";
import { initializePayment } from "../services/paystack.js";
import { formatNaira } from "../utils/fees.js";

const router = express.Router();

// GET /pay/:token — render the payment page
router.get("/:token", async (req, res) => {
  const tx = await prisma.transaction.findFirst({
    where: {
      paymentLinkToken: req.params.token,
      paymentLinkExpiresAt: { gt: new Date() },
      status: "PENDING",
    },
    include: { seller: true },
  });

  if (!tx) return res.status(410).send(expiredPage());

  const total = BigInt(tx.amountKobo) + BigInt(tx.feeKobo);
  const expiry = new Date(tx.paymentLinkExpiresAt).toLocaleTimeString("en-NG", {
    hour: "2-digit",
    minute: "2-digit",
  });

  res.send(payPage(tx, total, expiry, req.params.token));
});

// POST /pay/:token/charge — initialize Paystack payment
router.post("/:token/charge", async (req, res) => {
  const tx = await prisma.transaction.findFirst({
    where: {
      paymentLinkToken: req.params.token,
      paymentLinkExpiresAt: { gt: new Date() },
      status: "PENDING",
    },
    include: { buyer: true },
  });

  if (!tx) return res.status(410).json({ error: "Link expired" });

  const total = BigInt(tx.amountKobo) + BigInt(tx.feeKobo);
  const email = `${tx.buyer.phoneNumber}@pay.trustpay.ng`;

  const data = await initializePayment({
    email,
    amountKobo: total,
    reference: `TP-${tx.dealCode}-${Date.now()}`,
    metadata: { transactionId: tx.id, dealCode: tx.dealCode },
  });

  res.json({ authorizationUrl: data.authorization_url });
});

// JSON API for Lovable — GET /api/pay/:token
router.get("/api/:token", async (req, res) => {
  const tx = await prisma.transaction.findFirst({
    where: {
      paymentLinkToken: req.params.token,
      paymentLinkExpiresAt: { gt: new Date() },
      status: "PENDING",
    },
    include: { seller: true },
  });

  if (!tx) return res.status(410).json({ error: "expired" });

  res.json({
    dealCode: tx.dealCode,
    sellerName: tx.seller.fullName,
    item: tx.itemDescription,
    amountKobo: Number(tx.amountKobo),
    feeKobo: Number(tx.feeKobo),
    totalKobo: Number(tx.amountKobo) + Number(tx.feeKobo),
    deliveryDays: tx.deliveryDays,
    expiresAt: tx.paymentLinkExpiresAt,
  });
});

// JSON API for Lovable — POST /api/pay/:token/charge
router.post("/api/:token/charge", async (req, res) => {
  const tx = await prisma.transaction.findFirst({
    where: {
      paymentLinkToken: req.params.token,
      paymentLinkExpiresAt: { gt: new Date() },
      status: "PENDING",
    },
    include: { buyer: true },
  });

  if (!tx) return res.status(410).json({ error: "expired" });

  const total = Number(tx.amountKobo) + Number(tx.feeKobo);
  const email = `${tx.buyer.phoneNumber}@pay.trustpay.ng`;

  const data = await initializePayment({
    email,
    amountKobo: total,
    reference: `TP-${tx.dealCode}-${Date.now()}`,
    metadata: { transactionId: tx.id, dealCode: tx.dealCode },
  });

  res.json({ authorizationUrl: data.authorization_url });
});

// ─── PAGE TEMPLATES ───────────────────────────────────────────────────────────

const payPage = (tx, totalKobo, expiry, token) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pay — ${tx.dealCode} | TrustPay</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}
    .card{background:#fff;border-radius:20px;padding:32px 24px;max-width:400px;width:100%;box-shadow:0 4px 24px rgba(0,0,0,.08)}
    .logo{font-size:15px;font-weight:700;color:#111;margin-bottom:24px;display:flex;align-items:center;gap:8px}
    .badge{background:#e8f5e9;color:#2e7d32;font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px;letter-spacing:.04em}
    .expiry{background:#fff8e1;color:#e65100;font-size:12px;padding:9px 13px;border-radius:10px;margin-bottom:20px;text-align:center;font-weight:500}
    h2{font-size:14px;font-weight:600;color:#444;margin-bottom:14px;text-transform:uppercase;letter-spacing:.04em}
    .row{display:flex;justify-content:space-between;align-items:flex-start;padding:11px 0;border-bottom:1px solid #f4f4f4;font-size:14px}
    .row:last-child{border:none}
    .label{color:#888}
    .value{font-weight:500;color:#111;text-align:right;max-width:58%}
    .total{background:#f8f9fa;border-radius:12px;padding:16px;margin:18px 0;display:flex;justify-content:space-between;align-items:center}
    .total-label{font-size:14px;color:#555;font-weight:500}
    .total-amount{font-size:24px;font-weight:800;color:#111}
    .btn{width:100%;background:#0a8f60;color:#fff;border:none;border-radius:12px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:.02em;margin-top:4px;transition:background .15s}
    .btn:hover{background:#077a52}
    .btn:disabled{background:#bbb;cursor:not-allowed}
    .fine{font-size:11px;color:#aaa;text-align:center;margin-top:14px;line-height:1.6}
  </style>
</head>
<body>
<div class="card">
  <div class="logo">🔒 TrustPay <span class="badge">ESCROW</span></div>
  <div class="expiry">⏱ Link expires at ${expiry}</div>
  <h2>Deal summary</h2>
  <div class="row"><span class="label">Deal code</span><span class="value">${tx.dealCode}</span></div>
  <div class="row"><span class="label">Seller</span><span class="value">${tx.seller.fullName}</span></div>
  <div class="row"><span class="label">Item</span><span class="value">${tx.itemDescription}</span></div>
  <div class="row"><span class="label">Item price</span><span class="value">${formatNaira(tx.amountKobo)}</span></div>
  <div class="row"><span class="label">Escrow fee (1.5%)</span><span class="value">${formatNaira(tx.feeKobo)}</span></div>
  <div class="total">
    <span class="total-label">Total to pay</span>
    <span class="total-amount">${formatNaira(totalKobo)}</span>
  </div>
  <button class="btn" id="btn" onclick="pay()">Pay Securely →</button>
  <p class="fine">Funds go to escrow — not the seller — until you confirm delivery on WhatsApp.</p>
</div>
<script>
async function pay(){
  const btn=document.getElementById('btn');
  btn.disabled=true; btn.textContent='Redirecting to Paystack...';
  try{
    const r=await fetch('/pay/${token}/charge',{method:'POST'});
    const d=await r.json();
    if(d.authorizationUrl){window.location.href=d.authorizationUrl;}
    else{btn.textContent='Error — try again';btn.disabled=false;}
  }catch{btn.textContent='Error — try again';btn.disabled=false;}
}
</script>
</body></html>`;

const expiredPage = () => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Expired | TrustPay</title>
  <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f0f2f5;padding:16px}.card{background:#fff;border-radius:20px;padding:40px 28px;max-width:340px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}h2{font-size:18px;font-weight:700;margin-bottom:10px}p{color:#888;font-size:14px;line-height:1.7}</style>
</head>
<body>
<div class="card">
  <div style="font-size:52px;margin-bottom:18px">⏱</div>
  <h2>Link expired</h2>
  <p>Payment links expire after 30 minutes for security.<br><br>Ask the seller to send you a new deal code on WhatsApp.</p>
</div>
</body></html>`;

export default router;
