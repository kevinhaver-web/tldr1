import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dotenv from 'dotenv';
import { Resend } from 'resend';

import { generateDailyDrops, getRealWorldDayOffset } from './src/utils/dropsEngine.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json());

const resendApiKey = process.env.RESEND_API_KEY || '';
const fromEmail = process.env.RESEND_FROM_EMAIL || 'Too Long Didn\'t Read <onboarding@resend.dev>';

// Persistent local subscription store
const SUBS_FILE = path.resolve(__dirname, 'subscriptions.json');

export interface SubscriptionRecord {
  email: string;
  frequency: 'daily' | 'weekdays' | 'weekly';
  bookIds: string[];
  updatedAt: string;
  lastSentDate?: string; // YYYY-MM-DD in subscriber's timezone to prevent duplicate daily deliveries
  timezone?: string; // e.g. 'Europe/Amsterdam', 'America/New_York'
  sendHour?: number; // 9 = 9:00 AM local time
  createdAt?: string;
  lastSentAt?: string;
}

export function getSubscriberTimeInfo(timezone: string = 'UTC') {
  const now = new Date();
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const p: Record<string, string> = {};
    for (const part of parts) {
      p[part.type] = part.value;
    }
    const localDate = `${p.year}-${p.month}-${p.day}`;
    const localHour = parseInt(p.hour, 10);
    const localMinute = parseInt(p.minute, 10);

    const weekdayStr = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
    }).format(now);
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    const dayOfWeek = weekdayMap[weekdayStr] ?? now.getDay();

    return { localDate, localHour, localMinute, dayOfWeek };
  } catch {
    const localDate = now.toISOString().slice(0, 10);
    const localHour = now.getUTCHours();
    const localMinute = now.getUTCMinutes();
    const dayOfWeek = now.getUTCDay();
    return { localDate, localHour, localMinute, dayOfWeek };
  }
}

export function getDayOffsetForLocalDate(localDateStr: string): number {
  try {
    const [y, m, d] = localDateStr.split('-').map(Number);
    const targetMidnight = new Date(y, m - 1, d).getTime();
    const launchMidnight = new Date(2026, 9, 21).getTime(); // Oct 21, 2026
    const diffTime = targetMidnight - launchMidnight;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
  } catch {
    return getRealWorldDayOffset();
  }
}

function loadSubscriptions(): SubscriptionRecord[] {
  try {
    if (fs.existsSync(SUBS_FILE)) {
      return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error reading subscriptions:', e);
  }
  return [];
}

function saveSubscriptions(subs: SubscriptionRecord[]) {
  try {
    fs.writeFileSync(SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (e) {
    console.error('Error saving subscriptions:', e);
  }
}

// Health & status check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasResendKey: Boolean(process.env.RESEND_API_KEY),
  });
});

// Get or list subscriptions
app.get('/api/subscriptions', (req, res) => {
  const subs = loadSubscriptions();
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
  const subs = loadSubscriptions();
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
          // Set lastSentDate to subscriber's today so they don't get a duplicate at 9 AM today
          newRecord.lastSentDate = timeInfo.localDate;
          newRecord.lastSentAt = new Date().toISOString();
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

  saveSubscriptions(subs);
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
app.post('/api/unsubscribe', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const cleanEmail = String(email).trim().toLowerCase();
  let subs = loadSubscriptions();
  subs = subs.filter((s) => s.email.toLowerCase() !== cleanEmail);
  saveSubscriptions(subs);
  res.json({ success: true });
});

// Helper to construct minimalist, editorial HTML newsletter matching the app design
function buildDigestHtml(quotes: any[], frequency: string, subject: string, dateStr: string) {
  const count = quotes.length;
  const quotesHtml = quotes
    .map((q: any, i: number) => {
      const isLast = i === quotes.length - 1;
      return `
        <div style="margin-bottom: ${isLast ? '0' : '48px'}; padding-bottom: ${isLast ? '0' : '36px'}; ${isLast ? '' : 'border-bottom: 1px solid #eeeeee;'}">
          ${
            count > 1
              ? `<div style="font-size: 11px; color: #888888; font-family: monospace; letter-spacing: 0.05em; margin-bottom: 8px;">
                  [${i + 1}/${count}]
                </div>`
              : ''
          }
          <h2 style="font-size: 24px; font-weight: normal; color: #111111; margin: 0 0 4px 0; line-height: 1.25;">
            ${q.title}
          </h2>
          <div style="font-size: 14px; color: #777777; margin-bottom: 24px;">
            ${q.author} ${q.year ? `(${q.year})` : ''}
          </div>
          
          <div style="font-size: 18px; line-height: 1.55; color: #111111; margin-bottom: 24px;">
            “${q.quote || ''}”
            ${
              q.page
                ? `<div style="font-size: 11px; color: #888888; margin-top: 6px;">p. ${q.page}</div>`
                : ''
            }
          </div>

          <div style="margin-bottom: 22px;">
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #777777; margin-bottom: 6px;">
              Real World Context
            </div>
            <div style="font-size: 14px; line-height: 1.55; color: #444444;">
              ${q.realWorldContext || ''}
            </div>
          </div>

          <div>
            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: #777777; margin-bottom: 6px;">
              Strategic Direction
            </div>
            <div style="font-size: 14px; line-height: 1.55; color: #111111;">
              ${q.strategicDirection || ''}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${subject}</title>
  </head>
  <body style="margin: 0; padding: 48px 24px; background-color: #ffffff; color: #111111; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
    <div style="max-width: 580px; margin: 0 auto;">
      <div style="margin-bottom: 36px; padding-bottom: 16px; border-bottom: 1px solid #111111;">
        <h1 style="font-size: 26px; font-weight: normal; color: #111111; margin: 0 0 4px 0; letter-spacing: -0.02em;">
          Too Long Didn't Read
        </h1>
        <div style="font-size: 11px; color: #777777; letter-spacing: 0.05em; text-transform: uppercase;">
          ${dateStr} · ${frequency || 'daily'} digest (${count} ${count === 1 ? 'reading' : 'readings'} combined)
        </div>
      </div>

      <div>
        ${quotesHtml}
      </div>

      <div style="margin-top: 56px; padding-top: 16px; border-top: 1px solid #eeeeee; font-size: 11px; color: #888888; line-height: 1.6;">
        <p style="margin: 0 0 4px 0;">Kevin Haver. Content and Comms Strategist at DEPT®, studying communication science at UVA.</p>
        <p style="margin: 0; color: #aaaaaa;">
          You are receiving this digest because you opted in on Too Long Didn't Read.
        </p>
      </div>
    </div>
  </body>
</html>`;
}

// Core send function
async function sendDigestEmail(cleanEmail: string, quotes: any[], frequency: string = 'daily') {
  const count = quotes.length;
  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase();

  const titlesList = quotes.map((q: any) => q.title).join(', ');
  const subject = count === 1
    ? `Too Long Didn't Read — ${quotes[0].title} (${dateStr})`
    : `Too Long Didn't Read — ${count} Daily Readings: ${titlesList} (${dateStr})`;

  const fullHtml = buildDigestHtml(quotes, frequency, subject, dateStr);

  const apiKey = process.env.RESEND_API_KEY || resendApiKey;
  if (!apiKey) {
    return {
      success: false,
      missingApiKey: true,
      message: 'RESEND_API_KEY is not configured in environment variables.',
      previewCount: count,
      subject,
    };
  }

  const resendClient = new Resend(apiKey);
  const { data, error } = await resendClient.emails.send({
    from: fromEmail,
    to: [cleanEmail],
    subject,
    html: fullHtml,
  });

  if (error) {
    throw new Error(error.message);
  }

  return { success: true, messageId: data?.id, bookCount: count, subject };
}

// Automated background digest cycle (runs entirely on this server)
// Checks every subscriber's local time: delivers at 9:00 AM in their timezone
async function runAutomatedDigestCycle() {
  const apiKey = process.env.RESEND_API_KEY || resendApiKey;
  if (!apiKey) return;

  const subs = loadSubscriptions();
  if (subs.length === 0) return;

  let anyUpdated = false;

  for (const sub of subs) {
    const tz = sub.timezone || 'UTC';
    const timeInfo = getSubscriberTimeInfo(tz);
    const targetHour = sub.sendHour ?? 9;

    // 1. Skip if already sent today in subscriber's local date
    if (sub.lastSentDate === timeInfo.localDate) {
      continue;
    }

    // 2. Check scheduled send hour (9:00 AM local time)
    // Only send once it is 9:00 AM or later in their timezone
    if (timeInfo.localHour < targetHour) {
      continue;
    }

    // 3. Frequency check
    if (sub.frequency === 'weekdays' && (timeInfo.dayOfWeek === 0 || timeInfo.dayOfWeek === 6)) {
      continue;
    }
    if (sub.frequency === 'weekly' && timeInfo.dayOfWeek !== 1) {
      continue;
    }

    // 4. Assemble quotes for subscriber's local date
    const dayOffset = getDayOffsetForLocalDate(timeInfo.localDate);
    const allDrops = generateDailyDrops(dayOffset);
    const todayDrop = allDrops[0];
    if (!todayDrop) continue;

    const userQuotes = todayDrop.quotes.filter((q) => sub.bookIds.includes(q.bookId));
    const quotesToSend = userQuotes.length > 0 ? userQuotes : [todayDrop.quotes[0]];

    try {
      console.log(
        `[Auto-Digest 9AM] Sending 1 combined email to ${sub.email} (${quotesToSend.length} books) [TZ: ${tz}, Local: ${timeInfo.localDate} ${timeInfo.localHour}:${String(timeInfo.localMinute).padStart(2, '0')}]...`
      );
      const result = await sendDigestEmail(sub.email, quotesToSend, sub.frequency);
      if (result.success) {
        sub.lastSentDate = timeInfo.localDate;
        sub.lastSentAt = new Date().toISOString();
        anyUpdated = true;
        console.log(`[Auto-Digest 9AM] Success! Dispatched to ${sub.email} (Message ID: ${result.messageId})`);
      }
    } catch (err: any) {
      console.error(`[Auto-Digest 9AM] Delivery error for ${sub.email}:`, err.message);
    }
  }

  if (anyUpdated) {
    saveSubscriptions(subs);
  }
}

// Send combined multi-book digest email via Resend
app.post('/api/send-digest', async (req, res) => {
  const { email, quotes, frequency } = req.body;

  if (!email || !Array.isArray(quotes) || quotes.length === 0) {
    return res.status(400).json({ error: 'Email and at least one quote are required' });
  }

  const cleanEmail = String(email).trim();

  try {
    const result = await sendDigestEmail(cleanEmail, quotes, frequency);
    res.json(result);
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
