import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getStore } from '@netlify/blobs';

export interface SubscriptionRecord {
  email: string;
  frequency: 'daily' | 'weekdays' | 'weekly';
  bookIds: string[];
  updatedAt: string;
  lastSentDate?: string; // YYYY-MM-DD in subscriber's timezone
  timezone?: string; // e.g. 'Europe/Amsterdam', 'America/New_York'
  sendHour?: number; // 9 = 9:00 AM local time
  createdAt?: string;
  lastSentAt?: string;
}

const isNetlify = Boolean(
  process.env.NETLIFY ||
  process.env.NETLIFY_BLOBS_CONTEXT ||
  process.env.AWS_LAMBDA_FUNCTION_NAME ||
  process.env.LAMBDA_TASK_ROOT
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOCAL_SUBS_FILE = path.resolve(__dirname, '..', 'subscriptions.json');
const TMP_SUBS_FILE = '/tmp/subscriptions.json';

export async function loadSubscriptions(): Promise<SubscriptionRecord[]> {
  // 1. If on Netlify, attempt to load from Netlify Blobs (persistent across serverless invocations)
  if (isNetlify) {
    try {
      const store = getStore('subscriptions');
      const data = await store.get('list', { type: 'json' });
      if (Array.isArray(data) && data.length > 0) {
        return data as SubscriptionRecord[];
      }
    } catch (e) {
      console.warn('[Storage] Netlify Blobs read notice:', e);
    }
  }

  // 2. Try local project file (standard in dev server)
  try {
    if (fs.existsSync(LOCAL_SUBS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(LOCAL_SUBS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    // Expected if read-only or absent
  }

  // 3. Try /tmp file (serverless container fallback)
  try {
    if (fs.existsSync(TMP_SUBS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TMP_SUBS_FILE, 'utf-8'));
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) {
    // Expected
  }

  return [];
}

export async function saveSubscriptions(subs: SubscriptionRecord[]): Promise<void> {
  // 1. If on Netlify, save to Netlify Blobs
  if (isNetlify) {
    try {
      const store = getStore('subscriptions');
      await store.setJSON('list', subs);
      console.log(`[Storage] Saved ${subs.length} subscriber(s) to Netlify Blobs.`);
    } catch (e) {
      console.warn('[Storage] Netlify Blobs write warning:', e);
    }
  }

  // 2. Write to local project subscriptions.json
  try {
    fs.writeFileSync(LOCAL_SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (e) {
    // Read-only filesystem on Lambda
    try {
      fs.writeFileSync(TMP_SUBS_FILE, JSON.stringify(subs, null, 2), 'utf-8');
    } catch {}
  }
}
