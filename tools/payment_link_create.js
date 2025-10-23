// tools/payment_link_create.js
// UNIVERSAL PAYMENT LINK GENERATOR (Stripe, PayPal, Square, Razorpay, Mollie, Adyen, Wise) + Demo
// -----------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with PAYMENT_PROVIDER):
//   • Stripe        → STRIPE_SECRET_KEY
//   • PayPal        → PAYPAL_CLIENT_ID + PAYPAL_SECRET
//   • Square        → SQUARE_ACCESS_TOKEN
//   • Razorpay      → RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET
//   • Mollie        → MOLLIE_API_KEY
//   • Adyen         → ADYEN_API_KEY
//   • Wise          → WISE_API_TOKEN
//
// Common env:
//   PAYMENT_PROVIDER  = "stripe"|"paypal"|"square"|"razorpay"|"mollie"|"adyen"|"wise"
//   PAYMENT_DRY_RUN   = "1"
//   PAYMENT_DEMO      = "1"
//
// Input:
//   {
//     amount: number,              // required (decimal)
//     currency?: string,           // default: "USD"
//     description?: string,        // optional
//     successUrl?: string,         // optional redirect URL
//     cancelUrl?: string,          // optional redirect URL
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, status?: string }, link?: string }

const DRY_RUN = String(process.env.PAYMENT_DRY_RUN || "") === "1";
const DEMO = String(process.env.PAYMENT_DEMO || "") === "1";

function detectProvider() {
  const forced = (process.env.PAYMENT_PROVIDER || "").toLowerCase().trim();
  if (forced) return forced;
  if (process.env.STRIPE_SECRET_KEY) return "stripe";
  if (process.env.PAYPAL_CLIENT_ID) return "paypal";
  if (process.env.SQUARE_ACCESS_TOKEN) return "square";
  if (process.env.RAZORPAY_KEY_ID) return "razorpay";
  if (process.env.MOLLIE_API_KEY) return "mollie";
  if (process.env.ADYEN_API_KEY) return "adyen";
  if (process.env.WISE_API_TOKEN) return "wise";
  return null;
}

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toForm(data){return new URLSearchParams(data).toString();}
function toJSON(o){return JSON.stringify(o,null,2);}

// -------------- STRIPE --------------
async function viaStripe({ amount, currency, description, successUrl, cancelUrl }) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Missing STRIPE_SECRET_KEY");
  const cents = Math.round(amount * 100);
  const r = await fetch("https://api.stripe.com/v1/payment_links", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: toForm({
      "line_items[0][price_data][currency]": currency || "usd",
      "line_items[0][price_data][product_data][name]": description || "Payment",
      "line_items[0][price_data][unit_amount]": cents.toString(),
      "line_items[0][quantity]": "1",
      success_url: successUrl || "https://example.com/success",
      cancel_url: cancelUrl || "https://example.com/cancel",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `Stripe HTTP ${r.status}`);
  return { id: j.id, link: j.url, status: "created" };
}

// -------------- PAYPAL --------------
async function viaPayPal({ amount, currency, description }) {
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_SECRET;
  if (!id || !secret) throw new Error("Missing PayPal credentials");
  const tokenRes = await fetch("https://api-m.paypal.com/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const { access_token } = await tokenRes.json();
  const r = await fetch("https://api-m.paypal.com/v2/checkout/orders", {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: toJSON({
      intent: "CAPTURE",
      purchase_units: [{ amount: { currency_code: currency || "USD", value: amount.toFixed(2) }, description }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  const link = j.links?.find(l => l.rel === "approve")?.href;
  if (!link) throw new Error(j.message || "PayPal link missing");
  return { id: j.id, link, status: "created" };
}

// -------------- SQUARE --------------
async function viaSquare({ amount, currency, description }) {
  const key = process.env.SQUARE_ACCESS_TOKEN;
  if (!key) throw new Error("Missing SQUARE_ACCESS_TOKEN");
  const r = await fetch("https://connect.squareup.com/v2/checkout/payment-links", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON({
      idempotency_key: crypto.randomUUID(),
      quick_pay: { name: description || "Payment", price_money: { amount: Math.round(amount * 100), currency: currency || "USD" } },
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.errors?.[0]?.detail || `Square HTTP ${r.status}`);
  return { id: j.payment_link?.id, link: j.payment_link?.url, status: "created" };
}

// -------------- RAZORPAY --------------
async function viaRazorpay({ amount, currency, description }) {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error("Missing Razorpay credentials");
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const r = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: toJSON({ amount: Math.round(amount * 100), currency: currency || "INR", description }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.description || `Razorpay HTTP ${r.status}`);
  return { id: j.id, link: j.short_url, status: "created" };
}

// -------------- MOLLIE --------------
async function viaMollie({ amount, currency, description, successUrl }) {
  const key = process.env.MOLLIE_API_KEY;
  if (!key) throw new Error("Missing MOLLIE_API_KEY");
  const r = await fetch("https://api.mollie.com/v2/payments", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: toJSON({ amount: { value: amount.toFixed(2), currency: currency || "EUR" }, description, redirectUrl: successUrl || "https://example.com/thanks" }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || `Mollie HTTP ${r.status}`);
  return { id: j.id, link: j._links?.checkout?.href, status: "created" };
}

// -------------- ADYEN --------------
async function viaAdyen({ amount, currency, description }) {
  const key = process.env.ADYEN_API_KEY;
  if (!key) throw new Error("Missing ADYEN_API_KEY");
  const merchant = process.env.ADYEN_MERCHANT_ACCOUNT;
  const r = await fetch("https://checkout-test.adyen.com/v70/paymentLinks", {
    method: "POST",
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    body: toJSON({
      amount: { currency: currency || "EUR", value: Math.round(amount * 100) },
      reference: "AI-" + Date.now(),
      description: description || "Payment via AI Assistant",
      merchantAccount: merchant || "DefaultMerchant",
      returnUrl: "https://example.com/thankyou",
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || `Adyen HTTP ${r.status}`);
  return { id: j.id || j.pspReference, link: j.url, status: "created" };
}

// -------------- WISE --------------
async function viaWise({ amount, currency, description }) {
  const token = process.env.WISE_API_TOKEN;
  if (!token) throw new Error("Missing WISE_API_TOKEN");
  const profile = process.env.WISE_PROFILE_ID;
  const body = {
    sourceCurrency: currency || "USD",
    targetCurrency: currency || "USD",
    targetAmount: amount,
    reference: description || "Payment via AI Assistant",
  };
  const r = await fetch(`https://api.transferwise.com/v1/profiles/${profile}/quotes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: toJSON(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Wise HTTP ${r.status}`);
  return { id: j.id, link: `https://wise.com/payments/${j.id}`, status: "created" };
}

// -------------- MAIN ENTRY --------------
export async function run({ input = {}, emit }) {
  const provider = detectProvider();
  const { amount } = input;
  if (!amount) {
    emitErr(emit, "payment_link_create: amount is required");
    return { data: { error: "missing_amount" } };
  }

  if (DRY_RUN) {
    emitNote(emit, `payment_link_create[DRY_RUN]: provider=${provider || "n/a"} amount=${amount}`);
    return { data: { provider: provider || "dry-run", status: "dry-run" } };
  }

  if (!provider) {
    if (DEMO) {
      const fake = "pay_" + Math.random().toString(36).slice(2, 9);
      emitNote(emit, "payment_link_create[DEMO]: returning mock payment link");
      return {
        data: { provider: "demo", id: fake, link: `about:blank#demo-payment-${fake}`, status: "created" },
        link: `about:blank#demo-payment-${fake}`,
      };
    }
    emitErr(emit, "payment_link_create: no provider configured.");
    return { data: { error: "no_provider_configured" } };
  }

  emitNote(emit, `payment_link_create: via ${provider}`);
  try {
    let out;
    switch (provider) {
      case "stripe": out = await viaStripe(input); break;
      case "paypal": out = await viaPayPal(input); break;
      case "square": out = await viaSquare(input); break;
      case "razorpay": out = await viaRazorpay(input); break;
      case "mollie": out = await viaMollie(input); break;
      case "adyen": out = await viaAdyen(input); break;
      case "wise": out = await viaWise(input); break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return { data: { provider, id: out?.id, link: out?.link, status: out?.status || "created" }, link: out?.link };
  } catch (e) {
    const err = String(e?.message || e);
    emitErr(emit, `payment_link_create failed: ${err}`);
    return { data: { error: err, provider } };
  }
}
