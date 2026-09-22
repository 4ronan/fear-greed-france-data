#!/usr/bin/env node
"use strict";

const fs=require("fs");
const path=require("path");
const DATA=path.resolve(__dirname,"../data");
const HISTORY_FILE=path.join(DATA,"history.json");
const YAHOO_BASE="https://query1.finance.yahoo.com/v8/finance/chart/";
const START_DATE="2026-01-01";
const UA="Mozilla/5.0 FearGreedFranceBackfill/1.0";

const CAC40=[
["Accor",["AC.PA"]],["Air Liquide",["AI.PA"]],["Airbus",["AIR.PA"]],["ArcelorMittal",["MT.AS","MT.PA"]],
["AXA",["CS.PA"]],["BNP Paribas",["BNP.PA"]],["Bouygues",["EN.PA"]],["Bureau Veritas",["BVI.PA"]],
["Capgemini",["CAP.PA"]],["Carrefour",["CA.PA"]],["Crédit Agricole",["ACA.PA"]],["Danone",["BN.PA"]],
["Dassault Systèmes",["DSY.PA"]],["Eiffage",["FGR.PA"]],["Engie",["ENGI.PA"]],["EssilorLuxottica",["EL.PA"]],
["Eurofins Scientific",["ERF.PA"]],["Euronext",["ENX.PA"]],["Hermès",["RMS.PA"]],["Kering",["KER.PA"]],
["L'Oréal",["OR.PA"]],["Legrand",["LR.PA"]],["LVMH",["MC.PA"]],["Michelin",["ML.PA"]],["Orange",["ORA.PA"]],
["Pernod Ricard",["RI.PA"]],["Publicis Groupe",["PUB.PA"]],["Renault",["RNO.PA"]],["Safran",["SAF.PA"]],
["Saint-Gobain",["SGO.PA"]],["Sanofi",["SAN.PA"]],["Schneider Electric",["SU.PA"]],["Société Générale",["GLE.PA"]],
["Stellantis",["STLAP.PA","STLAM.MI"]],["STMicroelectronics",["STMPA.PA","STM.PA"]],["Thales",["HO.PA"]],
["TotalEnergies",["TTE.PA"]],["Unibail-Rodamco-Westfield",["URW.PA"]],["Veolia",["VIE.PA"]],["Vinci",["DG.PA"]]
];

const W={momentum:15,breadth:20,strength:10,volatility:15,drawdown:10,relative:10,risk:10,news:10};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const last=a=>a[a.length-1];
function dateKey(ts){return new Date(ts*1000).toISOString().slice(0,10)}
function sma(a,n,i){if(i-n+1<0)return null;let s=0;for(let j=i-n+1;j<=i;j++){if(!Number.isFinite(a[j]))return null;s+=a[j]}return s/n}
function ret(a,n,i){return i>=n&&a[i-n]?a[i]/a[i-n]-1:null}
function stdev(a){if(a.length<2)return null;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1))}
function pct(arr,val){const x=arr.filter(Number.isFinite);if(!x.length||!Number.isFinite(val))return null;let b=0,e=0;for(const n of x){if(n<val)b++;else if(n===val)e++}return 100*(b+.5*e)/x.length}
function label(s){if(s<25)return"Peur extrême";if(s<45)return"Peur";if(s<=55)return"Neutre";if(s<=75)return"Avidité";return"Avidité extrême"}

async function fetchJSON(url,timeout=18000){
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),timeout);
 try{const r=await fetch(url,{headers:{"User-Agent":UA},signal:ctrl.signal});if(!r.ok)throw new Error("HTTP "+r.status);return await r.json()}
 finally{clearTimeout(timer)}
}
function parseYahoo(j){
 const r=j?.chart?.result?.[0];if(!r)throw new Error("Yahoo invalide");
 const q=r.indicators?.quote?.[0]||{},adj=r.indicators?.adjclose?.[0]?.adjclose||q.close||[];
 const rows=(r.timestamp||[]).map((t,i)=>({t,date:dateKey(t),close:adj[i]??q.close?.[i]})).filter(x=>Number.isFinite(x.close));
 if(rows.length<220)throw new Error("Historique insuffisant");
 return {rows,close:rows.map(x=>x.close)};
}
async function yahoo(symbol,range="5y"){
 const u=YAHOO_BASE+encodeURIComponent(symbol)+"?range="+range+"&interval=1d&events=history&includeAdjustedClose=true";
 return parseYahoo(await fetchJSON(u));
}
async function fallback(symbols,range="2y"){let e;for(const s of symbols){try{return await yahoo(s,range)}catch(x){e=x}}throw e}

function volAt(c,i){
 if(i<20)return null;
 const lr=[];for(let j=i-19;j<=i;j++)lr.push(Math.log(c[j]/c[j-1]));
 const cur=stdev(lr)*Math.sqrt(252),hist=[];
 for(let k=20;k<=i;k++){const z=[];for(let j=k-19;j<=k;j++)z.push(Math.log(c[j]/c[j-1]));hist.push(stdev(z)*Math.sqrt(252))}
 const p=pct(hist.slice(-1260),cur);return Number.isFinite(p)?100-p:null;
}
function drawdownAt(c,i){
 if(i<251)return null;const vals=[];
 for(let k=251;k<=i;k++){const w=c.slice(k-251,k+1),mx=Math.max(...w);vals.push(c[k]/mx-1)}
 return pct(vals.slice(-1260),last(vals));
}
function momentumAt(c,i){
 if(i<125)return null;
 const rows=[];
 for(let k=125;k<=i;k++){const mm=sma(c,125,k),r20=ret(c,20,k),r60=ret(c,60,k);if(mm&&Number.isFinite(r20)&&Number.isFinite(r60))rows.push({m:c[k]/mm-1,r20,r60})}
 const cur=last(rows);if(!cur)return null;
 return mean([pct(rows.map(x=>x.m),cur.m),pct(rows.map(x=>x.r20),cur.r20),pct(rows.map(x=>x.r60),cur.r60)]);
}
function previousRow(rows,target,maxDays=4){
 const t=new Date(target+"T00:00:00Z").getTime();
 for(let gap=0;gap<=maxDays;gap++){const d=new Date(t-gap*86400000).toISOString().slice(0,10);for(let i=rows.length-1;i>=0;i--)if(rows[i].date===d)return {row:rows[i],index:i}}
 return null;
}
function ratioScore(cacRows,otherRows,target,n=60,invert=false){
 const a=[],b=[];
 for(const x of cacRows){
   if(x.date>target)break;
   const y=previousRow(otherRows,x.date,4);if(y){a.push(x.close);b.push(y.row.close)}
 }
 if(a.length<n+30)return null;
 const rr=[];
 for(let i=n;i<a.length;i++)rr.push((a[i]/b[i])/(a[i-n]/b[i-n])-1);
 const p=pct(rr.slice(-1260),last(rr));return invert&&Number.isFinite(p)?100-p:p;
}
function riskScore(cacRows,goldRows,fxRows,target){
 const a=[],b=[];
 for(const x of cacRows){
   if(x.date>target)break;
   const g=previousRow(goldRows,x.date,4),f=previousRow(fxRows,x.date,4);
   if(g&&f&&f.row.close>0){a.push(x.close);b.push(g.row.close/f.row.close)}
 }
 if(a.length<120)return null;
 const rr=[];for(let i=60;i<a.length;i++)rr.push((a[i]/b[i])/(a[i-60]/b[i-60])-1);
 return pct(rr.slice(-1260),last(rr));
}
function breadthStrength(items,target){
 let usable=0,a50=0,a200=0,p20=0;const pos=[];
 for(const item of items){
   const hit=previousRow(item.rows,target,4);if(!hit||hit.index<251)continue;
   const i=hit.index,c=item.close,now=c[i],m50=sma(c,50,i),m200=sma(c,200,i),r20=ret(c,20,i);
   usable++;if(now>m50)a50++;if(now>m200)a200++;if(r20>0)p20++;
   const w=c.slice(i-251,i+1),lo=Math.min(...w),hi=Math.max(...w);if(hi>lo)pos.push(100*(now-lo)/(hi-lo));
 }
 if(usable<20)return {breadth:null,strength:null};
 return {breadth:mean([100*a50/usable,100*a200/usable,100*p20/usable]),strength:mean(pos)};
}
function aggregate(c){
 let num=0,den=0;for(const [k,w] of Object.entries(W)){if(Number.isFinite(c[k])){num+=c[k]*w;den+=w}}
 return {coverage:den,score:den>=70?num/den:null};
}
function round(x){return Number.isFinite(x)?Math.round(x*10)/10:null}

async function main(){
 const existing=(()=>{try{return JSON.parse(fs.readFileSync(HISTORY_FILE,"utf8"))}catch{return[]}})();
 if(existing.filter(x=>x.date>=START_DATE).length>100){console.log("Backfill déjà présent :",existing.length,"points");return}

 console.log("Backfill 2026 : téléchargement des historiques");
 const cac=await yahoo("^FCHI","5y");await sleep(250);
 const euro=await yahoo("^STOXX50E","5y");await sleep(250);
 const gold=await yahoo("GC=F","5y");await sleep(250);
 const fx=await yahoo("EURUSD=X","5y");await sleep(250);

 const constituents=[];
 for(let i=0;i<CAC40.length;i++){
   const [name,symbols]=CAC40[i];
   try{const d=await fallback(symbols,"2y");constituents.push(d);console.log("OK",i+1,"/40",name)}
   catch(e){console.error("ERR",name,e.message)}
   await sleep(300);
 }
 const out=[];
 for(let i=0;i<cac.rows.length;i++){
   const date=cac.rows[i].date;if(date<START_DATE)continue;
   const bs=breadthStrength(constituents,date);
   const comp={
     momentum:momentumAt(cac.close,i),
     breadth:bs.breadth,
     strength:bs.strength,
     volatility:volAt(cac.close,i),
     drawdown:drawdownAt(cac.close,i),
     relative:ratioScore(cac.rows,euro.rows,date,60,false),
     risk:riskScore(cac.rows,gold.rows,fx.rows,date),
     news:null
   };
   const agg=aggregate(comp);
   if(Number.isFinite(agg.score))out.push({
     date,score:round(agg.score),label:label(agg.score),coverage_pct:agg.coverage,
     components:Object.fromEntries(Object.entries(comp).map(([k,v])=>[k,round(v)]))
   });
 }
 const current=existing.filter(x=>x.date<START_DATE);
 const merged=[...current,...out];
 fs.writeFileSync(HISTORY_FILE,JSON.stringify(merged,null,2)+"\n");
 console.log("Backfill terminé :",out.length,"séances");
}
main().catch(e=>{console.error(e);process.exit(1)});
