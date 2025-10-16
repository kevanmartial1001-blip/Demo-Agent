// api/health.js
module.exports.config = { runtime: "nodejs20.x" };

module.exports = async (req, res) => {
  try {
    const pingSheets = (req.query && String(req.query.pingSheets).toLowerCase() === 'true');
    const info = {
      ok: true,
      runtime: "nodejs",
      node_version: process.versions.node,
      env: {
        DEMO_SECRET: Boolean(process.env.DEMO_SECRET),
        SHEET_ID: Boolean(process.env.SHEET_ID),
        SHEET_TAB: process.env.SHEET_TAB || 'Tenants',
        GOOGLE_SERVICE_ACCOUNT_EMAIL: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
        GOOGLE_SERVICE_ACCOUNT_KEY: Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_KEY),
        OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY)
      },
      time_utc: new Date().toISOString(),
    };

    if (!pingSheets) return res.status(200).json(info);

    let openTenantsSheet;
    try {
      ({ openTenantsSheet } = require('./_lib/sheets'));
      info.sheets_module = "loaded";
    } catch (e) {
      return res.status(200).json({ ...info, sheets_module: "failed_to_load", sheets_error: String(e?.message || e) });
    }

    try {
      const sheet = await openTenantsSheet();
      return res.status(200).json({
        ...info,
        sheets_module: "loaded",
        sheets_open: "ok",
        sheet_title: sheet.title,
        sheet_headers: sheet.headerValues
      });
    } catch (e) {
      return res.status(200).json({
        ...info,
        sheets_module: "loaded",
        sheets_open: "failed",
        sheets_open_error: String(e?.message || e),
      });
    }
  } catch (e) {
    res.status(500).json({ ok:false, error:'server_error', detail:String(e?.message || e) });
  }
};
