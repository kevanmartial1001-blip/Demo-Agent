// api/health.js
// Lightweight diagnostics that don't require Google Sheets unless requested.

module.exports.config = { runtime: "nodejs20.x" };

module.exports = async (req, res) => {
  try {
    const pingSheets = (req.query && String(req.query.pingSheets).toLowerCase() === 'true');

    // Basic runtime/env info
    const info = {
      ok: true,
      runtime: "nodejs",
      node_version: process.versions.node,
      env: {
        DEMO_SECRET: Boolean(process.env.DEMO_SECRET),
        // redact any other envs here if needed
      },
      time_utc: new Date().toISOString(),
    };

    if (!pingSheets) {
      return res.status(200).json(info);
    }

    // Try to load the sheets module and call openTenantsSheet() in a safe way
    let openTenantsSheet;
    try {
      ({ openTenantsSheet } = require('./_lib/sheets'));
      info.sheets_module = "loaded";
    } catch (e) {
      return res.status(200).json({
        ...info,
        sheets_module: "failed_to_load",
        sheets_error: String(e?.message || e),
      });
    }

    try {
      const sheet = await openTenantsSheet();
      const caps = Object.getOwnPropertyNames(Object.getPrototypeOf(sheet)).filter(x => typeof sheet[x] === 'function');
      return res.status(200).json({
        ...info,
        sheets_module: "loaded",
        sheets_open: "ok",
        sheet_methods: caps,
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
    console.error('health error:', e);
    res.status(500).json({ ok:false, error:'server_error', detail:String(e?.message || e) });
  }
};
