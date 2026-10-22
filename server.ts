import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';

import { generateDailyDrops } from './src/utils/dropsEngine.js';
import {
  loadSubscriptions,
  saveSubscriptions,
  SubscriptionRecord,
} from './server/storage.js';
import {
  getSubscriberTimeInfo,
  getDayOffsetForLocalDate,
  sendDigestEmail,
  runAutomatedDigestCycle,
} from './server/digestEngine.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

// Health & status check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
    provider: 'local-server',
  });
});

// Get or list subscriptions
app.get('/api/subscriptions', async (req, res) => {
  const subs = await loadSubscriptions();
  res.json({ subscriptions: subs });
});

// Save or update subscription
// - Sends immediately upon initial sign-up (or when sendImmediate: true)
// - Subsequent automated deliveries fire at 9:00 AM local time daily
app.post('/api/subscribe', async (req, res) => {
  const { email, frequency, bookIds, timezone, sendHour, sendImmediate } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const subs = await loadSubscriptions();
  const existingIdx = subs.findIndex((s) => s.email.toLowerCase() === cleanEmail);
  const existing = existingIdx >= 0 ? subs[existingIdx] : null;

  const userTimezone =
    typeof timezone === 'string' && timezone.trim()
      ? timezone.trim()
      : (existing?.timezone || 'UTC');
  const targetHour = typeof sendHour === 'number' ? sendHour : (existing?.sendHour ?? 9);
  const timeInfo = getSubscriberTimeInfo(userTimezone);

  const newRecord: SubscriptionRecord = {
    email: cleanEmail,
    frequency: frequency || existing?.frequency || 'daily',
    bookIds:
      Array.isArray(bookIds) && bookIds.length > 0
        ? bookIds
        : (existing?.bookIds || ['how-not-to-plan']),
    timezone: userTimezone,
    sendHour: targetHour,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastSentDate: existing?.lastSentDate,
    lastSentAt: existing?.lastSentAt,
  };

  let immediateSent = false;
  let immediateError: string | null = null;
  let messageId: string | undefined;

  // Immediate send on the day the user signs up
  const shouldSendNow = Boolean(sendImmediate) || !existing;

  if (shouldSendNow) {
    try {
      const dayOffset = getDayOffsetForLocalDate(timeInfo.localDate);
      const allDrops = generateDailyDrops(dayOffset);
      const todayDrop = allDrops[0];
      if (todayDrop) {
        const userQuotes = todayDrop.quotes.filter((q) => newRecord.bookIds.includes(q.bookId));
        const quotesToSend = userQuotes.length > 0 ? userQuotes : [todayDrop.quotes[0]];

        const sendResult = await sendDigestEmail(cleanEmail, quotesToSend, newRecord.frequency);
        if (sendResult.success) {
          immediateSent = true;
          messageId = sendResult.messageId;
          newRecord.lastSentDate = timeInfo.localDate;
          newRecord.lastSentAt = new Date().toISOString();
        } else if (sendResult.missingApiKey) {
          immediateError = 'RESEND_API_KEY is not configured in environment variables.';
        }
      }
    } catch (err: any) {
      console.error('Error dispatching signup digest email:', err.message);
      immediateError = err.message;
    }
  }

  if (existingIdx >= 0) {
    subs[existingIdx] = newRecord;
  } else {
    subs.push(newRecord);
  }

  await saveSubscriptions(subs);
  res.json({
    success: true,
    subscription: newRecord,
    immediateSent,
    messageId,
    error: immediateError,
    timeInfo,
  });
});

// Unsubscribe
app.post('/api/unsubscribe', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const cleanEmail = String(email).trim().toLowerCase();
  let subs = await loadSubscriptions();
  subs = subs.filter((s) => s.email.toLowerCase() !== cleanEmail);
  await saveSubscriptions(subs);
  res.json({ success: true });
});

// Send combined multi-book digest email via Resend
app.post('/api/send-digest', async (req, res) => {
  const { email, quotes, frequency } = req.body;

  if (!email || !Array.isArray(quotes) || quotes.length === 0) {
    return res.status(400).json({ error: 'Email and at least one quote are required' });
  }

  const cleanEmail = String(email).trim();

  try {
    const result = await sendDigestEmail(cleanEmail, quotes, frequency);
    res.status(result.success ? 200 : 400).json(result);
  } catch (err: any) {
    console.error('Unexpected email sending failure:', err);
    res.status(500).json({ success: false, error: err.message || 'Delivery error' });
  }
});

// Vite middleware in dev or static serving in production
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true, hmr: process.env.DISABLE_HMR !== 'true' },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(__dirname, 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e: any) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
    // Run automated cycle on startup
    runAutomatedDigestCycle().catch((e) => console.error('Initial auto-digest error:', e));
    // Check every 5 minutes for daily 9:00 AM scheduled deliveries
    setInterval(() => {
      runAutomatedDigestCycle().catch((e) => console.error('Interval auto-digest error:', e));
    }, 5 * 60 * 1000);
  });
}

startServer();
