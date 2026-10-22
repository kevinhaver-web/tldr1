import type { Config } from '@netlify/functions';
import { runAutomatedDigestCycle } from '../../server/digestEngine.js';

export default async (req: Request) => {
  console.log('[Scheduled-Digest] Running automated 9:00 AM check across subscribers...');
  try {
    const result = await runAutomatedDigestCycle();
    console.log('[Scheduled-Digest] Cycle completed:', result);
    return new Response(JSON.stringify({ status: 'ok', ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    console.error('[Scheduled-Digest] Error running digest cycle:', err);
    return new Response(JSON.stringify({ status: 'error', error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// Netlify scheduled trigger: runs every 15 minutes to evaluate local 9:00 AM across all timezones
export const config: Config = {
  schedule: '*/15 * * * *',
};
