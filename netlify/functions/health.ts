export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    });
  }

  const hasResendKey = Boolean(process.env.RESEND_API_KEY);

  return new Response(
    JSON.stringify({
      status: 'ok',
      hasResendKey,
      environment: 'netlify',
      message: hasResendKey
        ? 'Resend API key configured on Netlify.'
        : 'Warning: RESEND_API_KEY is not set in Netlify Environment Variables.',
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
};
