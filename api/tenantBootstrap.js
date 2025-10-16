// /api/tenantBootstrap.js
// Returns JS that pre-populates window globals with the tenant's KB.
// Usage from UI: <script src="/api/tenantBootstrap?tenant=...&token=..."></script>

module.exports.config = { runtime: "nodejs20.x" };

function verifyDev({ token, tenant }) {
  if (!token || !tenant) return false;
  const [t, expStr] = String(token).split('.');
  const exp = parseInt(expStr, 10);
  if (!t || t !== tenant) return false;
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now()/1000)) return false;
  return true;
}

function safe(str){ return (str==null?'':String(str)); }
function jsEscapeJson(obj){ return JSON.stringify(obj ?? null); }

async function loadTenant(tenant){
  let openTenantsSheet;
  ({ openTenantsSheet } = require('./_lib/sheets'));
  const sheet = await openTenantsSheet();
  const rows = await sheet.getRows({ query: `tenant_id = "${tenant}"` });
  if (!rows?.length) return null;

  const r = rows[0];
  const parse = (s, fb) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };

  // Support chunked kb storage
  const CH = ["kb_json_1","kb_json_2","kb_json_3","kb_json_4","kb_json_5","kb_json_6"];
  let kb_raw = r.get('kb_json') || '';
  if (!kb_raw) kb_raw = CH.map(h => r.get(h) || '').join('');

  return {
    tenant_id: r.get('tenant_id'),
    company_name: r.get('company_name'),
    kb_json: parse(kb_raw, {}),
    company_system_prompt: r.get('company_system_prompt') || ''
  };
}

module.exports = async (req, res) => {
  try{
    const q = req.query || {};
    const tenant = q.tenant || '';
    const token  = q.token  || '';

    if (!verifyDev({ token, tenant })) {
      res.status(401).setHeader('Content-Type','application/javascript');
      return res.end(`console.warn("tenantBootstrap: invalid token");`);
    }

    const t = await loadTenant(tenant);
    if (!t){
      res.status(404).setHeader('Content-Type','application/javascript');
      return res.end(`console.warn("tenantBootstrap: tenant not found");`);
    }

    const js = `
      window.__TENANT__ = ${JSON.stringify(tenant)};
      window.__TOKEN__  = ${JSON.stringify(token)};
      window.__KB__ = ${jsEscapeJson(t.kb_json)};
      window.__SYS_PROMPT__ = ${JSON.stringify(safe(t.company_system_prompt))};
      try {
        document.title = "AI Assistant — ${safe(t.company_name)}";
        const h = document.getElementById("companyTitle");
        if (h) h.textContent = "AI Assistant — ${safe(t.company_name)}";
      } catch {}
    `.trim();

    res.setHeader('Content-Type','application/javascript');
    res.setHeader('Cache-Control','private, max-age=30'); // short-lived cache
    return res.status(200).end(js);
  } catch (e) {
    res.status(500).setHeader('Content-Type','application/javascript');
    return res.end(`console.warn("tenantBootstrap error: ${String(e?.message || e)}");`);
  }
};
