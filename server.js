// INTERAC E-TRANSFER BACKEND - PRODUCTION READY
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests',
  standardHeaders: true,
});
app.use('/api/', limiter);

app.use(bodyParser.json());
app.use(bodyParser.raw({ 
  type: 'application/json', 
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

const INTERAC_API_BASE = process.env.INTERAC_API_BASE;
const INTERAC_API_KEY = process.env.INTERAC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({ 
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

function verifyWebhookSignature(payload, signature, secret) {
  try {
    const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch (e) {
    return false;
  }
}

app.get('/', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      service: 'Interac Backend',
      version: '1.0.0',
      status: 'healthy',
      database: 'connected',
      interac_configured: !!INTERAC_API_KEY,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message });
  }
});

app.post('/api/payouts/interac', async (req, res) => {
  try {
    const {
      businessUserId,
      amountCents,
      recipientEmail,
      recipientName,
      useAutoDeposit = true,
      idempotencyKey
    } = req.body;

    if (!businessUserId || !amountCents || !recipientEmail) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (amountCents > 2500000) {
      return res.status(400).json({ error: 'Exceeds $25K limit' });
    }

    if (!idempotencyKey) {
      return res.status(400).json({ error: 'Idempotency key required' });
    }

    const existing = await pool.query(
      'SELECT * FROM transfers WHERE idempotency_key = $1 AND business_user_id = $2',
      [idempotencyKey, businessUserId]
    );

    if (existing.rows.length > 0) {
      return res.status(200).json({ transfer: existing.rows[0] });
    }

    const localTransferId = 'TRF_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');

    const insertResult = await pool.query(
      `INSERT INTO transfers 
       (id, idempotency_key, business_user_id, recipient_email, recipient_name,
        amount_cents, currency, status, use_auto_deposit, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [localTransferId, idempotencyKey, businessUserId, recipientEmail, 
       recipientName, amountCents, 'CAD', 'created', useAutoDeposit]
    );

    const transfer = insertResult.rows[0];

    const payload = {
      amount: (amountCents / 100).toFixed(2),
      currency: 'CAD',
      recipient: { email: recipientEmail, name: recipientName },
      autoDeposit: useAutoDeposit,
      reference: localTransferId,
      metadata: { localTransferId, businessUserId }
    };

    const interacResponse = await axios.post(
      `${INTERAC_API_BASE}/v1/payouts/interac`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${INTERAC_API_KEY}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        timeout: 30000
      }
    );

    const { id: externalTxnId, status: providerStatus } = interacResponse.data;

    await pool.query(
      `UPDATE transfers 
       SET external_txn_id = $1, status = $2, updated_at = NOW()
       WHERE id = $3`,
      [externalTxnId, providerStatus || 'submitted', localTransferId]
    );

    return res.status(201).json({
      success: true,
      transfer: {
        id: transfer.id,
        externalTxnId,
        status: providerStatus || 'submitted',
        amount: (amountCents / 100).toFixed(2),
        currency: 'CAD'
      }
    });

  } catch (err) {
    console.error('Transfer error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Transfer failed', message: err.message });
  }
});

app.post('/webhooks/interac', async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const payloadRaw = req.rawBody;

    if (!signature || !verifyWebhookSignature(payloadRaw, signature, WEBHOOK_SECRET)) {
      return res.status(400).send('Invalid signature');
    }

    const event = req.body;
    const { type, data } = event;
    const { id: externalTxnId, status: newStatus, metadata } = data;

    let transfer;
    if (metadata?.localTransferId) {
      const result = await pool.query('SELECT * FROM transfers WHERE id = $1', [metadata.localTransferId]);
      transfer = result.rows[0];
    }

    if (!transfer) {
      return res.status(200).send('OK');
    }

    const statusMap = {
      'pending': 'pending',
      'sent': 'sent',
      'deposited': 'deposited',
      'failed': 'failed'
    };

    const mappedStatus = statusMap[newStatus.toLowerCase()] || newStatus;

    await pool.query(
      `UPDATE transfers SET status = $1, updated_at = NOW() WHERE id = $2`,
      [mappedStatus, transfer.id]
    );

    await pool.query(
      `INSERT INTO transfer_events (transfer_id, event_type, event_payload, received_at)
       VALUES ($1, $2, $3, NOW())`,
      [transfer.id, type, JSON.stringify(data)]
    );

    return res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Error');
  }
});

app.get('/api/transfers/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM transfers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    const events = await pool.query('SELECT * FROM transfer_events WHERE transfer_id = $1 ORDER BY received_at DESC', [req.params.id]);
    return res.json({ transfer: result.rows[0], events: events.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Interac Backend on port ${PORT}`);
});
