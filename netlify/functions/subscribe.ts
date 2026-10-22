import { loadSubscriptions, saveSubscriptions, SubscriptionRecord } from '../../server/storage.js';
import {
  getSubscriberTimeInfo,
  getDayOffsetForLocalDate,
  sendDigestEmail,
} from '../../server/digestEngine.js';
import { generateDailyDrops } from '../../src/utils/dropsEngine.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Content-Type': 'application/json',
};

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(req.url);

  // 1. GET: list subscriptions
  if (req.method === 'GET') {
    const subs = await loadSubscriptions();
    return new Response(JSON.stringify({ subscriptions: subs }), {
      status: 200,
      headers: corsHeaders,
    });
  }

  // 2. DELETE or Unsubscribe
  if (req.method === 'DELETE' || url.pathname.endsWith('/unsubscribe')) {
    try {
      const body = await req.json();
      const email = body?.email ? String(body.email).trim().toLowerCase() : '';
      if (!email) {
        return new Response(JSON.stringify({ error: 'Email is required' }), {
          status: 400,
          headers: corsHeaders,
        });
      }
      let subs = await loadSubscriptions();
      subs = subs.filter((s) => s.email.toLowerCase() !== email);
      await saveSubscriptions(subs);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: corsHeaders,
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  // 3. POST: Subscribe / Update subscription
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      // Check if this was an unsubscribe request posted here
      if (body.action === 'unsubscribe' && body.email) {
        const cleanEmail = String(body.email).trim().toLowerCase();
        let subs = await loadSubscriptions();
        subs = subs.filter((s) => s.email.toLowerCase() !== cleanEmail);
        await saveSubscriptions(subs);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: corsHeaders,
        });
      }

      const { email, frequency, bookIds, timezone, sendHour, sendImmediate } = body;
      if (!email || typeof email !== 'string' || !email.includes('@')) {
        return new Response(JSON.stringify({ error: 'Valid email is required' }), {
          status: 400,
          headers: corsHeaders,
        });
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
              immediateError = 'RESEND_API_KEY is not set in Netlify Environment Variables.';
            }
          }
        } catch (err: any) {
          console.error('[Netlify Subscribe] Error dispatching signup email:', err.message);
          immediateError = err.message;
        }
      }

      if (existingIdx >= 0) {
        subs[existingIdx] = newRecord;
      } else {
        subs.push(newRecord);
      }

      await saveSubscriptions(subs);

      return new Response(
        JSON.stringify({
          success: true,
          subscription: newRecord,
          immediateSent,
          messageId,
          error: immediateError,
          timeInfo,
        }),
        { status: 200, headers: corsHeaders }
      );
    } catch (err: any) {
      console.error('[Netlify Subscribe] Unhandled error:', err);
      return new Response(JSON.stringify({ error: err.message || 'Server error' }), {
        status: 500,
        headers: corsHeaders,
      });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), {
    status: 405,
    headers: corsHeaders,
  });
};
