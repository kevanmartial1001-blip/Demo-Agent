// /api/echo.js
// CommonJS + Vercel "nodejs" runtime

module.exports.config = { runtime: "nodejs" };

module.exports = async (req, res) => {
  try {
    const ct = String(req.headers["content-type"] || "");
    const isJson = ct.includes("application/json");

    // Handle both raw string and already-parsed bodies
    const body =
      typeof req.body === "string"
        ? (isJson ? JSON.parse(req.body || "{}") : req.body)
        : (req.body || {});

    res.status(200).json({
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
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
};
