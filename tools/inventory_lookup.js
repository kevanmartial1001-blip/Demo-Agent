// tools/inventory_lookup.js
// UNIVERSAL INVENTORY LOOKUP (Shopify, WooCommerce, Stripe, Square, Airtable, Odoo, Zoho Inventory, QuickBooks Commerce, CSV) + Demo
// ------------------------------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with INVENTORY_PROVIDER):
//   • Shopify            → SHOPIFY_API_KEY + SHOPIFY_PASSWORD + SHOPIFY_STORE_DOMAIN
//   • WooCommerce        → WOOCOMMERCE_URL + WOOCOMMERCE_CONSUMER_KEY + WOOCOMMERCE_CONSUMER_SECRET
//   • Stripe             → STRIPE_API_KEY
//   • Square             → SQUARE_ACCESS_TOKEN
//   • Airtable           → AIRTABLE_API_KEY + AIRTABLE_BASE_ID + AIRTABLE_TABLE_NAME
//   • Odoo               → ODOO_URL + ODOO_DB + ODOO_USER + ODOO_API_KEY
//   • Zoho Inventory     → ZOHO_ACCESS_TOKEN
//   • QuickBooks Commerce→ QBO_ACCESS_TOKEN
//   • Local CSV fallback → ./data/inventory.csv
//
// Common env:
//   INVENTORY_PROVIDER  = "shopify"|"woocommerce"|"stripe"|"square"|"airtable"|"odoo"|"zoho"|"quickbooks"|"csv"
//   INVENTORY_DRY_RUN   = "1"
//   INVENTORY_DEMO      = "1"
//
// Input:
//   {
//     query: string,            // required: name, SKU, or keyword
//     limit?: number,           // default 5
//     warehouse?: string        // optional warehouse name
//   }
//
// Output:
//   { data: { provider, query, items: [{ sku, name, quantity, price, location }], status }, status }

import fs from "fs";

const DRY_RUN = String(process.env.INVENTORY_DRY_RUN || "") === "1";
const DEMO = String(process.env.INVENTORY_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.INVENTORY_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.SHOPIFY_API_KEY) return "shopify";
  if(process.env.WOOCOMMERCE_URL) return "woocommerce";
  if(process.env.STRIPE_API_KEY) return "stripe";
  if(process.env.SQUARE_ACCESS_TOKEN) return "square";
  if(process.env.AIRTABLE_API_KEY) return "airtable";
  if(process.env.ODOO_URL) return "odoo";
  if(process.env.ZOHO_ACCESS_TOKEN) return "zoho";
  if(process.env.QBO_ACCESS_TOKEN) return "quickbooks";
  return "csv";
}

// -------- PROVIDERS --------
async function viaShopify({query,limit}){
  const domain=process.env.SHOPIFY_STORE_DOMAIN;
  const key=process.env.SHOPIFY_API_KEY;
  const pwd=process.env.SHOPIFY_PASSWORD;
  const r=await fetch(`https://${key}:${pwd}@${domain}/admin/api/2023-10/products.json?limit=${limit||5}&title=${encodeURIComponent(query)}`);
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors||`Shopify HTTP ${r.status}`);
  const items=(j.products||[]).map(p=>({sku:p.variants?.[0]?.sku,name:p.title,quantity:p.variants?.[0]?.inventory_quantity,price:p.variants?.[0]?.price,location:"Shopify"}));
  return {provider:"shopify",query,items,status:"ok"};
}

async function viaWooCommerce({query,limit}){
  const url=process.env.WOOCOMMERCE_URL;
  const ck=process.env.WOOCOMMERCE_CONSUMER_KEY;
  const cs=process.env.WOOCOMMERCE_CONSUMER_SECRET;
  const r=await fetch(`${url}/wp-json/wc/v3/products?search=${encodeURIComponent(query)}&per_page=${limit||5}`,{
    headers:{Authorization:`Basic ${Buffer.from(`${ck}:${cs}`).toString("base64")}`}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`WooCommerce HTTP ${r.status}`);
  const items=j.map(p=>({sku:p.sku,name:p.name,quantity:p.stock_quantity,price:p.price,location:"WooCommerce"}));
  return {provider:"woocommerce",query,items,status:"ok"};
}

async function viaStripe({query,limit}){
  const key=process.env.STRIPE_API_KEY;
  const r=await fetch(`https://api.stripe.com/v1/products?limit=${limit||5}&active=true`,{
    headers:{Authorization:`Bearer ${key}`}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Stripe HTTP ${r.status}`);
  const items=(j.data||[]).filter(p=>p.name.toLowerCase().includes(query.toLowerCase())).map(p=>({sku:p.id,name:p.name,quantity:null,price:null,location:"Stripe"}));
  return {provider:"stripe",query,items,status:"ok"};
}

async function viaSquare({query,limit}){
  const key=process.env.SQUARE_ACCESS_TOKEN;
  const r=await fetch("https://connect.squareup.com/v2/catalog/search",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({query:{text_filter:{text:query}},limit:limit||5})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]?.detail||`Square HTTP ${r.status}`);
  const items=(j.objects||[]).map(o=>({sku:o.id,name:o.item_data?.name,quantity:null,price:o.item_data?.price_money?.amount/100,location:"Square"}));
  return {provider:"square",query,items,status:"ok"};
}

async function viaAirtable({query,limit}){
  const key=process.env.AIRTABLE_API_KEY;
  const base=process.env.AIRTABLE_BASE_ID;
  const table=process.env.AIRTABLE_TABLE_NAME;
  const r=await fetch(`https://api.airtable.com/v0/${base}/${table}?filterByFormula=SEARCH("${query}",{Name})`,{
    headers:{Authorization:`Bearer ${key}`}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`Airtable HTTP ${r.status}`);
  const items=(j.records||[]).slice(0,limit||5).map(r=>({sku:r.fields.SKU,name:r.fields.Name,quantity:r.fields.Quantity,price:r.fields.Price,location:r.fields.Location||"Airtable"}));
  return {provider:"airtable",query,items,status:"ok"};
}

async function viaOdoo({query,limit}){
  const url=process.env.ODOO_URL;
  const db=process.env.ODOO_DB;
  const user=process.env.ODOO_USER;
  const key=process.env.ODOO_API_KEY;
  const r=await fetch(`${url}/jsonrpc`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({jsonrpc:"2.0",method:"call",params:{service:"object",method:"execute_kw",args:[db,1,key,"product.product","search_read",[[["name","ilike",query]]],{limit:limit||5,fields:["default_code","name","qty_available","list_price"]}]}})
  });
  const j=await r.json().catch(()=>({}));
  const items=(j.result||[]).map(p=>({sku:p.default_code,name:p.name,quantity:p.qty_available,price:p.list_price,location:"Odoo"}));
  return {provider:"odoo",query,items,status:"ok"};
}

async function viaZoho({query,limit}){
  const token=process.env.ZOHO_ACCESS_TOKEN;
  const r=await fetch(`https://inventory.zoho.com/api/v1/items?organization_id=${process.env.ZOHO_ORG_ID}&name=${encodeURIComponent(query)}&per_page=${limit||5}`,{
    headers:{Authorization:`Zoho-oauthtoken ${token}`}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.message||`Zoho HTTP ${r.status}`);
  const items=(j.items||[]).map(i=>({sku:i.sku,name:i.name,quantity:i.available_stock,price:i.rate,location:"Zoho Inventory"}));
  return {provider:"zoho",query,items,status:"ok"};
}

async function viaQuickBooks({query,limit}){
  const token=process.env.QBO_ACCESS_TOKEN;
  const realm=process.env.QBO_REALM_ID;
  const r=await fetch(`https://quickbooks.api.intuit.com/v3/company/${realm}/query?query=select * from Item where Name like '%${query}%' maxresults ${limit||5}`,{
    headers:{Authorization:`Bearer ${token}`,"Accept":"application/json"}
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.Fault?.Error?.[0]?.Message||`QuickBooks HTTP ${r.status}`);
  const items=(j.QueryResponse?.Item||[]).map(i=>({sku:i.Id,name:i.Name,quantity:i.QuantityOnHand,price:i.UnitPrice,location:"QuickBooks"}));
  return {provider:"quickbooks",query,items,status:"ok"};
}

async function viaCSV({query,limit}){
  const path="./data/inventory.csv";
  if(!fs.existsSync(path)) throw new Error("inventory.csv not found");
  const lines=fs.readFileSync(path,"utf-8").split("\n").slice(1);
  const items=[];
  for(const line of lines){
    const [sku,name,qty,price,loc]=line.split(",");
    if(name?.toLowerCase().includes(query.toLowerCase()) || sku?.toLowerCase().includes(query.toLowerCase())){
      items.push({sku,name,quantity:Number(qty),price:Number(price),location:loc||"CSV"});
    }
  }
  return {provider:"csv",query,items:items.slice(0,limit||5),status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {query}=input;
  if(!query){
    emitErr(emit,"inventory_lookup: query required");
    return {data:{error:"missing_query"}};
  }

  if(DRY_RUN){
    emitNote(emit,`inventory_lookup[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"inventory_lookup[DEMO]: returning mock inventory");
    return {
      data:{
        provider:"demo",
        query,
        items:[
          {sku:"SKU-123",name:`Demo ${query} Hoodie`,quantity:42,price:79.99,location:"Demo Warehouse"},
          {sku:"SKU-124",name:`Demo ${query} Cap`,quantity:100,price:29.99,location:"Demo Warehouse"}
        ],
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`inventory_lookup: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "shopify": out=await viaShopify(input);break;
      case "woocommerce": out=await viaWooCommerce(input);break;
      case "stripe": out=await viaStripe(input);break;
      case "square": out=await viaSquare(input);break;
      case "airtable": out=await viaAirtable(input);break;
      case "odoo": out=await viaOdoo(input);break;
      case "zoho": out=await viaZoho(input);break;
      case "quickbooks": out=await viaQuickBooks(input);break;
      case "csv": out=await viaCSV(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`inventory_lookup failed: ${err}`);
    return {data:{provider,query,error:err,status:"error"}};
  }
}
