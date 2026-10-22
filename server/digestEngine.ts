import { Resend } from 'resend';
import { generateDailyDrops, getRealWorldDayOffset } from '../src/utils/dropsEngine.js';
import { loadSubscriptions, saveSubscriptions, SubscriptionRecord } from './storage.js';

const fromEmail = process.env.RESEND_FROM_EMAIL || 'Too Long Didn\'t Read <onboarding@resend.dev>';

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

export function buildDigestHtml(quotes: any[], frequency: string, subject: string, dateStr: string) {
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

export async function sendDigestEmail(cleanEmail: string, quotes: any[], frequency: string = 'daily') {
  const count = quotes.length;
  const dateStr = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).toUpperCase();

  const titlesList = quotes.map((q: any) => q.title).join(', ');
  const subject =
    count === 1
      ? `Too Long Didn't Read — ${quotes[0].title} (${dateStr})`
      : `Too Long Didn't Read — ${count} Daily Readings: ${titlesList} (${dateStr})`;

  const fullHtml = buildDigestHtml(quotes, frequency, subject, dateStr);

  const apiKey = (process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    return {
      success: false,
      missingApiKey: true,
      error: 'RESEND_API_KEY is not configured in Netlify or server environment variables.',
      message: 'RESEND_API_KEY is not configured in Netlify or server environment variables.',
      previewCount: count,
      subject,
    };
  }

  try {
    const resendClient = new Resend(apiKey);
    const { data, error } = await resendClient.emails.send({
      from: fromEmail,
      to: [cleanEmail],
      subject,
      html: fullHtml,
    });

    if (error) {
      console.error('[Resend Error]', error);
      return {
        success: false,
        error: error.message || 'Resend API returned an error',
        statusCode: (error as any).statusCode,
        missingApiKey: false,
      };
    }

    return { success: true, messageId: data?.id, bookCount: count, subject };
  } catch (err: any) {
    console.error('[Resend Exception]', err);
    return {
      success: false,
      error: err.message || 'Delivery error',
      missingApiKey: false,
    };
  }
}

export async function runAutomatedDigestCycle(): Promise<{ sentCount: number; errors: string[] }> {
  const apiKey = process.env.RESEND_API_KEY || '';
  if (!apiKey) {
    return { sentCount: 0, errors: ['Missing RESEND_API_KEY'] };
  }

  const subs = await loadSubscriptions();
  if (subs.length === 0) {
    return { sentCount: 0, errors: [] };
  }

  let anyUpdated = false;
  let sentCount = 0;
  const errors: string[] = [];

  for (const sub of subs) {
    const tz = sub.timezone || 'UTC';
    const timeInfo = getSubscriberTimeInfo(tz);
    const targetHour = sub.sendHour ?? 9;

    // 1. Skip if already sent today in subscriber's local date
    if (sub.lastSentDate === timeInfo.localDate) {
      continue;
    }

    // 2. Check scheduled send hour (9:00 AM local time)
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
        `[Auto-Digest 9AM] Sending combined email to ${sub.email} (${quotesToSend.length} books) [TZ: ${tz}, Local: ${timeInfo.localDate} ${timeInfo.localHour}:${String(timeInfo.localMinute).padStart(2, '0')}]...`
      );
      const result = await sendDigestEmail(sub.email, quotesToSend, sub.frequency);
      if (result.success) {
        sub.lastSentDate = timeInfo.localDate;
        sub.lastSentAt = new Date().toISOString();
        anyUpdated = true;
        sentCount++;
        console.log(`[Auto-Digest 9AM] Success! Dispatched to ${sub.email} (Message ID: ${result.messageId})`);
      }
    } catch (err: any) {
      console.error(`[Auto-Digest 9AM] Delivery error for ${sub.email}:`, err.message);
      errors.push(`${sub.email}: ${err.message}`);
    }
  }

  if (anyUpdated) {
    await saveSubscriptions(subs);
  }

  return { sentCount, errors };
}
