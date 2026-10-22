import { sendDigestEmail } from '../../server/digestEngine.js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const body = await req.json();
    const { email, quotes, frequency } = body || {};

    if (!email || !Array.isArray(quotes) || quotes.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Email and at least one quote are required' }),
        { status: 400, headers: corsHeaders }
      );
    }

    const cleanEmail = String(email).trim();
    const result = await sendDigestEmail(cleanEmail, quotes, frequency);

    if (result.missingApiKey) {
      return new Response(
        JSON.stringify({
          success: false,
          missingApiKey: true,
          error:
            'RESEND_API_KEY is not configured on Netlify. Go to Netlify Site Settings > Environment variables, add RESEND_API_KEY with your Resend key, and trigger a redeploy.',
        }),
        { status: 200, headers: corsHeaders }
      );
    }

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: corsHeaders,
    });
  } catch (err: any) {
    console.error('[Netlify Send-Digest] Delivery error:', err);
    return new Response(
      JSON.stringify({ success: false, error: err.message || 'Delivery error' }),
      { status: 500, headers: corsHeaders }
    );
  }
};
