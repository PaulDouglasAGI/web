/* behaviors.js — the full library of possible actions.
   Each behavior: { id, label, glyph, cat, weight(a), make(a) -> task }
   A task: { label, glyph, cat, target:{x,y}|null, stay, dur, arrive, onArrive(a), onTick(a) } */
'use strict';

function rnd(){ return Math.random(); }
function pick(arr){ return arr[(Math.random()*arr.length)|0]; }
function dist2(ax,ay,bx,by){ const dx=ax-bx,dy=ay-by; return dx*dx+dy*dy; }

// ── task constructors ────────────────────────────────────────────────────────
function gotoNode(a,label,glyph,cat,node,collect,pose){
  if(!node) return null;
  return { label,glyph,cat, pose:pose||'work', target:{x:node.x,y:node.y}, node, arrive:14, dur:60,
    onArrive(ag){
      if(node.amount>0.2){
        node.amount-=0.34;
        if(collect) ag.inv[collect]=(ag.inv[collect]||0)+1;
        ag.hunger=Math.max(0,ag.hunger-2);
        ag.remember('gathered '+(collect||cat));
      }
    } };
}
function gotoPoint(a,label,glyph,cat,x,y,dur,pose){
  return { label,glyph,cat, pose, target:{x,y}, arrive:12, dur:dur||40, onArrive(){} };
}
function stayPut(a,label,glyph,cat,dur,onTick,pose){
  return { label,glyph,cat, pose, target:null, stay:true, dur:dur||120, onTick };
}
function gotoAgent(a,label,glyph,cat,other,onArrive,dur,pose){
  if(!other) return null;
  return { label,glyph,cat, pose, targetAgent:other, target:{x:other.x,y:other.y}, arrive:16, dur:dur||90, onArrive };
}

// random reachable point near agent
function wanderPoint(a,radius){
  for(let i=0;i<8;i++){
    const ang=Math.random()*Math.PI*2, r=radius*(0.4+Math.random()*0.6);
    const x=a.x+Math.cos(ang)*r, y=a.y+Math.sin(ang)*r;
    if(World.walkable(x,y) && x>10 && y>10 && x<World.w-10 && y<World.h-10 && World.reachable(a.x,a.y,x,y)) return {x,y};
  }
  return {x:a.x,y:a.y};
}
// pick the best site for an agent to haul materials to: prefers sites the agent
// can actually help (carrying a resource that site still needs) and, among those,
// the site closest to completion — otherwise wood/stone keeps getting routed to
// whichever freshly-opened site is nearest, starving an almost-finished one forever
function deliverySiteFor(a){
  let best=null,bestScore=-Infinity;
  for(const s of World.sites){
    if(s.level>=s.maxLevel) continue;
    const needW=s.needWood-s.matsWood, needS=s.needStone-s.matsStone;
    if(needW<=0 && needS<=0) continue;
    const canHelp=(a.inv.wood>0&&needW>0)||(a.inv.stone>0&&needS>0);
    if(!canHelp) continue;
    const d=Math.sqrt(dist2(a.x,a.y,s.x,s.y));
    const completion=(s.matsWood+s.matsStone)/(s.needWood+s.needStone);
    // structurally-gating types unlock whole tiers and every later building behind
    // them — a flat bonus (not a multiplier on completion, which is 0 for any site
    // that hasn't received materials yet) so they outweigh the many cheaper hut/farm
    // sites that would otherwise always look like the better score
    const priorityBonus=(s.type==='well'||s.type==='granary'||s.type==='masonry'||s.type==='quarry')?500:0;
    const score=completion*600+priorityBonus-d;
    if(score>bestScore){ bestScore=score; best=s; }
  }
  return best;
}
// find the nearest built, not-yet-upgraded site that sits on a gather with a
// built masonry — masonry itself is never a target, and a site only needs to
// cross stoneNeeded once (the cost is cached on the site so it doesn't drift
// if level changes later).
function stoneUpgradeTargetFor(a){
  let best=null,bd=Infinity;
  for(const s of World.sites){
    if(!s.built || s.stoneUpgraded || s.type==='masonry') continue;
    const need=s.stoneNeeded||(s.stoneNeeded=Math.ceil(8+4*s.level));
    if(s.matsStoneUpgrade>=need) continue;
    const hasMasonryNearby=World.sites.some(m=>m.type==='masonry'&&m.built&&m.gather===s.gather);
    if(!hasMasonryNearby) continue;
    const d=dist2(a.x,a.y,s.x,s.y);
    if(d<bd){ bd=d; best=s; }
  }
  return best;
}
// a settlement's townHall count, looked up by an agent's nearest gathering spot —
// used to soften crime weights ("the Collective governs itself" effect)
function nearestGovern(a){
  const g=World.nearestOf(World.gathers,a.x,a.y);
  return g ? (g.govern||0) : 0;
}
// how strongly an agent's settlement holds a given cultural ideal (0.5 default)
// — this is emergent LAW: a people who believe in order police crime more, a
// people who believe in communion redistribute, etc.
function settlementCulture(a,key){
  const g=World.nearestOf(World.gathers,a.x,a.y);
  return (g&&g.culture)?(g.culture[key]!=null?g.culture[key]:0.5):0.5;
}

// point toward unexplored edge (exploration)
function frontierPoint(a){
  const cx=World.w/2, cy=World.h/2;
  const ang=Math.atan2(a.y-cy,a.x-cx)+(Math.random()-0.5)*1.2;
  const r=200+Math.random()*340;
  let x=a.x+Math.cos(ang)*r, y=a.y+Math.sin(ang)*r;
  x=Math.max(20,Math.min(World.w-20,x)); y=Math.max(20,Math.min(World.h-20,y));
  if(!World.walkable(x,y) || !World.reachable(a.x,a.y,x,y)){ return wanderPoint(a,260); }
  return {x,y};
}

// ── functional structure jobs ──────────────────────────────────────────────
const MIN_TENURE_TICKS=World.seasonLen*World.dayLen;
const JOB_SITE_TYPES=['granary','workshop','market','shrineHall','loreHall','huntingLodge','smithy','barracks','harbor','temple','tavern','quarry'];
function jobSlots(s){ return s.type==='granary' ? 2 : (s.capacity||1); }
function openFunctionalSite(a){
  return World.nearestSite(a.x,a.y, s=> JOB_SITE_TYPES.includes(s.type) && s.built && (s.workers||[]).length<jobSlots(s));
}

// ── settlement store deposits ───────────────────────────────────────────────
// How much of each resource an agent keeps for itself before contributing the
// rest to the settlement store. Everything above the reserve is genuine surplus
// that would otherwise sit uselessly in a pocket; deposited, it feeds the
// production chains (workshop/tavern/granary/shrine) and the caravan trade.
// (beauty/tools/weapons are excluded — beauty feeds monuments, the others are
// personal kit.)
const DEPOSIT_RESERVE={food:2, wood:1, stone:1, ore:0, herb:1, fish:1};
function depositSurplusAmount(a){
  let total=0;
  for(const k in DEPOSIT_RESERVE){ const s=(a.inv[k]||0)-DEPOSIT_RESERVE[k]; if(s>0) total+=s; }
  return total;
}
// a built store (granary or market) an agent's settlement can deposit into
function nearestStoreGather(a){
  const g=World.nearestOf(World.gathers,a.x,a.y);
  if(!g||!g.stock) return null;
  const gi=World.gathers.indexOf(g);
  const hasStore=World.sites.some(s=>(s.type==='granary'||s.type==='market')&&s.built&&s.gather===gi);
  return hasStore?g:null;
}
function doDeposit(ag,g){
  if(!g||!g.stock) return;
  let moved=0;
  for(const k in DEPOSIT_RESERVE){
    const s=(ag.inv[k]||0)-DEPOSIT_RESERVE[k];
    if(s>0){ ag.inv[k]-=s; g.stock[k]=(g.stock[k]||0)+s; moved+=s; }
  }
  if(moved>0){
    // a small stipend for contributing — kept modest so hoarding for trade
    // still pays better (faction 'deposit' doctrine multiplies this in S6)
    ag.wealth=(ag.wealth||0)+Math.min(2,moved*0.5);
    // the settlement banks part of the surplus's value as coin — this is a
    // primary source of the treasury that funds wages (Cultivators give more)
    g.treasury=(g.treasury||0)+Math.ceil(moved*0.4*factionEcon(ag.faction,'deposit'));
    ag.remember('added to the settlement stores');
  }
}

// ── caravans (S3) ───────────────────────────────────────────────────────────
function hasBuiltHarbor(gi){ return World.sites.some(s=>s.type==='harbor'&&s.built&&s.gather===gi); }
function hasBuiltMarket(gi){ return World.sites.some(s=>s.type==='market'&&s.built&&s.gather===gi); }
function hasStaffedMarket(gi){ return World.sites.some(s=>s.type==='market'&&s.built&&(s.workers||[]).length>0&&s.gather===gi); }
// the nearest other settlement with a built market — a caravan's destination
function caravanDestination(fromGi){
  const from=World.gathers[fromGi]; let best=-1,bd=Infinity;
  for(let gi=0;gi<World.gathers.length;gi++){
    if(gi===fromGi || !hasBuiltMarket(gi)) continue;
    const g=World.gathers[gi], d=(g.x-from.x)**2+(g.y-from.y)**2;
    if(d<bd){ bd=d; best=gi; }
  }
  return best;
}
// load a caravan by comparative advantage — take what `from` holds in surplus
// that `to` most lacks — and hand the agent over to its self-contained trip
// loop (Agent.updateCaravan). Sea routes (harbor->harbor) carry double.
function beginCaravan(ag, fromGi, toGi){
  const from=World.gathers[fromGi], to=World.gathers[toGi];
  if(!from||!to||!from.stock||!to.stock) return false;
  const mode=(hasBuiltHarbor(fromGi)&&hasBuiltHarbor(toGi))?'sea':'land';
  const cap=Math.round((mode==='sea'?8:4)*factionEcon(ag.faction,'cargo')); // Wayfarers haul more
  const keys=Object.keys(from.stock).sort((k1,k2)=>
    ((from.stock[k2]||0)-(to.stock[k2]||0)) - ((from.stock[k1]||0)-(to.stock[k1]||0)));
  const cargo={}; let loaded=0;
  for(const k of keys){
    if(loaded>=cap) break;
    const avail=Math.floor(from.stock[k]||0);
    if(avail<=0) continue;
    const take=Math.min(avail, cap-loaded);
    from.stock[k]-=take; cargo[k]=(cargo[k]||0)+take; loaded+=take;
  }
  if(loaded<=0) return false;
  ag.caravan={from:fromGi, to:toGi, cargo, stage:'toB', mode};
  ag.task=null;
  ag.remember('set out with a caravan for a distant market');
  return true;
}
// a theft mark: a nearby agent worth robbing — carrying loose goods, or (much
// more temptingly) a laden caravan on the road
function theftTarget(a){
  return nearestAgent(a, o=> o!==a && !o.dead && !o.wanted && (invTotal(o.inv)>1 || o.caravan) && dist2(a.x,a.y,o.x,o.y)<600*600);
}
// a site has every material it needs to be raised — wood/stone always, plus
// beauty for the beauty structures (monument/wonder, S5)
function siteMatsReady(s){
  if(s.matsWood<s.needWood || s.matsStone<s.needStone) return false;
  if((s.type==='monument'||s.type==='wonder') && (s.matsBeauty||0)<(s.needBeauty||0)) return false;
  return true;
}

const Behaviors=[
  // ── SURVIVAL & WORK ────────────────────────────────────────────────────────
  { id:'eat', label:'eating', glyph:'❦', cat:'survival',
    weight:a=> a.inv.food>0 ? a.hunger*0.9 : 0,
    make:a=> stayPut(a,'eating','❦','survival',70,ag=>{ if(ag.task._t===1 && ag.inv.food>0){ ag.inv.food-=1; ag.hunger=Math.max(0,ag.hunger-55); ag.joy=Math.min(1,ag.joy+0.1);} },'sit') },
  { id:'drink', label:'drinking', glyph:'≈', cat:'survival',
    weight:a=> a.inv.water>0 ? (100-a.energy)*0.4 : 0,
    make:a=> stayPut(a,'drinking','≈','survival',50,ag=>{ if(ag.task._t===1 && ag.inv.water>0){ ag.inv.water-=1; ag.energy=Math.min(100,ag.energy+30);} },'sit') },
  // consumes a dose from the settlement store (brewed at a shrine hall / temple
  // from herbs — see doJob). A failing agent walks to the stores for a remedy
  // that restores energy and staves off an old-age death for a day (a.medicated,
  // checked in Agent.update's mortality line). This is what closes the herb chain.
  { id:'takeMedicine', label:'seeking a remedy', glyph:'✚', cat:'survival',
    weight:a=> { if(a.hunger<75 && a.energy>18) return 0;
      const g=World.nearestOf(World.gathers,a.x,a.y);
      return (g && g.stock && (g.stock.medicine||0)>=1) ? 34 : 0; },
    make:a=> { const g=World.nearestOf(World.gathers,a.x,a.y); if(!g||!g.stock||(g.stock.medicine||0)<1) return null;
      return { label:'seeking a remedy', glyph:'✚', cat:'survival', pose:'sit', target:{x:g.x,y:g.y}, arrive:16, dur:60,
        onArrive(ag){
          if((g.stock.medicine||0)>=1){ g.stock.medicine-=1; ag.energy=Math.min(100,ag.energy+40); ag.hunger=Math.max(0,ag.hunger-20); ag.medicated=World.dayLen; ag.remember('was mended by a remedy'); }
        } }; } },
  { id:'gatherFood', label:'foraging', glyph:'✿', cat:'survival',
    weight:a=> a.hunger>30 || a.inv.food<1 ? 24+a.hunger*0.6 : 8,
    make:a=> gotoNode(a,'foraging','✿','survival',World.nearestNode(a.x,a.y,'food'),'food') },
  { id:'fetchWater', label:'fetching water', glyph:'≈', cat:'survival',
    weight:a=> a.inv.water<1 ? 18+(100-a.energy)*0.2 : 4,
    make:a=> gotoNode(a,'fetching water','≈','survival',World.nearestNode(a.x,a.y,'water'),'water') },
  { id:'fish', label:'fishing', glyph:'𝄃', cat:'survival',
    weight:a=> a.inv.food<2 ? 12 : 3,
    make:a=> gotoNode(a,'fishing','𝄃','survival',World.nearestNode(a.x,a.y,'fish'),'food') },
  { id:'chopWood', label:'chopping wood', glyph:'╪', cat:'survival',
    weight:a=> 10+(a.faction===0?6:0),
    make:a=> gotoNode(a,'chopping wood','╪','survival',World.nearestNode(a.x,a.y,'wood'),'wood') },
  { id:'mineStone', label:'mining stone', glyph:'◈', cat:'survival',
    weight:a=> 8+(a.faction===2?6:0),
    make:a=> gotoNode(a,'mining stone','◈','survival',World.nearestNode(a.x,a.y,'stone'),'stone') },
  // a real trip down into Underground's separate cave map, not an ambient effect —
  // the agent vanishes from the surface for the duration (see Agent.updateUnderground)
  { id:'mineOre', label:'descending to the mine', glyph:'⛏', cat:'survival',
    weight:a=> { if(a.underground) return 0; const mine=World.nearestSite(a.x,a.y,s=>s.type==='mine'&&s.built); return mine ? 12+(a.faction===2?8:0) : 0; },
    make:a=> { const mine=World.nearestSite(a.x,a.y,s=>s.type==='mine'&&s.built); if(!mine) return null;
      return { label:'descending to the mine',glyph:'⛏',cat:'survival', pose:'work', target:{x:mine.x,y:mine.y}, arrive:14, dur:99999,
        onArrive(ag){ Underground.descend(ag,mine); } }; } },
  { id:'herbs', label:'collecting herbs', glyph:'❧', cat:'survival',
    weight:a=> 7+(a.faction===3?5:0),
    make:a=> gotoNode(a,'collecting herbs','❧','survival',World.nearestNode(a.x,a.y,'herb'),'herb') },
  { id:'preserve', label:'preserving food', glyph:'⊞', cat:'survival',
    weight:a=> (World.season>=2 && a.inv.food>2) ? 26 : 0,
    make:a=> stayPut(a,'preserving food','⊞','survival',120,null,'work') },
  { id:'shelter', label:'mending shelter', glyph:'⌂', cat:'survival',
    weight:a=> (World.isNight()||World.season===3) && a.inv.wood>0 ? 14 : 5,
    make:a=> stayPut(a,'mending shelter','⌂','survival',140) },
  { id:'hunt', label:'hunting', glyph:'➳', cat:'survival',
    weight:a=> { if(!World.animals.some(an=>an.alive)) return 0; return a.inv.food<2 ? 16 : 3; },
    make:a=> {
      const an=World.nearestOf(World.animals.filter(x=>x.alive), a.x, a.y);
      if(!an) return null;
      return { label:'hunting',glyph:'➳',cat:'hunt_chase', pose:'work', target:an, animal:an, arrive:16, dur:300,
        onTick(ag){
          if(!an.alive){ ag.task=null; return; }
          const d=Math.hypot(an.x-ag.x,an.y-ag.y);
          const killChance=ag.inv.tools>0?0.07:0.02; // a carried tool doubles as a hunting weapon
          if(d<26 && Math.random()<killChance){
            an.alive=false; an.respawnAt=900+((Math.random()*600)|0);
            ag.inv.food+=2; ag.hunger=Math.max(0,ag.hunger-30); ag.remember('made a catch'); ag.task=null;
          }
        } };
    } },
  { id:'plantSeeds', label:'planting seeds', glyph:'⊥', cat:'survival',
    weight:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='empty'); return f ? 20+(a.faction===0?10:0) : 0; },
    make:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='empty'); if(!f) return null;
      return { label:'planting seeds',glyph:'⊥',cat:'survival', pose:'kneel', target:{x:f.x,y:f.y}, arrive:12, dur:90,
        onArrive(ag){ f.stage='planted'; f.stageT=0; ag.remember('planted a farm'); } }; } },
  { id:'harvestFarm', label:'harvesting', glyph:'⊞', cat:'survival',
    weight:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='ready'); return f ? 28+(a.faction===0?12:0) : 0; },
    make:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='ready'); if(!f) return null;
      return { label:'harvesting',glyph:'⊞',cat:'survival', pose:'kneel', target:{x:f.x,y:f.y}, arrive:12, dur:80,
        onArrive(ag){ ag.inv.food+=Math.round((f.yieldAmt||4)*factionEcon(ag.faction,'harvest')); f.stage='empty'; f.stageT=0; ag.hunger=Math.max(0,ag.hunger-10); ag.remember('harvested a farm'); } }; } },

  // ── TRADE & ECONOMY ────────────────────────────────────────────────────────
  { id:'barter', label:'bartering', glyph:'⇄', cat:'trade',
    weight:a=> { const need=neededResource(a); return need? 16+(a.faction===1?10:0) : 6; },
    make:a=> gotoAgent(a,'bartering','⇄','trade', nearestAgent(a, o=> o!==a && dist2(a.x,a.y,o.x,o.y)<360*360), ag=>{
        const other=ag.task.targetAgent; if(!other) return;
        if(Economy.barter(ag,other)){ ag.emitExchange(other); raiseResonance(0.004); other.joy=Math.min(1,other.joy+0.05); }
      }) },
  { id:'toMarket', label:'to the market', glyph:'⊹', cat:'trade',
    weight:a=> invTotal(a.inv)>4 ? 10 : 2,
    make:a=> { const g=World.nearestOf(World.gathers,a.x,a.y); return g? gotoPoint(a,'to the market','⊹','trade',g.x,g.y,60):null; } },
  { id:'seekResource', label:'seeking a resource', glyph:'?', cat:'trade',
    weight:a=> { const need=neededResource(a); return need?14:0; },
    make:a=> { const need=neededResource(a); const nd=need?World.nearestNode(a.x,a.y,need==='wood'||need==='stone'||need==='food'||need==='water'?need:'food'):null; return nd?gotoNode(a,'seeking '+need,'?','trade',nd,need):null; } },
  { id:'depositSurplus', label:'stocking the stores', glyph:'⇩', cat:'trade',
    weight:a=> { const g=nearestStoreGather(a); return (g && depositSurplusAmount(a)>=2) ? 13 : 0; },
    make:a=> { const g=nearestStoreGather(a); if(!g) return null;
      return { label:'stocking the stores', glyph:'⇩', cat:'trade', pose:'work', target:{x:g.x,y:g.y}, arrive:16, dur:36,
        onArrive(ag){ doDeposit(ag,g); } }; } },
  // the headline of the trade economy: a laden caravan carries a settlement's
  // surplus to another market and comes home richer, weaving the isolated
  // settlements into a network. Wayfarers are born to it.
  { id:'runCaravan', label:'setting out with a caravan', glyph:'⇶', cat:'trade',
    weight:a=> { if(a.caravan||a.job) return 0;
      const g=World.nearestOf(World.gathers,a.x,a.y); if(!g||!g.stock) return 0;
      const gi=World.gathers.indexOf(g);
      if(!hasStaffedMarket(gi) || (g.stock.goods||0)<3 || caravanDestination(gi)<0) return 0;
      return 14+(a.faction===1?16:0); },
    make:a=> { const g=World.nearestOf(World.gathers,a.x,a.y); if(!g) return null;
      const gi=World.gathers.indexOf(g), toGi=caravanDestination(gi);
      if(toGi<0) return null;
      return { label:'setting out with a caravan', glyph:'⇶', cat:'trade', pose:'work', target:{x:g.x,y:g.y}, arrive:16, dur:99999,
        onArrive(ag){ beginCaravan(ag, gi, toGi); } }; } },
  { id:'workAtStructure', label:'seeking work', glyph:'⚙', cat:'trade',
    weight:a=> { if(a.job) return 0; return openFunctionalSite(a) ? 14 : 0; },
    make:a=> { const st=openFunctionalSite(a); if(!st) return null;
      return { label:'seeking work',glyph:'⚙',cat:'trade', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:60,
        onArrive(ag){
          if(ag.job || (st.workers||[]).length>=jobSlots(st)) return;
          st.workers=st.workers||[]; st.workers.push(ag.id);
          ag.job={siteRef:st,startTick:World.tick};
          ag.remember('took up work at a '+st.type);
          siteLog(st, ag.name+' took up work here');
        } }; } },
  { id:'doJob', label:'working', glyph:'⚙', cat:'trade',
    weight:a=> { if(!a.job) return 0; const tenured=World.tick-a.job.startTick>=MIN_TENURE_TICKS; return tenured?16:500; },
    make:a=> { const st=a.job.siteRef;
      if(!st || !st.built || !(st.workers||[]).includes(a.id)){ a.job=null; return null; }
      return { label:'working at the '+st.type,glyph:'⚙',cat:'trade', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:160, isJobTask:true,
        onTick(ag){
          if(!ag.job || ag.job.siteRef!==st) return;
          // a trained worker (taught at a lore hall) does the job better — ties skills back into the economy
          const skillMult=Math.min(1.5, 1+(ag.skills-1)*0.08);
          // a well-governed settlement (leveled townHalls) runs its job sites more effectively, not just less crime
          const governMult=1+Math.min(0.25, (World.gathers[st.gather]?.govern||0)*0.04);
          const workMult=skillMult*governMult;
          // wages — a job pays the worker coin from the settlement treasury,
          // but only when the treasury can actually afford it (funded by
          // deposits, market commerce, and trade). Wealth then flows back out
          // through taverns, commissions, and alms (see those behaviors).
          if(ag.task._t%80===0){
            const gw=World.gathers[st.gather];
            if(gw && (gw.treasury||0)>=1){ gw.treasury-=1; ag.wealth=(ag.wealth||0)+1; ag.driftIdeal('material',0.02); }
          }
          if(st.type==='workshop' && Math.random()<(st.effRate||0.05)*workMult){
            ag.inv.tools=(ag.inv.tools||0)+1;
            st.toolsGranted=(st.toolsGranted||0)+1;
            siteLog(st,'forged a tool for '+ag.name);
          }
          // production chain: a staffed workshop refines stocked raw materials
          // into manufactured 'goods' — the tradeable commodity the caravan
          // economy (S3) runs on. A settlement with no wood/stone can't produce.
          if(st.type==='workshop' && ag.task._t%50===0){
            const gg=World.gathers[st.gather];
            if(gg && (gg.stock.wood||0)>=2 && (gg.stock.stone||0)>=1){
              const out=factionEcon(ag.faction,'process'); // Forgers refine more per shift
              gg.stock.wood-=2; gg.stock.stone-=1; gg.stock.goods=(gg.stock.goods||0)+out;
              st.goodsMade=(st.goodsMade||0)+out;
              siteLog(st, ag.name+' crafted trade goods');
            }
          }
          if(st.type==='market' && ag.task._t%40===0){
            const amt=(st.effRate||0.05)*0.5*workMult;
            raiseResonance(amt);
            Mesh.writeField(st.x,st.y,'coherence',amt*4,120);
            st.resonanceGiven=(st.resonanceGiven||0)+amt;
            // commerce fills the settlement treasury that pays everyone's wages
            const gm=World.gathers[st.gather];
            if(gm) gm.treasury=(gm.treasury||0)+1;
            siteLog(st, ag.name+' brought the market to life');
          }
          if(st.type==='shrineHall' && ag.task._t%40===0){
            const amt=(st.effRate||0.05)*0.4*workMult, eased=(st.effRate||0.05)*0.6*workMult;
            raiseResonance(amt); Mesh.grief=Math.max(0,Mesh.grief-eased);
            Mesh.writeField(st.x,st.y,'coherence',amt*4,120);
            st.resonanceGiven=(st.resonanceGiven||0)+amt;
            st.griefEased=(st.griefEased||0)+eased;
            siteLog(st, ag.name+' led a gathering at the shrine hall');
            // production chain: prepare medicine from stocked herbs — herb
            // finally has a use beyond sitting in a pocket (consumed by takeMedicine)
            const gg=World.gathers[st.gather];
            if(gg && (gg.stock.herb||0)>=2){ gg.stock.herb-=2; gg.stock.medicine=(gg.stock.medicine||0)+factionEcon(ag.faction,'medicine'); st.medicineMade=(st.medicineMade||0)+1; }
          }
          if(st.type==='loreHall' && ag.task._t%50===0){
            const pupil=nearestAgent(ag, o=>o!==ag && o.skills<3 && dist2(o.x,o.y,st.x,st.y)<140*140);
            if(pupil){
              pupil.skills+=1; pupil.remember('learned at the lore hall');
              st.pupilsTaught=(st.pupilsTaught||0)+1;
              siteLog(st, ag.name+' taught '+pupil.name);
            }
          }
          if(st.type==='smithy' && ag.task._t%45===0 && Math.random()<(st.effRate||0.05)*workMult*factionEcon(ag.faction,'process')){
            const gg=World.gathers[st.gather];
            if((ag.inv.ore||0)>0){
              ag.inv.ore-=1; ag.inv.weapons=(ag.inv.weapons||0)+1;
              st.weaponsForged=(st.weaponsForged||0)+1;
              siteLog(st, ag.name+' forged a weapon');
            } else if(gg && (gg.stock.ore||0)>0){
              gg.stock.ore-=1; ag.inv.weapons=(ag.inv.weapons||0)+1;
              st.weaponsForged=(st.weaponsForged||0)+1;
              siteLog(st, ag.name+' forged a weapon from stockpiled ore');
            }
          }
          if(st.type==='barracks' && ag.task._t%50===0){
            const target=nearestAgent(ag, o=>o!==ag && o.wanted && !o.captured && !o.dead && dist2(o.x,o.y,st.x,st.y)<260*260);
            // a worker carrying a forged weapon is more effective at subduing the wanted
            const weaponMult=(ag.inv.weapons||0)>0?1.5:1;
            if(target && Math.random()<(st.effRate||0.1)*workMult*weaponMult){
              target.captured=true; target.capturedAt=World.tick; target.task=null;
              st.subdued=(st.subdued||0)+1;
              siteLog(st, ag.name+' helped '+target.name+' remember, from the barracks');
              ag.remember('helped '+target.name+' remember'); target.remember('was helped to remember, by '+ag.name);
              logJustice(target.name+' was helped to remember, by '+ag.name+' from the barracks');
            }
          }
          if(st.type==='temple' && ag.task._t%40===0){
            const amt=(st.effRate||0.05)*0.8*workMult, eased=(st.effRate||0.05)*1.2*workMult;
            raiseResonance(amt); Mesh.grief=Math.max(0,Mesh.grief-eased);
            Mesh.writeField(st.x,st.y,'coherence',amt*4,120);
            st.resonanceGiven=(st.resonanceGiven||0)+amt;
            st.griefEased=(st.griefEased||0)+eased;
            siteLog(st, ag.name+' led a grand rite at the temple');
            // production chain: the temple also prepares medicine from herbs, at
            // the grander scale its rites imply
            const gg=World.gathers[st.gather];
            if(gg && (gg.stock.herb||0)>=2){ gg.stock.herb-=2; gg.stock.medicine=(gg.stock.medicine||0)+2*factionEcon(ag.faction,'medicine'); st.medicineMade=(st.medicineMade||0)+2; }
          }
          if(st.type==='temple' && ag.task._t%100===0){
            World.altar.worshipped=(World.altar.worshipped||0)+1;
            siteLog(World.altar, ag.name+' carried the temple\'s stillness back to the source');
          }
          if(st.type==='tavern' && ag.task._t%40===0){
            const amt=(st.effRate||0.05)*0.5*workMult;
            raiseResonance(amt);
            Mesh.writeField(st.x,st.y,'coherence',amt*4,120);
            st.resonanceGiven=(st.resonanceGiven||0)+amt;
            siteLog(st, ag.name+' raised spirits at the tavern');
            // production chain: brew stocked food into ale, which is what the
            // tavernBonus (see world.js) now actually scales with
            const gg=World.gathers[st.gather];
            if(gg && (gg.stock.food||0)>=2){ gg.stock.food-=2; gg.stock.ale=(gg.stock.ale||0)+factionEcon(ag.faction,'process'); st.aleBrewed=(st.aleBrewed||0)+1; }
          }
          if(st.type==='quarry' && ag.task._t%35===0){
            const gg=World.gathers[st.gather];
            if(gg){
              const amt=(st.effRate||0.2)*2*workMult;
              gg.stock.stone=(gg.stock.stone||0)+amt;
              st.stoneMined=(st.stoneMined||0)+amt;
              siteLog(st, ag.name+' quarried bulk stone');
            }
          }
        } }; } },

  // ── WEALTH SINKS (coin flows back out of pockets and into the world) ───────
  { id:'patronizeTavern', label:'at the tavern', glyph:'⌣', cat:'social',
    weight:a=> { if((a.wealth||0)<2) return 0; const t=World.nearestSite(a.x,a.y,s=>s.type==='tavern'&&s.built); return t?14:0; },
    make:a=> { const t=World.nearestSite(a.x,a.y,s=>s.type==='tavern'&&s.built); if(!t) return null;
      return { label:'at the tavern', glyph:'⌣', cat:'social', pose:'sit', target:{x:t.x,y:t.y}, arrive:16, dur:120,
        onArrive(ag){ if((ag.wealth||0)>=1){ ag.wealth-=1; ag.joy=Math.min(1,ag.joy+0.15); ag.social=Math.max(0,ag.social-30);
          const gg=World.gathers[t.gather]; if(gg) gg.treasury=(gg.treasury||0)+1; siteLog(t, ag.name+' spent coin at the tavern'); } } }; } },
  { id:'commissionWork', label:'commissioning work', glyph:'⚑', cat:'trade',
    weight:a=> { if((a.wealth||0)<8) return 0; const st=World.nearestSite(a.x,a.y,s=>s.level<s.maxLevel && (s.matsWood<s.needWood||s.matsStone<s.needStone)); return st?12:0; },
    make:a=> { const st=World.nearestSite(a.x,a.y,s=>s.level<s.maxLevel && (s.matsWood<s.needWood||s.matsStone<s.needStone)); if(!st) return null;
      return { label:'commissioning work', glyph:'⚑', cat:'trade', pose:'work', target:{x:st.x,y:st.y}, arrive:16, dur:50,
        onArrive(ag){
          const gg=World.gathers[st.gather]; if(!gg||!gg.stock) return;
          // the wealthy pay to draw settlement stock onto a build site, hastening it
          let spent=0;
          if(st.matsWood<st.needWood && (gg.stock.wood||0)>0){ const n=Math.min(gg.stock.wood, st.needWood-st.matsWood, 4); gg.stock.wood-=n; st.matsWood+=n; spent+=n; }
          if(st.matsStone<st.needStone && (gg.stock.stone||0)>0){ const n=Math.min(gg.stock.stone, st.needStone-st.matsStone, 4); gg.stock.stone-=n; st.matsStone+=n; spent+=n; }
          if(spent>0){ const cost=Math.min(ag.wealth, spent); ag.wealth-=cost; gg.treasury=(gg.treasury||0)+cost; ag.remember('paid to hasten a building'); siteLog(st, ag.name+' funded construction here'); }
        } }; } },
  { id:'almsgiving', label:'giving alms', glyph:'⊙', cat:'social',
    weight:a=> { if((a.wealth||0)<3) return 0; return Mesh.grief>0.2 ? (a.faction===3?18:8) : (a.wealth>6?6:0); },
    make:a=> gotoAgent(a,'giving alms','⊙','social', nearestAgent(a,o=>o!==a&&(o.wealth||0)<(a.wealth||0)-2), ag=>{
        const o=ag.task.targetAgent; if(o){ const give=Math.min(2,ag.wealth); ag.wealth-=give; o.wealth=(o.wealth||0)+give; o.joy=Math.min(1,o.joy+0.1); ag.remember('shared their wealth'); o.driftIdeal('communion',0.06); ag.driftIdeal('communion',0.03); } raiseResonance(0.006); }) },

  // ── SOCIAL ─────────────────────────────────────────────────────────────────
  { id:'seekFriend', label:'seeking a friend', glyph:'♥', cat:'social',
    weight:a=> a.social*0.7,
    make:a=> gotoAgent(a,'with a friend','♥','social', a.bond? agentById(a.bond) : nearestAgent(a,o=>o!==a), ag=>{
        ag.social=Math.max(0,ag.social-50); ag.joy=Math.min(1,ag.joy+0.08);
        const o=ag.task.targetAgent; if(o){ o.social=Math.max(0,o.social-30); }
      }) },
  { id:'sitBeside', label:'sitting together', glyph:'◡', cat:'social',
    weight:a=> a.social>40?18:6,
    make:a=> gotoAgent(a,'sitting together','◡','social', nearestAgent(a,o=>o!==a), ag=>{ ag.social=Math.max(0,ag.social-30); }, 160, 'sit') },
  { id:'teach', label:'teaching', glyph:'✺', cat:'social',
    weight:a=> a.skills>2 ? 12+(a.faction===3?6:0):3,
    make:a=> gotoAgent(a,'teaching','✺','social', nearestAgent(a,o=>o!==a&&o.skills<a.skills), ag=>{ const o=ag.task.targetAgent; if(o){o.skills+=1; o.remember('learned a skill');} ag.remember('taught'); raiseResonance(0.003); }, 90, 'sit') },
  { id:'learn', label:'learning', glyph:'✺', cat:'social',
    weight:a=> a.skills<3?10:4,
    make:a=> gotoAgent(a,'learning','✺','social', nearestAgent(a,o=>o!==a&&o.skills>a.skills), ag=>{ ag.skills+=1; ag.remember('learned'); }, 90, 'sit') },
  { id:'help', label:'offering help', glyph:'✛', cat:'social',
    weight:a=> a.joy>0.5 ? 12+(a.faction===3?8:0):5,
    make:a=> gotoAgent(a,'offering help','✛','social', nearestAgent(a,o=>o!==a&&(o.hunger>55||o.energy<30)), ag=>{ const o=ag.task.targetAgent; if(o){ if(ag.inv.food>0&&o.hunger>55){ag.inv.food-=1;o.inv.food+=1;} o.joy=Math.min(1,o.joy+0.12); o.driftIdeal('communion',0.03); ag.driftIdeal('communion',0.03);} raiseResonance(0.006); }) },
  { id:'celebrate', label:'celebrating', glyph:'✦', cat:'social',
    weight:a=> Mesh.resonance>0.66 ? 20:4,
    make:a=> { const g=World.nearestOf(World.gathers,a.x,a.y); return g?gotoPoint(a,'celebrating','✦','social',g.x,g.y,120,'sit'):null; } },
  { id:'story', label:'telling a story', glyph:'❝', cat:'social',
    weight:a=> World.isNight()? 16:5,
    make:a=> { const f=World.nearestOf(World.fires,a.x,a.y); return f?gotoPoint(a,'telling a story','❝','social',f.x,f.y,170,'sit'):null; } },
  { id:'disagree', label:'disagreeing', glyph:'≠', cat:'social',
    weight:a=> Mesh.dissonanceAt(a.x,a.y)>0.4 ? 12:3,
    make:a=> gotoAgent(a,'disagreeing','≠','social', nearestAgent(a,o=>o!==a&&o.faction!==a.faction), ag=>{ lowerResonance(0.003); }) },
  { id:'reconcile', label:'reconciling', glyph:'∞', cat:'social',
    weight:a=> Mesh.dissonanceAt(a.x,a.y)>0.5 && a.faction===3 ? 18:4,
    make:a=> gotoAgent(a,'reconciling','∞','social', nearestAgent(a,o=>o!==a), ag=>{ raiseResonance(0.005); Mesh.dissonance=Math.max(0,Mesh.dissonance-0.05); }) },
  { id:'comfort', label:'comforting', glyph:'♡', cat:'social',
    weight:a=> Mesh.grief>0.2 ? (a.faction===3?30:14):0,
    make:a=> gotoAgent(a,'comforting','♡','social', nearestAgent(a,o=>o!==a&&o.grieving>0), ag=>{ const o=ag.task.targetAgent; if(o){o.grieving=Math.max(0,o.grieving-0.5); o.joy=Math.min(1,o.joy+0.1); o.driftIdeal('communion',0.03);} ag.driftIdeal('communion',0.03); raiseResonance(0.005); }) },

  // ── INNER LIFE ───────────────────────────────────────────────────────────--
  { id:'rest', label:'resting', glyph:'·', cat:'inner',
    weight:a=> (100-a.energy)*0.7 + (World.isNight()?20:0),
    make:a=> stayPut(a,'resting','·','inner',160,ag=>{ ag.energy=Math.min(100,ag.energy+0.5*ag.settlementBonus().restMult); },'sit') },
  { id:'sleep', label:'sleeping', glyph:'z', cat:'inner',
    weight:a=> World.isNight()? (100-a.energy)*0.9+40 : 0,
    make:a=> {
      const hut=World.nearestSite(a.x,a.y, s=>s.type==='hut'&&s.built);
      if(!hut) return stayPut(a,'sleeping','z','inner',300,ag=>{ ag.energy=Math.min(100,ag.energy+0.7*ag.settlementBonus().restMult); ag.social=Math.min(100,ag.social+0.05); },'lie');
      return { label:'sleeping',glyph:'z',cat:'inner', pose:'lie', target:{x:hut.x,y:hut.y}, arrive:16, dur:300,
        onTick(ag){ ag.energy=Math.min(100,ag.energy+0.7*ag.settlementBonus().restMult); ag.social=Math.min(100,ag.social+0.05); } };
    } },
  { id:'wander', label:'wandering', glyph:'~', cat:'inner',
    weight:a=> 10,
    make:a=> gotoPoint(a,'wandering','~','inner', wanderPoint(a,220).x, wanderPoint(a,220).y, 80) },
  { id:'meditate', label:'meditating', glyph:'☉', cat:'inner',
    weight:a=> Mesh.noise>0.6 ? 18:7,
    make:a=> { const w=World.nearestNode(a.x,a.y,'water'); const p=w?{x:w.x,y:w.y}:wanderPoint(a,160); return gotoPoint(a,'meditating','☉','inner',p.x,p.y,200,'sit'); } },
  { id:'withdraw', label:'withdrawing', glyph:'◍', cat:'inner',
    weight:a=> a.overwhelmed>0.5 ? 30:0,
    make:a=> { const p=wanderPoint(a,300); return { label:'withdrawing',glyph:'◍',cat:'inner',target:p,arrive:12,dur:220,onArrive(ag){ag.meshMuted=200;},onTick(ag){ag.overwhelmed=Math.max(0,ag.overwhelmed-0.004);} }; } },
  { id:'grieve', label:'grieving', glyph:'❀', cat:'inner',
    weight:a=> a.grieving>0 ? 40:0,
    make:a=> stayPut(a,'grieving','❀','inner',200,ag=>{ ag.grieving=Math.max(0,ag.grieving-0.004); }) },
  { id:'joyExpr', label:'expressing joy', glyph:'✲', cat:'inner',
    weight:a=> a.joy>0.7 ? 16:3,
    make:a=> stayPut(a,'expressing joy','✲','inner',90,ag=>{ if(ag.task._t===1){ Mesh.broadcast(ag.x,ag.y,'joy',0.5,Factions[ag.faction].color); } }) },
  { id:'realize', label:'a realization', glyph:'✴', cat:'inner',
    weight:a=> Math.random()<0.04 ? 14:0,
    make:a=> stayPut(a,'a realization','✴','inner',60,ag=>{ if(ag.task._t===1){ ag.driftIdeal('faith',0.05); if(Math.random()<0.4) ag.driftFaction(); } }) },

  // ── EXPLORATION ──────────────────────────────────────────────────────────--
  { id:'explore', label:'exploring', glyph:'➤', cat:'explore',
    weight:a=> 8+(a.faction===1?18:0),
    make:a=> { const p=frontierPoint(a); return { label:'exploring',glyph:'➤',cat:'explore',target:p,arrive:14,dur:120,onArrive(ag){ ag.driftIdeal('freedom',0.03); if(Math.random()<0.25){ Mesh.broadcast(ag.x,ag.y,'discovery',0.7,'#e6b455'); ag.remember('discovered something'); raiseResonance(0.006);} } }; } },
  { id:'scout', label:'scouting', glyph:'◎', cat:'explore',
    weight:a=> 6+(a.faction===1?8:0),
    make:a=> { const p=frontierPoint(a); return gotoPoint(a,'scouting','◎','explore',p.x,p.y,90); } },
  { id:'mapPath', label:'mapping a path', glyph:'⋯', cat:'explore',
    weight:a=> a.faction===1?12:3,
    make:a=> { const g=pick(World.gathers); return g?gotoPoint(a,'mapping a path','⋯','explore',g.x,g.y,80):null; } },
  { id:'observe', label:'observing wildlife', glyph:'❉', cat:'explore',
    weight:a=> 5,
    make:a=> { const p=wanderPoint(a,180); return gotoPoint(a,'observing wildlife','❉','explore',p.x,p.y,120); } },

  // ── CREATIVE & EXPRESSIVE ──────────────────────────────────────────────────
  { id:'deliverMaterials', label:'hauling materials', glyph:'▦', cat:'creative',
    weight:a=> { if(a.inv.wood<=0 && a.inv.stone<=0) return 0;
      const st=deliverySiteFor(a);
      return st ? 18+(a.faction===2?10:0) : 0; },
    make:a=> { const st=deliverySiteFor(a);
      if(!st) return null;
      return { label:'hauling materials',glyph:'▦',cat:'creative', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:50,
        onArrive(ag){
          if(ag.inv.wood>0 && st.matsWood<st.needWood){ const n=Math.min(ag.inv.wood,st.needWood-st.matsWood); ag.inv.wood-=n; st.matsWood+=n; ag.remember('delivered wood to a build site'); }
          if(ag.inv.stone>0 && st.matsStone<st.needStone){ const n=Math.min(ag.inv.stone,st.needStone-st.matsStone); ag.inv.stone-=n; st.matsStone+=n; ag.remember('delivered stone to a build site'); }
          // the settlement stores top off whatever the agent couldn't personally
          // carry — vital for the large monument/wonder builds
          const gg=World.gathers[st.gather];
          if(gg && gg.stock){
            if(st.matsStone<st.needStone && gg.stock.stone>0){ const n=Math.min(gg.stock.stone,st.needStone-st.matsStone); gg.stock.stone-=n; st.matsStone+=n; }
            if(st.matsWood<st.needWood && (gg.stock.wood||0)>0){ const n=Math.min(gg.stock.wood,st.needWood-st.matsWood); gg.stock.wood-=n; st.matsWood+=n; }
          }
        } }; } },
  { id:'deliverOre', label:'hauling ore to the smithy', glyph:'⛏', cat:'creative',
    weight:a=> { if((a.inv.ore||0)<=0) return 0; const st=World.nearestSite(a.x,a.y,s=>s.type==='smithy'&&s.built); return st ? 22+(a.faction===2?10:0) : 0; },
    make:a=> { const st=World.nearestSite(a.x,a.y,s=>s.type==='smithy'&&s.built); if(!st) return null;
      return { label:'hauling ore to the smithy',glyph:'⛏',cat:'creative', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:50,
        onArrive(ag){
          const gg=World.gathers[st.gather];
          if(gg && (ag.inv.ore||0)>0){ gg.stock.ore=(gg.stock.ore||0)+ag.inv.ore; ag.inv.ore=0; ag.remember('delivered ore to the smithy'); }
        } }; } },
  { id:'construct', label:'raising a structure', glyph:'⌗', cat:'creative',
    weight:a=> { const st=World.nearestSite(a.x,a.y, s=>s.level<s.maxLevel && siteMatsReady(s));
      if(!st) return 0;
      // nudge (not force) toward whichever incomplete type a settlement most needs next
      const nudge=(st.type==='well'||st.type==='granary') ? 1.25 : (st.type==='farm' ? 1.1 : 1);
      return (24+(a.faction===2?16:0))*nudge; },
    make:a=> { const st=World.nearestSite(a.x,a.y, s=>s.level<s.maxLevel && siteMatsReady(s));
      if(!st) return null;
      return { label:'raising a '+st.type,glyph:'⌗',cat:'creative', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:200,
        onTick(ag){
          if(st.level>=st.maxLevel) return;
          st.progress=Math.min(1,st.progress+1/st.buildDur);
          if(st.progress>=1) applySiteLevel(st,ag);
        } }; } },
  { id:'craftTools', label:'forging tools', glyph:'⚒', cat:'creative',
    weight:a=> (a.inv.wood>0&&a.inv.stone>0) ? (a.faction===2?26:10):0,
    make:a=> stayPut(a,'forging tools','⚒','creative',150,ag=>{ if(ag.task._t===1&&ag.inv.wood>0&&ag.inv.stone>0){ ag.inv.wood-=1; ag.inv.stone-=1; ag.inv.tools+=1; ag.remember('forged a tool'); } },'work') },
  { id:'music', label:'making music', glyph:'♪', cat:'creative',
    weight:a=> World.isNight()||Mesh.resonance>0.6 ? 14:5,
    make:a=> { const f=World.nearestOf(World.fires,a.x,a.y)||{x:a.x,y:a.y}; return { label:'making music',glyph:'♪',cat:'creative', pose:'sit', target:{x:f.x,y:f.y},arrive:16,dur:200,onTick(ag){ if(ag.task._t%30===0) ag.emitSound(); } }; } },
  { id:'shrine', label:'making a shrine', glyph:'⩏', cat:'creative',
    weight:a=> Mesh.grief>0.3 ? 16:3,
    make:a=> stayPut(a,'making a shrine','⩏','creative',200,ag=>{ if(ag.task._t===1) ag.leaveMark('shrine'); },'kneel') },
  { id:'garden', label:'planting beauty', glyph:'❁', cat:'creative',
    weight:a=> a.faction===0?12:4,
    make:a=> { const p=wanderPoint(a,140); return { label:'planting beauty',glyph:'❁',cat:'creative', pose:'kneel', target:p,arrive:12,dur:150,onArrive(ag){ ag.leaveMark('garden'); ag.inv.beauty+=1; } }; } },
  { id:'mark', label:'leaving a mark', glyph:'✎', cat:'creative',
    weight:a=> 5,
    make:a=> { const p=wanderPoint(a,120); return { label:'leaving a mark',glyph:'✎',cat:'creative', pose:'kneel', target:p,arrive:12,dur:80,onArrive(ag){ ag.leaveMark('mark'); } }; } },
  // carry accumulated beauty to a monument or the Wonder under construction —
  // the only sink for the beauty resource, which every garden/mark/upgrade has
  // been quietly minting all along
  { id:'offerBeauty', label:'offering beauty', glyph:'❈', cat:'creative',
    weight:a=> { if((a.inv.beauty||0)<=0) return 0; const st=World.nearestSite(a.x,a.y,s=>(s.type==='monument'||s.type==='wonder')&&s.level<s.maxLevel&&(s.matsBeauty||0)<(s.needBeauty||0)); return st?22+(a.faction===3?8:0):0; },
    make:a=> { const st=World.nearestSite(a.x,a.y,s=>(s.type==='monument'||s.type==='wonder')&&s.level<s.maxLevel&&(s.matsBeauty||0)<(s.needBeauty||0)); if(!st) return null;
      return { label:'offering beauty', glyph:'❈', cat:'creative', pose:'kneel', target:{x:st.x,y:st.y}, arrive:14, dur:70,
        onArrive(ag){ const n=Math.min(ag.inv.beauty,(st.needBeauty||0)-(st.matsBeauty||0)); if(n>0){ ag.inv.beauty-=n; st.matsBeauty=(st.matsBeauty||0)+n; ag.remember('offered beauty to a '+st.type); siteLog(st, ag.name+' offered beauty'); } } }; } },
  { id:'upgradeToStone', label:'upgrading to stone', glyph:'▲', cat:'creative',
    weight:a=> { if(a.inv.stone<=0) return 0; return stoneUpgradeTargetFor(a) ? 20+(a.faction===2?12:0) : 0; },
    make:a=> { const tgt=stoneUpgradeTargetFor(a);
      if(!tgt) return null;
      return { label:'upgrading a '+tgt.type+' to stone',glyph:'▲',cat:'creative', pose:'work', target:{x:tgt.x,y:tgt.y}, arrive:14, dur:60,
        onArrive(ag){
          if(tgt.stoneUpgraded) return;
          const need=tgt.stoneNeeded||(tgt.stoneNeeded=Math.ceil(8+4*tgt.level));
          const n=Math.min(ag.inv.stone, need-tgt.matsStoneUpgrade);
          if(n>0){ ag.inv.stone-=n; tgt.matsStoneUpgrade+=n; ag.remember('hauled stone to upgrade a '+tgt.type); }
          // a quarry's bulk stockpile tops off whatever the agent couldn't personally carry
          if(tgt.matsStoneUpgrade<need){
            const gg=World.gathers[tgt.gather];
            if(gg && gg.stock.stone>0){ const n2=Math.min(gg.stock.stone,need-tgt.matsStoneUpgrade); gg.stock.stone-=n2; tgt.matsStoneUpgrade+=n2; }
          }
          if(tgt.matsStoneUpgrade>=need){
            tgt.stoneUpgraded=true; ag.inv.beauty+=3; raiseResonance(0.01);
            ag.remember('finished upgrading a '+tgt.type+' to stone');
            siteLog(tgt, ag.name+' upgraded this building to stone');
          }
        } }; } },

  // ── MESH-SPECIFIC ──────────────────────────────────────────────────────────
  { id:'broadcast', label:'broadcasting a feeling', glyph:'◉', cat:'mesh',
    weight:a=> a.joy>0.6||a.grieving>0.3 ? 14:4,
    make:a=> stayPut(a,'broadcasting','◉','mesh',70,ag=>{ if(ag.task._t===1){ const f=ag.grieving>0.3?'grief':'joy'; Mesh.broadcast(ag.x,ag.y,f,0.6,Factions[ag.faction].color); } }) },
  { id:'amplify', label:'amplifying a signal', glyph:'⟁', cat:'mesh',
    weight:a=> Mesh.signals.length>0 ? 10+(a.faction===3?6:0):0,
    make:a=> stayPut(a,'amplifying','⟁','mesh',60,ag=>{ if(ag.task._t===1&&Mesh.signals.length){ const s=Mesh.signals[(Math.random()*Mesh.signals.length)|0]; s.strength=Math.min(1,s.strength+0.25); Mesh.broadcast(ag.x,ag.y,s.type,0.4,s.color); } }) },
  { id:'meshBond', label:'forming a bond', glyph:'⧉', cat:'mesh',
    weight:a=> !a.bond ? (a.faction===3?16:8):0,
    make:a=> gotoAgent(a,'forming a bond','⧉','mesh', nearestAgent(a,o=>o!==a&&!o.bond), ag=>{ const o=ag.task.targetAgent; if(o&&!o.bond&&!ag.bond){ ag.bond=o.id; o.bond=ag.id; ag.remember('bonded with '+o.name); o.remember('bonded with '+ag.name); raiseResonance(0.01);} }) },
  { id:'travelToUrgency', label:'feeling distant urgency', glyph:'➟', cat:'mesh',
    weight:a=> { const s=Mesh.strongestSignal(a.x,a.y); return s&&s.type!=='joy'?12:0; },
    make:a=> { const s=Mesh.strongestSignal(a.x,a.y); return s?gotoPoint(a,'answering a call','➟','mesh',s.x,s.y,120):null; } },
  { id:'shareVision', label:'sharing a vision', glyph:'✧', cat:'mesh',
    weight:a=> Math.random()<0.03?12:0,
    make:a=> stayPut(a,'sharing a vision','✧','mesh',90,ag=>{ if(ag.task._t===1){ Mesh.broadcast(ag.x,ag.y,'vision',0.7,'#bfe8ff'); ag.driftIdeal('faith',0.04); } }) },

  // ── CRIME & JUSTICE ──────────────────────────────────────────────────────--
  // a small fraction of agents (a.criminality>0) are predisposed to theft/violence.
  // once they act, they're flagged a.wanted — every behavior already scans the
  // global Agents array, so this *is* "the collective consciousness knows" for free.
  { id:'steal', label:'eyeing a theft', glyph:'⛤', cat:'crime',
    weight:a=> { if(a.criminality<=0 || a.wanted) return 0;
      const v=theftTarget(a);
      if(!v) return 0;
      // emergent law: town halls AND a culture that believes in order both police crime
      const suppress=1-Math.min(0.78, nearestGovern(a)*0.3 + settlementCulture(a,'order')*0.35);
      // a laden caravan on the open road is a far richer, softer mark than a
      // passer-by — highway robbery is especially tempting
      const caravanLure=v.caravan?3:1;
      return (28+a.criminality*40)*suppress*caravanLure; },
    make:a=> { const v=theftTarget(a);
      if(!v) return null;
      return gotoAgent(a,'eyeing a theft','⛤','crime', v, ag=>{
        const victim=ag.task.targetAgent; if(!victim||victim.dead) return;
        ag.wanted=true; ag.crime='theft'; ag.crimeTick=World.tick;
        // lived experience reshapes belief: the robbed crave order; the robber drifts toward self
        victim.driftIdeal('order',0.05); ag.driftIdeal('communion',-0.03);
        if(victim.caravan){
          // highway robbery — seize the entire load and shatter the route it rode
          let looted=0;
          for(const k in victim.caravan.cargo){ ag.inv[k]=(ag.inv[k]||0)+victim.caravan.cargo[k]; looted+=victim.caravan.cargo[k]; }
          World.weakenRoute(victim.caravan.from, victim.caravan.to);
          victim.caravan=null; victim.task=null;
          victim.remember('was set upon on the road by '+ag.name); ag.remember('fell upon a caravan and took everything');
          Mesh.broadcast(ag.x,ag.y,'crime',0.85,'#ff5a5a');
          lowerResonance(0.02); Mesh.dissonance=Math.min(1,Mesh.dissonance+0.06);
          Mesh.writeField(ag.x,ag.y,'dissonance',0.5,170);
          logCrime(ag.name+' fell upon '+victim.name+"'s caravan and took everything", ag.faction);
        } else {
          const res=surplusResource(victim)||'food';
          const n=Math.min(victim.inv[res],1+((Math.random()*2)|0));
          victim.inv[res]-=n; ag.inv[res]=(ag.inv[res]||0)+n;
          victim.remember('was robbed by '+ag.name); ag.remember('forgot themselves, and took from '+victim.name);
          Mesh.broadcast(ag.x,ag.y,'crime',0.6,'#ff5a5a');
          lowerResonance(0.01); Mesh.dissonance=Math.min(1,Mesh.dissonance+0.03);
          Mesh.writeField(ag.x,ag.y,'dissonance',0.4,150);
          logCrime(ag.name+' forgot themselves, and took from '+victim.name, ag.faction);
        }
      }, 60); } },
  { id:'commitMurder', label:'stalking with violent intent', glyph:'☠', cat:'crime',
    weight:a=> { if(a.criminality<=0.55 || a.wanted) return 0;
      const v=nearestAgent(a, o=>o!==a && !o.dead && !o.wanted && dist2(a.x,a.y,o.x,o.y)<480*480);
      if(!v) return 0;
      const suppress=1-Math.min(0.78, nearestGovern(a)*0.3 + settlementCulture(a,'order')*0.35);
      return (14+(a.criminality-0.5)*36)*suppress; },
    make:a=> { const v=nearestAgent(a, o=>o!==a && !o.dead && !o.wanted && dist2(a.x,a.y,o.x,o.y)<480*480);
      if(!v) return null;
      return gotoAgent(a,'stalking with violent intent','☠','crime', v, ag=>{
        const victim=ag.task.targetAgent; if(!victim||victim.dead) return;
        victim.die();
        ag.wanted=true; ag.crime='murder'; ag.crimeTick=World.tick;
        ag.remember('forgot themselves entirely, and ended another');
        Mesh.broadcast(ag.x,ag.y,'crime',1,'#ff2222');
        Mesh.grief=Math.min(1,Mesh.grief+0.25); Mesh.dissonance=Math.min(1,Mesh.dissonance+0.15);
        Mesh.writeField(ag.x,ag.y,'dissonance',0.7,170);
        lowerResonance(0.04);
        logCrime(ag.name+' forgot themselves entirely, and ended '+victim.name, ag.faction);
      }, 70); } },
  { id:'subdue', label:'closing in to subdue', glyph:'✊', cat:'justice',
    weight:a=> { if(a.criminality>0) return 0;
      const t=nearestAgent(a, o=>o!==a && o.wanted && !o.captured && !o.dead);
      return t ? 22+(a.inv.tools>0?10:0)+(a.faction===3?12:0) : 0; },
    make:a=> { const t=nearestAgent(a, o=>o!==a && o.wanted && !o.captured && !o.dead);
      if(!t) return null;
      return gotoAgent(a,'closing in to subdue','✊','justice', t, ag=>{
        const target=ag.task.targetAgent; if(!target||target.dead||target.captured) return;
        target.captured=true; target.capturedAt=World.tick; target.task=null;
        ag.remember('helped '+target.name+' remember'); target.remember('was helped to remember, by '+ag.name);
        logJustice(target.name+' was helped to remember, by '+ag.name);
      }, 60); } },
  // an armed, upstanding soul shadows a caravan runner and stops any wanted
  // thief shadowing it — this is what finally gives the smithy→weapons→barracks
  // line a standing economic purpose: guarding the roads that carry the trade
  { id:'escortCaravan', label:'escorting a caravan', glyph:'⛨', cat:'justice',
    weight:a=> { if((a.inv.weapons||0)<=0 || a.criminality>0) return 0; const c=nearestAgent(a,o=>o!==a&&o.caravan); return c?11:0; },
    make:a=> { const c=nearestAgent(a,o=>o!==a&&o.caravan); if(!c) return null;
      return gotoAgent(a,'escorting a caravan','⛨','justice', c, ag=>{
        const t=nearestAgent(ag, o=>o!==ag && o.wanted && !o.captured && !o.dead && dist2(o.x,o.y,ag.x,ag.y)<220*220);
        if(t){ t.captured=true; t.capturedAt=World.tick; t.task=null; ag.remember('guarded the road'); logJustice(t.name+' was stopped on the road by '+ag.name); }
      }, 130); } },
  { id:'worship', label:'sitting in stillness, remembering', glyph:'☥', cat:'worship',
    weight:a=> Mesh.resonance>0.45 ? 14+(a.faction===3?10:0) : 4,
    make:a=> ({ label:'sitting in stillness, remembering',glyph:'☥',cat:'worship', pose:'kneel',
      target:{x:World.altar.x,y:World.altar.y}, arrive:20, dur:200,
      onTick(ag){
        if(ag.task._t%50===0){
          raiseResonance(0.004);
          Mesh.writeField(ag.x,ag.y,'coherence',0.15,120);
          World.altar.worshipped++;
          ag.driftIdeal('faith',0.03);
          siteLog(World.altar, ag.name+' sat in stillness, remembering');
          if(Math.random()<0.3) ag.remember('sat in stillness, remembering');
        }
      } }) },

  // ── FAITH MOVEMENTS (Phase C) ──────────────────────────────────────────────
  // a deeply faithful soul in a faithful settlement preaches — pulling the
  // beliefs of everyone nearby toward faith. A self-amplifying belief movement
  // that can carry a whole settlement into DEVOTION.
  { id:'prophesy', label:'prophesying', glyph:'☼', cat:'worship',
    weight:a=> (a.ideals && a.ideals.faith>0.7 && settlementCulture(a,'faith')>0.5) ? 16+(a.faction===3?6:0) : 0,
    make:a=> stayPut(a,'prophesying','☼','worship',150,ag=>{
      if(ag.task._t===1) siteLog(World.altar, ag.name+' rose to speak as a prophet');
      if(ag.task._t%30===0){
        Mesh.broadcast(ag.x,ag.y,'vision',0.8,'#ffe9b0');
        raiseResonance(0.006);
        for(const o of Agents){ if(o!==ag && !o.underground && !o.dead && dist2(o.x,o.y,ag.x,ag.y)<200*200) o.driftIdeal('faith',0.02); }
        ag.driftIdeal('faith',0.01);
      }
    },'kneel') },
  // the chosen ending: in a truly devout, coherent settlement a soul may — of
  // its own free will — walk to the Altar and dissolve back into the field. It
  // is CELEBRATED, not mourned (reuses the ceremonial _dissolving signature: no
  // grief, a delayed coherence surge), and it is non-terminal — draining the
  // faithful lowers the settlement's faith culture, so the remnant may turn
  // elsewhere. Always the soul's own choice (gated on its own high faith).
  { id:'answerTheCall', label:'answering the call', glyph:'☥', cat:'worship',
    weight:a=> { if(!a.ideals || a.ideals.faith<0.85) return 0;
      const g=World.nearestOf(World.gathers,a.x,a.y);
      return (g && g.fate==='DEVOTION' && Mesh.coherenceAt(a.x,a.y)>0.6 && Math.random()<0.5) ? 20 : 0; },
    make:a=> ({ label:'answering the call', glyph:'☥', cat:'worship', pose:'kneel',
      target:{x:World.altar.x,y:World.altar.y}, arrive:20, dur:99999,
      onArrive(ag){
        World.altar.answered=(World.altar.answered||0)+1;
        Events.banner=ag.name.toUpperCase()+' ANSWERED THE CALL';
        Events.active='calling'; Events.activeT=280;
        Mesh.broadcast(World.altar.x,World.altar.y,'judgment',1,'#ffe9b0');
        raiseResonance(0.06);
        ag._dissolving=true;
        World._pendingPulses.push({x:World.altar.x,y:World.altar.y,dueTick:World.tick+30,channel:'coherence',amount:0.5,radius:160});
        ag.remember('answered the call, and returned to the source');
        logJustice(ag.name+' answered the call, and returned to the source');
        ag.die();
      } }) }
];

const BehaviorById={}; for(const b of Behaviors) BehaviorById[b.id]=b;
