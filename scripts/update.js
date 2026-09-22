#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA, "history.json");
const OUT_FILE = path.join(DATA, "fear-greed.json");
const MARKET_FILE = path.join(DATA, "market.json");

const MIN_COVERAGE = 70;
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
const UA = "Mozilla/5.0 FearGreedFrance/3.0 (+https://www.zonage-terrain.fr/)";

const CAC40 = [
  ["Accor",["AC.PA"]],["Air Liquide",["AI.PA"]],["Airbus",["AIR.PA"]],
  ["ArcelorMittal",["MT.AS","MT.PA"]],["AXA",["CS.PA"]],["BNP Paribas",["BNP.PA"]],
  ["Bouygues",["EN.PA"]],["Bureau Veritas",["BVI.PA"]],["Capgemini",["CAP.PA"]],
  ["Carrefour",["CA.PA"]],["Crédit Agricole",["ACA.PA"]],["Danone",["BN.PA"]],
  ["Dassault Systèmes",["DSY.PA"]],["Eiffage",["FGR.PA"]],["Engie",["ENGI.PA"]],
  ["EssilorLuxottica",["EL.PA"]],["Eurofins Scientific",["ERF.PA"]],["Euronext",["ENX.PA"]],
  ["Hermès",["RMS.PA"]],["Kering",["KER.PA"]],["L'Oréal",["OR.PA"]],
  ["Legrand",["LR.PA"]],["LVMH",["MC.PA"]],["Michelin",["ML.PA"]],
  ["Orange",["ORA.PA"]],["Pernod Ricard",["RI.PA"]],["Publicis Groupe",["PUB.PA"]],
  ["Renault",["RNO.PA"]],["Safran",["SAF.PA"]],["Saint-Gobain",["SGO.PA"]],
  ["Sanofi",["SAN.PA"]],["Schneider Electric",["SU.PA"]],["Société Générale",["GLE.PA"]],
  ["Stellantis",["STLAP.PA","STLAM.MI"]],["STMicroelectronics",["STMPA.PA","STM.PA"]],
  ["Thales",["HO.PA"]],["TotalEnergies",["TTE.PA"]],["Unibail-Rodamco-Westfield",["URW.PA"]],
  ["Veolia",["VIE.PA"]],["Vinci",["DG.PA"]]
];

const COMPONENTS = [
  {key:"momentum",name:"Momentum CAC 40",weight:15},
  {key:"breadth",name:"Breadth CAC 40",weight:20},
  {key:"strength",name:"Force du marché",weight:10},
  {key:"volatility",name:"Volatilité",weight:15},
  {key:"drawdown",name:"Drawdown",weight:10},
  {key:"relative",name:"France vs Europe",weight:10},
  {key:"risk",name:"Actions vs or",weight:10},
  {key:"news",name:"Sentiment médias",weight:10}
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : null;
const last = a => a[a.length-1];

function sma(a,n,i=a.length-1){
  if(i-n+1<0)return null;
  const x=a.slice(i-n+1,i+1).filter(Number.isFinite);
  return x.length===n?mean(x):null;
}
function stdev(a){
  if(a.length<2)return null;
  const m=mean(a);
  return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));
}
function percentile(arr,val){
  const clean=arr.filter(Number.isFinite);
  if(!clean.length||!Number.isFinite(val))return null;
  let below=0,equal=0;
  for(const x of clean){if(x<val)below++;else if(x===val)equal++;}
  return 100*(below+0.5*equal)/clean.length;
}
function ret(a,n,i=a.length-1){
  if(i<n||!Number.isFinite(a[i])||!Number.isFinite(a[i-n]))return null;
  return a[i]/a[i-n]-1;
}
function rollingVol(a,n=20){
  const lr=[null];
  for(let i=1;i<a.length;i++)lr.push(a[i]>0&&a[i-1]>0?Math.log(a[i]/a[i-1]):null);
  return a.map((_,i)=>{
    if(i<n)return null;
    const w=lr.slice(i-n+1,i+1).filter(Number.isFinite);
    return w.length===n?stdev(w)*Math.sqrt(252):null;
  });
}
function rollingDrawdown(a,n=252){
  return a.map((x,i)=>{
    if(i<n-1)return null;
    const w=a.slice(i-n+1,i+1).filter(Number.isFinite);
    const mx=Math.max(...w);
    return mx>0?x/mx-1:null;
  });
}
function labelFor(s){
  if(s<25)return "Peur extrême";
  if(s<45)return "Peur";
  if(s<=55)return "Neutre";
  if(s<=75)return "Avidité";
  return "Avidité extrême";
}
function isoParisDate(ts){
  return new Intl.DateTimeFormat("fr-CA",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ts*1000));
}
function alignByDate(a,b){
  const mb=new Map(b.rows.map(x=>[x.t,x.close])),aa=[],bb=[],ts=[];
  for(const x of a.rows){
    if(mb.has(x.t)){aa.push(x.close);bb.push(mb.get(x.t));ts.push(x.t);}
  }
  return {a:aa,b:bb,ts};
}
function rollingRatioReturn(a,b,n=60){
  const L=Math.min(a.length,b.length),aa=a.slice(-L),bb=b.slice(-L),out=[];
  for(let i=0;i<L;i++){
    if(i<n||!aa[i]||!bb[i]||!aa[i-n]||!bb[i-n])out.push(null);
    else out.push((aa[i]/bb[i])/(aa[i-n]/bb[i-n])-1);
  }
  return out;
}

async function fetchText(url,timeoutMs=15000){
  const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const r=await fetch(url,{headers:{"User-Agent":UA,"Accept":"application/json,*/*;q=0.8"},signal:ctrl.signal});
    if(!r.ok)throw new Error("HTTP "+r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}
async function fetchJSON(url,timeoutMs=15000){
  const txt=await fetchText(url,timeoutMs);
  try{return JSON.parse(txt);}catch{throw new Error("Réponse non JSON");}
}
function parseYahoo(j){
  const r=j?.chart?.result?.[0];
  if(!r)throw new Error(j?.chart?.error?.description||"Réponse Yahoo invalide");
  const q=r.indicators?.quote?.[0]||{},adj=r.indicators?.adjclose?.[0]?.adjclose||q.close||[];
  const rows=(r.timestamp||[]).map((t,i)=>({
    t,
    close:adj[i]??q.close?.[i],
    high:q.high?.[i],
    low:q.low?.[i]
  })).filter(x=>Number.isFinite(x.close));
  if(rows.length<30)throw new Error("Historique insuffisant");
  return {symbol:r.meta?.symbol||"",currency:r.meta?.currency||"",rows,close:rows.map(x=>x.close)};
}
async function yahooOne(symbol,range="5y"){
  const url=YAHOO_BASE+encodeURIComponent(symbol)+"?range="+range+"&interval=1d&events=history&includeAdjustedClose=true";
  return parseYahoo(await fetchJSON(url,15000));
}
async function yahooFallback(symbols,range="2y"){
  let error;
  for(const symbol of symbols){
    try{return {...await yahooOne(symbol,range),usedSymbol:symbol};}
    catch(e){error=e;}
  }
  throw error||new Error("Aucun ticker valide");
}

function calcMomentum(c){
  const hist=[];
  for(let i=125;i<c.length;i++){
    const mm=sma(c,125,i),r20=ret(c,20,i),r60=ret(c,60,i);
    if(mm&&[r20,r60].every(Number.isFinite))hist.push({m:c[i]/mm-1,r20,r60});
  }
  const cur=last(hist);
  if(!cur)return null;
  return {
    score:mean([
      percentile(hist.map(x=>x.m),cur.m),
      percentile(hist.map(x=>x.r20),cur.r20),
      percentile(hist.map(x=>x.r60),cur.r60)
    ]),
    metrics:{ratio:c.at(-1)/sma(c,125),r20:cur.r20,r60:cur.r60}
  };
}
function calcVolatility(c){
  const v=rollingVol(c,20),cur=last(v),p=percentile(v.slice(-1260),cur);
  return Number.isFinite(p)?{score:100-p,metrics:{vol:cur,percentile:p}}:null;
}
function calcDrawdown(c){
  const d=rollingDrawdown(c,252),cur=last(d),p=percentile(d.slice(-1260),cur);
  return Number.isFinite(p)?{score:p,metrics:{drawdown:cur}}:null;
}
function calcRelative(a,b){
  const z=alignByDate(a,b),rr=rollingRatioReturn(z.a,z.b,60),cur=last(rr),p=percentile(rr.slice(-1260),cur);
  return Number.isFinite(p)?{score:p,metrics:{relative60:cur}}:null;
}
function dayKey(ts){
  return new Date(ts*1000).toISOString().slice(0,10);
}
function carryForwardByDate(rows,maxGapDays=4){
  const out=new Map();
  const sorted=rows.slice().sort((a,b)=>a.t-b.t);
  for(const r of sorted) out.set(dayKey(r.t),r.close);
  return {sorted,out,maxGapDays};
}
function previousAvailable(series,dateKey){
  const target=new Date(dateKey+"T00:00:00Z").getTime();
  for(let gap=0;gap<=series.maxGapDays;gap++){
    const d=new Date(target-gap*86400000).toISOString().slice(0,10);
    const v=series.out.get(d);
    if(Number.isFinite(v)) return v;
  }
  return null;
}
function calcRisk(cac,gold,fx){
  const goldByDate=carryForwardByDate(gold.rows,4);
  const fxByDate=carryForwardByDate(fx.rows,4);
  const a=[],b=[];
  for(const x of cac.rows){
    const d=dayKey(x.t);
    const g=previousAvailable(goldByDate,d);
    const f=previousAvailable(fxByDate,d);
    if(Number.isFinite(g)&&Number.isFinite(f)&&f>0){
      a.push(x.close);
      b.push(g/f);
    }
  }
  if(a.length<120)return null;
  const rr=rollingRatioReturn(a,b,60),cur=last(rr),p=percentile(rr.slice(-1260),cur);
  return Number.isFinite(p)?{score:p,metrics:{relative60:cur,alignedDays:a.length}}:null;
}
function calcBreadthStrength(items){
  const usable=items.filter(x=>x&&x.close?.length>=252);
  if(usable.length<20)return null;
  let above50=0,above200=0,pos20=0;
  const positions=[];
  for(const x of usable){
    const c=x.close,now=last(c),m50=sma(c,50),m200=sma(c,200),r20=ret(c,20);
    if(now>m50)above50++;
    if(now>m200)above200++;
    if(r20>0)pos20++;
    const w=c.slice(-252),lo=Math.min(...w),hi=Math.max(...w);
    if(hi>lo)positions.push(100*(now-lo)/(hi-lo));
  }
  const n=usable.length;
  return {
    breadth:{score:mean([100*above50/n,100*above200/n,100*pos20/n]),metrics:{usable:n,above50,above200,pos20}},
    strength:{score:mean(positions),metrics:{usable:n,avgPosition:mean(positions)}}
  };
}
async function gdeltScore(){
  const queries=[
    '("CAC 40" OR "Paris stock exchange" OR "French economy" OR "financial markets") sourcecountry:france sourcelang:french',
    '("CAC 40" OR "Paris stock exchange" OR "French economy") sourcecountry:france',
    '("CAC 40" OR "Paris stock exchange")'
  ];
  let lastError;
  for(const q of queries){
    const url="https://api.gdeltproject.org/api/v2/doc/doc?query="+encodeURIComponent(q)+"&mode=timelinetone&format=json&timespan=3months";
    for(let attempt=1;attempt<=2;attempt++){
      try{
        const j=await fetchJSON(url,12000),vals=[];
        const walk=o=>{
          if(Array.isArray(o)){o.forEach(walk);return;}
          if(o&&typeof o==="object"){
            if(Number.isFinite(o.value))vals.push(o.value);
            Object.entries(o).forEach(([k,v])=>{if(k!=="value")walk(v);});
          }
        };
        walk(j?.timeline??j);
        const clean=vals.filter(x=>Number.isFinite(x)&&x>-100&&x<100);
        if(clean.length>=10){
          const cur=last(clean);
          return {score:percentile(clean,cur),metrics:{tone:cur,points:clean.length,source:"GDELT"}};
        }
        throw new Error("Série GDELT insuffisante");
      }catch(e){ lastError=e; await sleep(1200*attempt); }
    }
  }
  throw lastError||new Error("GDELT indisponible");
}

function decodeXml(s){
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1")
    .replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .replace(/&lt;/g,"<").replace(/&gt;/g,">");
}

async function googleNewsSentiment(){
  const query='("CAC 40" OR "Bourse de Paris" OR "économie française" OR "marchés financiers")';
  const url="https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=fr&gl=FR&ceid=FR:fr";
  const xml=await fetchText(url,15000);
  const titles=[...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<\/item>/gi)]
    .map(m=>decodeXml(m[1]).replace(/<[^>]+>/g," ").toLowerCase())
    .filter(Boolean)
    .slice(0,100);
  if(titles.length<10) throw new Error("Google News : couverture insuffisante");

  const positive=["hausse","rebond","progression","gagne","gagné","croissance","record","optimisme","rassure","solide","amélioration","ameliore","surperformance","bénéfice","benefice","profite","accélère","accelere","dynamique","positif"];
  const negative=["baisse","chute","recul","perd","perte","crainte","inquiétude","inquietude","risque","tension","crise","ralentissement","dégradation","degradation","faible","pression","déficit","deficit","récession","recession","négatif","negatif"];

  let sum=0, matched=0;
  for(const title of titles){
    let raw=0;
    for(const w of positive) if(title.includes(w)) raw++;
    for(const w of negative) if(title.includes(w)) raw--;
    if(raw!==0) matched++;
    sum += Math.tanh(raw/2);
  }
  const avg=sum/titles.length;
  const score=Math.max(0,Math.min(100,50+avg*50));
  return {score,metrics:{source:"Google News RSS",articles:titles.length,matched,averageTone:avg}};
}

async function mediaSentiment(){
  try{return await gdeltScore();}
  catch(gdeltError){
    console.error("GDELT",gdeltError.message,"— repli Google News RSS");
    return await googleNewsSentiment();
  }
}

function readJSON(file,fallback){
  try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return fallback;}
}
function writeJSON(file,obj){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(obj,null,2)+"\n","utf8");
}
function aggregate(scores){
  let num=0,den=0;
  for(const c of COMPONENTS){
    if(Number.isFinite(scores[c.key]?.score)){
      num+=scores[c.key].score*c.weight;
      den+=c.weight;
    }
  }
  return {coverage:den,score:den>=MIN_COVERAGE?num/den:null};
}

async function main(){
  console.log("Fear & Greed France V3");
  console.log("Run source: GitHub Actions");
  const diagnostics={},refs={};

  for(const [key,symbol,name] of [
    ["cac","^FCHI","CAC 40"],
    ["euro","^STOXX50E","EURO STOXX 50"],
    ["gold","GC=F","Or"],
    ["fx","EURUSD=X","EUR/USD"]
  ]){
    try{
      refs[key]=await yahooOne(symbol,"5y");
      console.log("OK",name);
    }catch(e){
      diagnostics[key]={status:"error",message:e.message};
      console.error("ERR",name,e.message);
    }
    await sleep(300);
  }

  const scores={};
  if(refs.cac){
    const m=calcMomentum(refs.cac.close); if(m)scores.momentum=m;
    const v=calcVolatility(refs.cac.close); if(v)scores.volatility=v;
    const d=calcDrawdown(refs.cac.close); if(d)scores.drawdown=d;
  }
  if(refs.cac&&refs.euro){
    const x=calcRelative(refs.cac,refs.euro); if(x)scores.relative=x;
  }
  if(refs.cac&&refs.gold&&refs.fx){
    const x=calcRisk(refs.cac,refs.gold,refs.fx); if(x)scores.risk=x;
  }

  const constituents=[],failures=[];
  for(let i=0;i<CAC40.length;i++){
    const [name,symbols]=CAC40[i];
    try{
      const d=await yahooFallback(symbols,"2y");
      constituents.push({...d,name});
      console.log("OK composant "+(i+1)+"/40 "+name+" "+d.usedSymbol);
    }catch(e){
      failures.push({name,error:e.message});
      console.error("ERR composant "+(i+1)+"/40 "+name+": "+e.message);
    }
    await sleep(350);
  }

  const bs=calcBreadthStrength(constituents);
  if(bs){
    scores.breadth=bs.breadth;
    scores.strength=bs.strength;
  }

  try{
    scores.news=await gdeltScore();
    diagnostics.gdelt={status:"ok"};
  }catch(e){
    diagnostics.gdelt={status:"error",message:e.message};
    console.error("GDELT",e.message);
  }

  const agg=aggregate(scores);
  const now=new Date().toISOString();
  const marketTs=refs.cac?.rows?.at(-1)?.t??null;
  const marketDate=marketTs?isoParisDate(marketTs):null;

  const out={
    name:"Fear & Greed France",
    version:"3.0",
    generated_at:now,
    market_date:marketDate,
    score:Number.isFinite(agg.score)?Math.round(agg.score*10)/10:null,
    label:Number.isFinite(agg.score)?labelFor(agg.score):"Indisponible",
    coverage_pct:agg.coverage,
    minimum_coverage_pct:MIN_COVERAGE,
    methodology:"Percentiles historiques et breadth CAC 40 ; poids disponibles renormalisés.",
    components:Object.fromEntries(COMPONENTS.map(c=>[
      c.key,
      {
        name:c.name,
        weight:c.weight,
        score:Number.isFinite(scores[c.key]?.score)?Math.round(scores[c.key].score*10)/10:null,
        metrics:scores[c.key]?.metrics||null
      }
    ])),
    constituents:{
      expected:40,
      usable:constituents.length,
      failed:failures.length,
      failures
    },
    sources:{
      yahoo:"Endpoint Chart non officiel ; disponibilité non garantie.",
      gdelt:diagnostics.gdelt?.status||"unknown"
    }
  };
  writeJSON(OUT_FILE,out);

  const market={
    generated_at:now,
    market_date:marketDate,
    assets:Object.fromEntries(Object.entries(refs).map(([k,v])=>[
      k,
      {
        symbol:v.symbol,
        currency:v.currency,
        close:v.close.at(-1),
        previous_close:v.close.length>1?v.close.at(-2):null,
        change_1d:v.close.length>1?v.close.at(-1)/v.close.at(-2)-1:null
      }
    ]))
  };
  writeJSON(MARKET_FILE,market);

  const hist=readJSON(HISTORY_FILE,[]);
  if(Number.isFinite(out.score)&&marketDate){
    const row={
      date:marketDate,
      score:out.score,
      label:out.label,
      coverage_pct:out.coverage_pct,
      components:Object.fromEntries(Object.entries(out.components).map(([k,v])=>[k,v.score]))
    };
    const idx=hist.findIndex(x=>x.date===marketDate);
    if(idx>=0)hist[idx]=row; else hist.push(row);
    hist.sort((a,b)=>a.date.localeCompare(b.date));
  }
  writeJSON(HISTORY_FILE,hist.slice(-2000));

  console.log(JSON.stringify({
    score:out.score,
    label:out.label,
    coverage:out.coverage_pct,
    market_date:marketDate,
    usable:constituents.length
  },null,2));

  if(agg.coverage<MIN_COVERAGE)process.exitCode=2;
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
