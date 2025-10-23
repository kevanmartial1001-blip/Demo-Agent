// tools/invoice_send.js
// UNIVERSAL INVOICE SENDER (QuickBooks, Xero, Stripe, FreshBooks, Zoho Books, Wave, Odoo) + Demo
// ----------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with ACCOUNTING_PROVIDER):
//   • QuickBooks    → QUICKBOOKS_ACCESS_TOKEN + QUICKBOOKS_REALM_ID
//   • Xero          → XERO_ACCESS_TOKEN + XERO_TENANT_ID
//   • Stripe        → STRIPE_SECRET_KEY
//   • FreshBooks    → FRESHBOOKS_TOKEN + FRESHBOOKS_BUSINESS_ID
//   • Zoho Books    → ZOHO_BOOKS_TOKEN + ZOHO_ORG_ID
//   • Wave          → WAVE_ACCESS_TOKEN
//   • Odoo          → ODOO_BASE_URL + ODOO_API_KEY + ODOO_DB + ODOO_USER
//
// Common env:
//   ACCOUNTING_PROVIDER  = "quickbooks"|"xero"|"stripe"|"freshbooks"|"zoho"|"wave"|"odoo"
//   ACCOUNTING_DRY_RUN   = "1"
//   ACCOUNTING_DEMO      = "1"
//
// Input:
//   {
//     invoiceId: string,              // required
//     toEmail?: string,               // optional override recipient
//     message?: string,               // optional custom email message
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string }, link?: string }

const DRY_RUN = String(process.env.ACCOUNTING_DRY_RUN || "") === "1";
const DEMO = String(process.env.ACCOUNTING_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.ACCOUNTING_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.QUICKBOOKS_ACCESS_TOKEN) return "quickbooks";
  if (process.env.XERO_ACCESS_TOKEN) return "xero";
  if (process.env.STRIPE_SECRET_KEY) return "stripe";
  if (process.env.FRESHBOOKS_TOKEN) return "freshbooks";
  if (process.env.ZOHO_BOOKS_TOKEN) return "zoho";
  if (process.env.WAVE_ACCESS_TOKEN) return "wave";
  if (process.env.ODOO_BASE_URL) return "odoo";
  return null;
}

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

// -------------- QUICKBOOKS --------------
async function viaQuickBooks({ invoiceId, toEmail }) {
  const token = process.env.QUICKBOOKS_ACCESS_TOKEN;
  const realm = process.env.QUICKBOOKS_REALM_ID;
  if (!token || !realm) throw new Error("Missing QuickBooks credentials");
  const url = `https://quickbooks.api.intuit.com/v3/company/${realm}/invoice/${invoiceId}/send`;
  const r = await fetch(`${url}?sendTo=${encodeURIComponent(toEmail || "")}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }
  });
  if (!r.ok) throw new Error(`QuickBooks send failed: ${r.status}`);
  return { id: invoiceId, link: `https://qbo.intuit.com/app/invoice?txnId=${invoiceId}`, status: "sent" };
}

// -------------- XERO --------------
async function viaXero({ invoiceId, toEmail }) {
  const token = process.env.XERO_ACCESS_TOKEN;
  const tenant = process.env.XERO_TENANT_ID;
  if (!token || !tenant) throw new Error("Missing Xero credentials");
  const r = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}/Email`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-Tenant-Id": tenant
    },
  });
  if (!r.ok) throw new Error(`Xero send failed: ${r.status}`);
  return { id: invoiceId, link: `https://go.xero.com/AccountsReceivable/View.aspx?invoiceID=${invoiceId}`, status: "sent" };
}

// -------------- STRIPE --------------
async function viaStripe({ invoiceId }) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  const r = await fetch(`https://api.stripe.com/v1/invoices/${invoiceId}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Stripe HTTP ${r.status}`);
  return { id: j.id || invoiceId, link: j.hosted_invoice_url, status: "sent" };
}

// -------------- FRESHBOOKS --------------
async function viaFreshBooks({ invoiceId }) {
  const token = process.env.FRESHBOOKS_TOKEN;
  const business = process.env.FRESHBOOKS_BUSINESS_ID;
  if (!token || !business) throw new Error("Missing FreshBooks credentials");
  const r = await fetch(`https://api.freshbooks.com/accounting/account/${business}/invoices/invoices/${invoiceId}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!r.ok) throw new Error(`FreshBooks send failed: ${r.status}`);
  return { id: invoiceId, link: `https://my.freshbooks.com/#/invoice/${invoiceId}`, status: "sent" };
}

// -------------- ZOHO BOOKS --------------
async function viaZohoBooks({ invoiceId }) {
  const token = process.env.ZOHO_BOOKS_TOKEN;
  const org = process.env.ZOHO_ORG_ID;
  if (!token || !org) throw new Error("Missing Zoho Books credentials");
  const r = await fetch(`https://books.zoho.com/api/v3/invoices/${invoiceId}/status/sent?organization_id=${org}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho Books HTTP ${r.status}`);
  return { id: invoiceId, link: j.invoice?.invoice_url, status: "sent" };
}

// -------------- WAVE --------------
async function viaWave({ invoiceId }) {
  const key = process.env.WAVE_ACCESS_TOKEN;
  if (!key) throw new Error("Missing WAVE_ACCESS_TOKEN");
  const body = {
    query: `
      mutation {
        invoiceSend(input: { invoiceId: "${invoiceId}" }) {
          didSucceed
          invoice { id status viewUrl }
        }
      }
    `,
  };
  const r = await fetch("https://gql.waveapps.com/graphql/public", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  const inv = j.data?.invoiceSend?.invoice;
  if (!inv?.id) throw new Error(j.errors?.[0]?.message || "Wave send error");
  return { id: inv.id, link: inv.viewUrl, status: inv.status || "sent" };
}

// -------------- ODOO --------------
async function viaOdoo({ invoiceId }) {
  const base = process.env.ODOO_BASE_URL;
  const db = process.env.ODOO_DB;
  const user = process.env.ODOO_USER;
  const key = process.env.ODOO_API_KEY;
  if (!base || !db || !user || !key) throw new Error("Missing Odoo credentials");
  const r = await fetch(`${base}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: toJSON({
      jsonrpc: "2.0",
      method: "call",
      params: { service: "object", method: "execute_kw", args: [db, user, key, "account.move", "action_invoice_sent", [[parseInt(invoiceId)]]] },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Odoo HTTP ${r.status}`);
  return { id: invoiceId, link: `${base}/web#id=${invoiceId}&model=account.move`, status: "sent" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { invoiceId } = input;
  if (!invoiceId) {
    emitErr(emit, "invoice_send: invoiceId is required");
    return { data: { error: "missing_invoiceId" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `invoice_send[DRY_RUN]: provider=${provider || "n/a"} invoiceId=${invoiceId}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "inv_send_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, "invoice_send[DEMO]: returning mock invoice send");
      return {
        data: { provider: "demo", id: fake, status: "sent", link: `about:blank#demo-invoice-send-${fake}` },
        link: `about:blank#demo-invoice-send-${fake}`,
      };
    }
    emitErr(emit, "invoice_send: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `invoice_send: via ${provider}`);
  try {
    let out;
    switch (provider) {
      case "quickbooks": out = await viaQuickBooks(input); break;
      case "xero": out = await viaXero(input); break;
      case "stripe": out = await viaStripe(input); break;
      case "freshbooks": out = await viaFreshBooks(input); break;
      case "zoho": out = await viaZohoBooks(input); break;
      case "wave": out = await viaWave(input); break;
      case "odoo": out = await viaOdoo(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id, link: out?.link, status: out?.status || "sent" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `invoice_send failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
