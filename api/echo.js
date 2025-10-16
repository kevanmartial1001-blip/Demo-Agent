// /api/echo.js
export const config = { runtime: 'nodejs18.x' };

export default async function handler(req, res) {
  try {
    const ct = req.headers['content-type'] || '';
    const isJson = ct.includes('application/json');
    const body = typeof req.body === 'string'
      ? (isJson ? JSON.parse(req.body || '{}') : req.body)
      : (req.body || {});

    return res.status(200).json({
      ok: true,
      method: req.method,
      content_type: ct,
      json_body: body,
      env: {
        SHEET_ID: !!process.env.SHEET_ID,
        GOOGLE_SERVICE_ACCOUNT_EMAIL: !!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        GOOGLE_SERVICE_ACCOUNT_KEY: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:String(e?.message||e) });
  }
}
