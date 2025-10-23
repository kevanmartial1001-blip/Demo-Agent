// tools/order_create.js
// UNIVERSAL ORDER CREATOR (Shopify, WooCommerce, Stripe, Square, QuickBooks, Zoho Inventory, Odoo, Airtable) + Demo
// ----------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with ORDER_PROVIDER):
//   • Shopify        → SHOPIFY_API_KEY + SHOPIFY_PASSWORD + SHOPIFY_STORE_DOMAIN
//   • WooCommerce    → WOOCOMMERCE_URL + WOOCOMMERCE_CONSUMER_KEY + WOOCOMMERCE_CONSUMER_SECRET
//   • Stripe         → STRIPE_API_KEY
//   • Square         → SQUARE_ACCESS_TOKEN
//   • QuickBooks     → QBO_ACCESS_TOKEN + QBO_REALM_ID
//   • Zoho Inventory → ZOHO_ACCESS_TOKEN + ZOHO_ORG_ID
//   • Odoo           → ODOO_URL + ODOO_DB + ODOO_USER + ODOO_API_KEY
//   • Airtable       → AIRTABLE_API_KEY + AIRTABLE_BASE_ID + AIRTABLE_TABLE_NAME
//
// Common env:
//   ORDER_PROVIDER   = "shopify"|"woocommerce"|"stripe"|"square"|"quickbooks"|"zoho"|"odoo"|"airtable"
//   ORDER_DRY_RUN    = "1"
//   ORDER_DEMO       = "1"
//
// Input:
//   {
//     customer: { name?: string, email?: string, address?: object },
//     items: [{ sku: string, quantity: number, price?: number }],
//     currency?: string,         // default "USD"
//     note?: string
//   }
//
// Output:
//   { data: { provider, id?: string|null, link?: string, total?: number, status }, link?: string }

import fs from "fs";

const DRY_RUN = String(process.env.ORDER_DRY_RUN || "") === "1";
const DEMO = String(process.env.ORDER_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.ORDER_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.SHOPIFY_API_KEY) return "shopify";
  if(process.env.WOOCOMMERCE_URL) return "woocommerce";
  if(process.env.STRIPE_API_KEY) return "stripe";
  if(process.env.SQUARE_ACCESS_TOKEN) return "square";
  if(process.env.QBO_ACCESS_TOKEN) return "quickbooks";
  if(process.env.ZOHO_ACCESS_TOKEN) return "zoho";
  if(process.env.ODOO_URL) return "odoo";
  if(process.env.AIRTABLE_API_KEY) return "airtable";
  return null;
}

// -------- PROVIDERS --------
async function viaShopify({customer,items,currency,note}){
  const domain=process.env.SHOPIFY_STORE_DOMAIN;
  const key=process.env.SHOPIFY_API_KEY;
  const pwd=process.env.SHOPIFY_PASSWORD;
  const body={
    order:{
      email:customer?.email,
      note,
      currency:currency||"USD",
      line_items:items.map(i=>({sku:i.sku,quantity:i.quantity,price:i.price})),
      customer:{first_name:customer?.name||"Guest"},
      financial_status:"pending"
    }
  };
  const r=await fetch(`https://${key}:${pwd}@${domain}/admin/api/2023-10/orders.json`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON(body)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors||`Shopify HTTP ${r.status}`);
  return {id:j.order?.id,link:`https://${domain}/admin/orders/${j.order?.id}`,total:j.order?.total_price,status:"created"};
}

async function viaWooCommerce({customer,items,currency,note}){
  const url=process.env.WOOCOMMERCE_URL;
  const ck=process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs=process.env.WOOCOMMERCE_CONSUMER_SECRET;
  const body={
    payment_method:"manual",
    set_paid:false,
    billing:{email:customer?.email,name:customer?.name},
    line_items:items.map(i=>({sku:i.sku,quantity:i.quantity,price:i.price})),
    currency:currency||"USD",
    customer_note:note
  };
  const r=await fetch(`${url}/wp-json/wc/v3/orders`,{
    method:"POST",
    headers:{Authorization:`Basic ${Buffer.from(`${ck}:${cs}`).toString("base64")}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`WooCommerce HTTP ${r.status}`);
  return {id:j.id,link:`${url}/wp-admin/post.php?post=${j.id}&action=edit`,total:j.total,status:"created"};
}

async function viaStripe({customer,items,currency,note}){
  const key=process.env.STRIPE_API_KEY;
  const total=items.reduce((s,i)=>s+(i.price||0)*i.quantity,0);
  const r=await fetch("https://api.stripe.com/v1/payment_intents",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams({amount:Math.round(total*100).toString(),currency:currency||"usd",description:note||"AI Order"})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Stripe HTTP ${r.status}`);
  return {id:j.id,link:j.charges?.data?.[0]?.receipt_url||null,total,total,status:"created"};
}

async function viaSquare({customer,items,currency}){
  const key=process.env.SQUARE_ACCESS_TOKEN;
  const total=items.reduce((s,i)=>s+(i.price||0)*i.quantity,0);
  const r=await fetch("https://connect.squareup.com/v2/orders",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({order:{line_items:items.map(i=>({name:i.sku,quantity:i.quantity.toString(),base_price_money:{amount:i.price*100,currency:currency||"USD"}}))}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]?.detail||`Square HTTP ${r.status}`);
  return {id:j.order?.id,link:`https://squareup.com/dashboard/orders/${j.order?.id}`,total,status:"created"};
}

async function viaQuickBooks({customer,items,currency}){
  const token=process.env.QBO_ACCESS_TOKEN;
  const realm=process.env.QBO_REALM_ID;
  const total=items.reduce((s,i)=>s+(i.price||0)*i.quantity,0);
  const r=await fetch(`https://quickbooks.api.intuit.com/v3/company/${realm}/invoice`,{
    method:"POST",
    headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
    body:toJSON({Line:items.map(i=>({Amount:(i.price||0)*i.quantity,DetailType:"SalesItemLineDetail",SalesItemLineDetail:{ItemRef:{name:i.sku}}})),CustomerRef:{name:customer?.name},CurrencyRef:{value:currency||"USD"}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.Fault?.Error?.[0]?.Message||`QuickBooks HTTP ${r.status}`);
  return {id:j.Invoice?.Id,link:`https://qbo.intuit.com/app/invoice?txnId=${j.Invoice?.Id}`,total,status:"created"};
}

async function viaZoho({customer,items,currency}){
  const token=process.env.ZOHO_ACCESS_TOKEN;
  const org=process.env.ZOHO_ORG_ID;
  const body={customer_name:customer?.name,line_items:items.map(i=>({item_name:i.sku,quantity:i.quantity,rate:i.price})),currency_id:currency||"USD"};
  const r=await fetch(`https://inventory.zoho.com/api/v1/salesorders?organization_id=${org}`,{
    method:"POST",
    headers:{Authorization:`Zoho-oauthtoken ${token}`,"Content-Type":"application/json"},
    body:toJSON(body)
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Zoho HTTP ${r.status}`);
  return {id:j.salesorder?.salesorder_id,link:`https://inventory.zoho.com/app#/salesorders/${j.salesorder?.salesorder_id}`,total:j.salesorder?.total,status:"created"};
}

async function viaOdoo({customer,items,currency}){
  const url=process.env.ODOO_URL;
  const db=process.env.ODOO_DB;
  const user=process.env.ODOO_USER;
  const key=process.env.ODOO_API_KEY;
  const total=items.reduce((s,i)=>s+(i.price||0)*i.quantity,0);
  const r=await fetch(`${url}/jsonrpc`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({jsonrpc:"2.0",method:"call",params:{service:"object",method:"execute_kw",args:[db,1,key,"sale.order","create",[{"partner_id":1,"amount_total":total}]]}})
  });
  const j=await r.json().catch(()=>({}));
  if(!j.result) throw new Error("Odoo order creation failed");
  return {id:j.result,link:`${url}/web#id=${j.result}&model=sale.order&view_type=form`,total,status:"created"};
}

async function viaAirtable({customer,items,currency,note}){
  const key=process.env.AIRTABLE_API_KEY;
  const base=process.env.AIRTABLE_BASE_ID;
  const table=process.env.AIRTABLE_TABLE_NAME;
  const total=items.reduce((s,i)=>s+(i.price||0)*i.quantity,0);
  const r=await fetch(`https://api.airtable.com/v0/${base}/${table}`,{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({records:[{fields:{Customer:customer?.name,Email:customer?.email,Items:items.map(i=>i.sku).join(", "),Total:total,Note:note}}]})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Airtable HTTP ${r.status}`);
  return {id:j.records?.[0]?.id,link:`https://airtable.com/${base}/${table}`,total,status:"created"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {customer,items}=input;
  if(!items?.length){
    emitErr(emit,"order_create: items required");
    return {data:{error:"missing_items"}};
  }

  if(DRY_RUN){
    emitNote(emit,`order_create[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"order_create[DEMO]: returning mock order");
    const fake="ord_"+Math.random().toString(36).slice(2,9);
    const total=items.reduce((s,i)=>s+(i.price||0)*i.quantity,0);
    return {data:{provider:"demo",id:fake,link:`about:blank#demo-order-${fake}`,total,status:"created"}};
  }

  emitNote(emit,`order_create: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "shopify": out=await viaShopify(input);break;
      case "woocommerce": out=await viaWooCommerce(input);break;
      case "stripe": out=await viaStripe(input);break;
      case "square": out=await viaSquare(input);break;
      case "quickbooks": out=await viaQuickBooks(input);break;
      case "zoho": out=await viaZoho(input);break;
      case "odoo": out=await viaOdoo(input);break;
      case "airtable": out=await viaAirtable(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:{provider,id:out?.id,link:out?.link,total:out?.total,status:out?.status||"created"},link:out?.link};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`order_create failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
