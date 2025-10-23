// tools/invoice_create.js
// UNIVERSAL INVOICE CREATOR (QuickBooks, Xero, Stripe, FreshBooks, Zoho Books, Wave, Odoo) + Demo
// -----------------------------------------------------------------------------------------------
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
//     customerName: string,
//     customerEmail?: string,
//     lineItems: [{ description: string, quantity: number, unitPrice: number }],
//     dueDate?: string,
//     currency?: string,
//     notes?: string
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
async function viaQuickBooks({ customerName, customerEmail, lineItems, dueDate, currency, notes }) {
  const token = process.env.QUICKBOOKS_ACCESS_TOKEN;
  const realm = process.env.QUICKBOOKS_REALM_ID;
  if (!token || !realm) throw new Error("Missing QuickBooks credentials");
  const body = {
    CustomerRef: { name: customerName },
    Line: lineItems.map(li => ({
      DetailType: "SalesItemLineDetail",
      Amount: li.unitPrice * li.quantity,
      SalesItemLineDetail: {
        ItemRef: { name: li.description },
        Qty: li.quantity,
        UnitPrice: li.unitPrice
      }
    })),
    DueDate: dueDate || new Date().toISOString().slice(0, 10),
    CurrencyRef: { value: currency || "USD" },
    PrivateNote: notes || ""
  };
  const r = await fetch(`https://quickbooks.api.intuit.com/v3/company/${realm}/invoice`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.Fault?.Error?.[0]?.Message || `QuickBooks HTTP ${r.status}`);
  return { id: j.Invoice?.Id, link: j.Invoice?.DocNumber || "", status: "created" };
}

// -------------- XERO --------------
async function viaXero({ customerName, customerEmail, lineItems, dueDate, currency }) {
  const token = process.env.XERO_ACCESS_TOKEN;
  const tenant = process.env.XERO_TENANT_ID;
  if (!token || !tenant) throw new Error("Missing Xero credentials");
  const body = {
    Type: "ACCREC",
    Contact: { Name: customerName, EmailAddress: customerEmail },
    LineItems: lineItems.map(li => ({
      Description: li.description,
      Quantity: li.quantity,
      UnitAmount: li.unitPrice,
    })),
    DueDate: dueDate || new Date().toISOString().slice(0, 10),
    CurrencyCode: currency || "USD",
  };
  const r = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Xero-Tenant-Id": tenant,
      "Content-Type": "application/json"
    },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.Elements?.[0]?.ValidationErrors?.[0]?.Message || `Xero HTTP ${r.status}`);
  return { id: j.Invoices?.[0]?.InvoiceID, link: j.Invoices?.[0]?.Url || "", status: "created" };
}

// -------------- STRIPE --------------
async function viaStripe({ customerEmail, lineItems, currency }) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  const items = lineItems.map(li => ({
    description: li.description,
    quantity: li.quantity,
    price_data: {
      currency: currency || "usd",
      product_data: { name: li.description },
      unit_amount: Math.round(li.unitPrice * 100)
    }
  }));
  const r = await fetch("https://api.stripe.com/v1/invoices", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      customer_email: customerEmail || "",
      auto_advance: "true",
      description: "Invoice generated via AI Assistant",
    })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Stripe HTTP ${r.status}`);
  return { id: j.id, link: j.hosted_invoice_url || "", status: "created" };
}

// -------------- FRESHBOOKS --------------
async function viaFreshBooks({ customerName, customerEmail, lineItems, currency }) {
  const token = process.env.FRESHBOOKS_TOKEN;
  const business = process.env.FRESHBOOKS_BUSINESS_ID;
  if (!token || !business) throw new Error("Missing FreshBooks credentials");
  const body = {
    invoice: {
      customerid: customerEmail,
      create_date: new Date().toISOString().slice(0, 10),
      currency_code: currency || "USD",
      lines: lineItems.map(li => ({
        name: li.description,
        qty: li.quantity,
        unit_cost: { amount: li.unitPrice, code: currency || "USD" }
      })),
      notes: "Generated by AI Assistant"
    }
  };
  const r = await fetch(`https://api.freshbooks.com/accounting/account/${business}/invoices/invoices`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `FreshBooks HTTP ${r.status}`);
  return { id: j.response?.result?.invoice?.id, link: j.response?.result?.invoice?.invoice_number, status: "created" };
}

// -------------- ZOHO BOOKS --------------
async function viaZohoBooks({ customerName, customerEmail, lineItems, currency }) {
  const token = process.env.ZOHO_BOOKS_TOKEN;
  const org = process.env.ZOHO_ORG_ID;
  if (!token || !org) throw new Error("Missing Zoho Books credentials");
  const body = {
    customer_name: customerName,
    contact_persons: [customerEmail],
    line_items: lineItems.map(li => ({
      name: li.description,
      rate: li.unitPrice,
      quantity: li.quantity
    })),
    currency_code: currency || "USD",
  };
  const r = await fetch(`https://books.zoho.com/api/v3/invoices?organization_id=${org}`, {
    method: "POST",
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Zoho Books HTTP ${r.status}`);
  return { id: j.invoice?.invoice_id, link: j.invoice?.invoice_url, status: "created" };
}

// -------------- WAVE --------------
async function viaWave({ customerName, lineItems, currency }) {
  const key = process.env.WAVE_ACCESS_TOKEN;
  if (!key) throw new Error("Missing WAVE_ACCESS_TOKEN");
  const body = {
    query: `
      mutation {
        invoiceCreate(input: {
          businessId: "YOUR_BUSINESS_ID",
          customer: { name: "${customerName}" },
          items: [
            ${lineItems.map(li => `{ description: "${li.description}", unitPrice: ${li.unitPrice}, quantity: ${li.quantity} }`).join(",")}
          ],
          currency: ${JSON.stringify(currency || "USD")}
        }) {
          invoice { id viewUrl status }
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
  const invoice = j.data?.invoiceCreate?.invoice;
  if (!invoice) throw new Error(j.errors?.[0]?.message || "Wave error");
  return { id: invoice.id, link: invoice.viewUrl, status: invoice.status || "created" };
}

// -------------- ODOO --------------
async function viaOdoo({ customerName, lineItems }) {
  const base = process.env.ODOO_BASE_URL;
  const db = process.env.ODOO_DB;
  const user = process.env.ODOO_USER;
  const key = process.env.ODOO_API_KEY;
  if (!base || !db || !user || !key) throw new Error("Missing Odoo credentials");
  const body = { model: "account.move", method: "create", args: [{
    move_type: "out_invoice",
    partner_id: customerName,
    invoice_line_ids: lineItems.map(li => [0, 0, { name: li.description, quantity: li.quantity, price_unit: li.unitPrice }]),
  }] };
  const r = await fetch(`${base}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: toJSON({ jsonrpc: "2.0", method: "call", params: { service: "object", method: "execute_kw", args: [db, user, key, "account.move", "create", [body.args[0]]] } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Odoo HTTP ${r.status}`);
  return { id: j.result, link: `${base}/web#id=${j.result}&model=account.move`, status: "created" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { customerName, lineItems } = input;
  if (!customerName || !Array.isArray(lineItems)) {
    emitErr(emit, "invoice_create: customerName and lineItems required");
    return { data: { error: "missing_fields" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `invoice_create[DRY_RUN]: provider=${provider || "n/a"} customer=${customerName}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "inv_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, "invoice_create[DEMO]: returning mock invoice");
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-invoice-${fake}`, status: "created" },
        link: `about:blank#demo-invoice-${fake}`,
      };
    }
    emitErr(emit, "invoice_create: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `invoice_create: via ${provider}`);
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
    return { data: { provider, id: out?.id, link: out?.link, status: out?.status || "created" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `invoice_create failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
