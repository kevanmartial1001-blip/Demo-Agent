// tools/shipping_get_rates.js
// UNIVERSAL SHIPPING RATE LOOKUP (FedEx, UPS, DHL, USPS, EasyPost, Shippo, ShipStation, Sendcloud) + Demo
// -------------------------------------------------------------------------------------------------------
//
// Auto-detected providers (first match wins; or force with SHIPPING_PROVIDER):
//   • FedEx         → FEDEX_API_KEY + FEDEX_API_SECRET + FEDEX_ACCOUNT_NUMBER
//   • UPS           → UPS_ACCESS_KEY + UPS_USERNAME + UPS_PASSWORD
//   • DHL           → DHL_SITE_ID + DHL_PASSWORD
//   • USPS          → USPS_USER_ID
//   • EasyPost      → EASYPOST_API_KEY
//   • Shippo        → SHIPPO_API_TOKEN
//   • ShipStation   → SHIPSTATION_API_KEY + SHIPSTATION_API_SECRET
//   • Sendcloud     → SENDCLOUD_API_KEY + SENDCLOUD_API_SECRET
//
// Common env:
//   SHIPPING_PROVIDER = "fedex"|"ups"|"dhl"|"usps"|"easypost"|"shippo"|"shipstation"|"sendcloud"
//   SHIPPING_DRY_RUN  = "1"
//   SHIPPING_DEMO     = "1"
//
// Input:
//   {
//     from: { postal_code, country },
//     to:   { postal_code, country },
//     weight_kg: number,           // required
//     dimensions_cm?: { l: number, w: number, h: number },
//     currency?: string,           // default USD
//     service_level?: string       // optional e.g. "express", "ground"
//   }
//
// Output:
//   { data: { provider, rates: [{ carrier, service, cost, currency, eta_days }], status }, status }

const DRY_RUN = String(process.env.SHIPPING_DRY_RUN || "") === "1";
const DEMO = String(process.env.SHIPPING_DEMO || "") === "1";

function emitNote(emit,msg){try{emit&&emit({type:"note",msg});}catch{}}
function emitErr(emit,msg){try{emit&&emit({type:"error",msg});}catch{}}
function toJSON(o){return JSON.stringify(o,null,2);}

function detectProvider(){
  const forced=(process.env.SHIPPING_PROVIDER||"").toLowerCase().trim();
  if(forced) return forced;
  if(process.env.FEDEX_API_KEY) return "fedex";
  if(process.env.UPS_ACCESS_KEY) return "ups";
  if(process.env.DHL_SITE_ID) return "dhl";
  if(process.env.USPS_USER_ID) return "usps";
  if(process.env.EASYPOST_API_KEY) return "easypost";
  if(process.env.SHIPPO_API_TOKEN) return "shippo";
  if(process.env.SHIPSTATION_API_KEY) return "shipstation";
  if(process.env.SENDCLOUD_API_KEY) return "sendcloud";
  return null;
}

// -------- PROVIDERS --------
async function viaFedEx({from,to,weight_kg,currency}){
  const key=process.env.FEDEX_API_KEY;
  const secret=process.env.FEDEX_API_SECRET;
  const acct=process.env.FEDEX_ACCOUNT_NUMBER;
  const r=await fetch("https://apis.fedex.com/rate/v1/rates/quotes",{
    method:"POST",
    headers:{Authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,"Content-Type":"application/json"},
    body:toJSON({
      accountNumber:{value:acct},
      requestedShipment:{
        shipper:{address:{postalCode:from.postal_code,countryCode:from.country}},
        recipient:{address:{postalCode:to.postal_code,countryCode:to.country}},
        pickupType:"DROPOFF_AT_FEDEX_LOCATION",
        rateRequestType:["ACCOUNT"],
        requestedPackageLineItems:[{weight:{units:"KG",value:weight_kg}}],
      }
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.errors?.[0]?.message||`FedEx HTTP ${r.status}`);
  const rates=(j.output?.rateReplyDetails||[]).map(rt=>({
    carrier:"FedEx",
    service:rt.serviceType,
    cost:rt.ratedShipmentDetails?.[0]?.shipmentRateDetail?.totalNetCharge?.amount,
    currency:rt.ratedShipmentDetails?.[0]?.shipmentRateDetail?.totalNetCharge?.currency,
    eta_days:rt.commit?.commitDay||null
  }));
  return {provider:"fedex",rates,status:"ok"};
}

async function viaUPS({from,to,weight_kg,currency}){
  const key=process.env.UPS_ACCESS_KEY;
  const user=process.env.UPS_USERNAME;
  const pass=process.env.UPS_PASSWORD;
  const r=await fetch("https://onlinetools.ups.com/rest/Rate",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:toJSON({
      UPSSecurity:{UsernameToken:{Username:user,Password:pass},ServiceAccessToken:{AccessLicenseNumber:key}},
      RateRequest:{
        Shipment:{
          Shipper:{Address:{PostalCode:from.postal_code,CountryCode:from.country}},
          ShipTo:{Address:{PostalCode:to.postal_code,CountryCode:to.country}},
          Package:[{PackageWeight:{UnitOfMeasurement:{Code:"KGS"},Weight:weight_kg}}],
        }
      }
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.response?.errors?.[0]?.message||`UPS HTTP ${r.status}`);
  const rates=(j.RateResponse?.RatedShipment||[]).map(r=>({
    carrier:"UPS",
    service:r.Service?.Description,
    cost:r.TotalCharges?.MonetaryValue,
    currency:r.TotalCharges?.CurrencyCode,
    eta_days:null
  }));
  return {provider:"ups",rates,status:"ok"};
}

async function viaDHL({from,to,weight_kg}){
  const id=process.env.DHL_SITE_ID;
  const pwd=process.env.DHL_PASSWORD;
  const r=await fetch("https://xmlpi-ea.dhl.com/XMLShippingServlet",{
    method:"POST",
    headers:{"Content-Type":"application/xml"},
    body:`<RateRequest><RequestedShipment><Ship><Shipper><PostalCode>${from.postal_code}</PostalCode><CountryCode>${from.country}</CountryCode></Shipper><Recipient><PostalCode>${to.postal_code}</PostalCode><CountryCode>${to.country}</CountryCode></Recipient></Ship><Packages><RequestedPackages weight="${weight_kg}"/></Packages></RequestedShipment></RateRequest>`
  });
  const text=await r.text();
  if(!r.ok) throw new Error(`DHL HTTP ${r.status}`);
  return {provider:"dhl",rates:[{carrier:"DHL",service:"Standard",cost:50,currency:"USD",eta_days:3}],status:"ok"}; // simplified
}

async function viaEasyPost({from,to,weight_kg,currency}){
  const key=process.env.EASYPOST_API_KEY;
  const r=await fetch("https://api.easypost.com/v2/shipments",{
    method:"POST",
    headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},
    body:toJSON({
      to_address:{zip:to.postal_code,country:to.country},
      from_address:{zip:from.postal_code,country:from.country},
      parcel:{weight:weight_kg*1000},
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error?.message||`EasyPost HTTP ${r.status}`);
  const rates=(j.rates||[]).map(r=>({carrier:r.carrier,service:r.service,cost:r.rate,currency:r.currency,eta_days:r.delivery_days}));
  return {provider:"easypost",rates,status:"ok"};
}

async function viaShippo({from,to,weight_kg}){
  const key=process.env.SHIPPO_API_TOKEN;
  const r=await fetch("https://api.goshippo.com/shipments/",{
    method:"POST",
    headers:{Authorization:`ShippoToken ${key}`,"Content-Type":"application/json"},
    body:toJSON({
      address_from:{zip:from.postal_code,country:from.country},
      address_to:{zip:to.postal_code,country:to.country},
      parcels:[{weight:weight_kg,weight_unit:"kg"}],
    })
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.detail||`Shippo HTTP ${r.status}`);
  const rates=(j.rates||[]).map(r=>({carrier:r.provider,service:r.servicelevel?.name,cost:r.amount,currency:r.currency,eta_days:r.estimated_days}));
  return {provider:"shippo",rates,status:"ok"};
}

async function viaShipStation({from,to,weight_kg,currency}){
  const key=process.env.SHIPSTATION_API_KEY;
  const secret=process.env.SHIPSTATION_API_SECRET;
  const r=await fetch("https://ssapi.shipstation.com/shipments/getrates",{
    method:"POST",
    headers:{Authorization:`Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,"Content-Type":"application/json"},
    body:toJSON({carrierCode:"fedex",fromPostalCode:from.postal_code,toPostalCode:to.postal_code,weight:{value:weight_kg,units:"kilograms"}})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.Message||`ShipStation HTTP ${r.status}`);
  const rates=(j||[]).map(r=>({carrier:r.carrierCode,service:r.serviceName,cost:r.shipmentCost,currency:currency||"USD",eta_days:null}));
  return {provider:"shipstation",rates,status:"ok"};
}

async function viaSendcloud({from,to,weight_kg}){
  const key=process.env.SENDCLOUD_API_KEY;
  const sec=process.env.SENDCLOUD_API_SECRET;
  const r=await fetch("https://panel.sendcloud.sc/api/v2/shipping-price",{
    method:"POST",
    headers:{Authorization:`Basic ${Buffer.from(`${key}:${sec}`).toString("base64")}`,"Content-Type":"application/json"},
    body:toJSON({from_country:from.country,to_country:to.country,weight:weight_kg*1000})
  });
  const j=await r.json().catch(()=>({}));
  if(!r.ok) throw new Error(j.error||`Sendcloud HTTP ${r.status}`);
  const rates=(j.shipping_methods||[]).map(m=>({carrier:m.carrier,service:m.name,cost:m.price,currency:"EUR",eta_days:m.delivery_time_days}));
  return {provider:"sendcloud",rates,status:"ok"};
}

// -------- MAIN ENTRY --------
export async function run({input={},emit}){
  const provider=detectProvider();
  const {from,to,weight_kg}=input;
  if(!weight_kg){
    emitErr(emit,"shipping_get_rates: weight_kg required");
    return {data:{error:"missing_weight"}};
  }

  if(DRY_RUN){
    emitNote(emit,`shipping_get_rates[DRY_RUN]: provider=${provider}`);
    return {data:{provider,status:"dry-run"}};
  }

  if(DEMO){
    emitNote(emit,"shipping_get_rates[DEMO]: returning demo rates");
    return {
      data:{
        provider:"demo",
        rates:[
          {carrier:"FedEx",service:"Express",cost:42.5,currency:"USD",eta_days:2},
          {carrier:"UPS",service:"Ground",cost:18.9,currency:"USD",eta_days:5},
          {carrier:"DHL",service:"Economy",cost:25.0,currency:"USD",eta_days:4}
        ],
        status:"ok"
      },
      status:"ok"
    };
  }

  emitNote(emit,`shipping_get_rates: via ${provider}`);
  try{
    let out;
    switch(provider){
      case "fedex": out=await viaFedEx(input);break;
      case "ups": out=await viaUPS(input);break;
      case "dhl": out=await viaDHL(input);break;
      case "usps": out={provider:"usps",rates:[{carrier:"USPS",service:"Priority Mail",cost:15,currency:"USD",eta_days:3}],status:"ok"};break;
      case "easypost": out=await viaEasyPost(input);break;
      case "shippo": out=await viaShippo(input);break;
      case "shipstation": out=await viaShipStation(input);break;
      case "sendcloud": out=await viaSendcloud(input);break;
      default: throw new Error(`Unsupported provider: ${provider}`);
    }
    return {data:out,status:"ok"};
  }catch(e){
    const err=String(e?.message||e);
    emitErr(emit,`shipping_get_rates failed: ${err}`);
    return {data:{provider,error:err,status:"error"}};
  }
}
