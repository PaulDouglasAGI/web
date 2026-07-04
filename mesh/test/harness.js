/* Headless vm harness for THE MESH — loads the plain <script> files (no bundler,
   no DOM) into a shared sandbox in the same dependency order as index.html,
   skipping renderer.js/ui.js/main.js since they touch document/canvas. */
'use strict';
const fs=require('fs');
const path=require('path');
const vm=require('vm');

const SRC=path.join(__dirname,'..','src');
const FILES=['world.js','underground.js','factions.js','economy.js','behaviors.js','mesh.js','agents.js','events.js'];

function buildContext(){
  const sandbox={ console, Math, Float32Array, Object };
  const ctx=vm.createContext(sandbox);
  for(const f of FILES){
    const code=fs.readFileSync(path.join(SRC,f),'utf8');
    vm.runInContext(code, ctx, { filename:f });
  }
  return ctx;
}

function assert(cond,msg){
  if(!cond){ console.error('FAIL: '+msg); process.exitCode=1; }
  else console.log('PASS: '+msg);
}

function freshWorld(ctx,seed){
  vm.runInContext(`World.init(${seed}); Underground.init(${seed}); Mesh.reset();`, ctx);
}

// ── Test 1: diffusion in isolation ──────────────────────────────────────────
(function testDiffusion(){
  const ctx=buildContext();
  freshWorld(ctx,1);
  vm.runInContext(`Mesh.writeField(World.w/2, World.h/2, 'coherence', 0.5, 80);`, ctx);
  const before=vm.runInContext(`Mesh.coherenceAt(World.w/2+200, World.h/2)`, ctx);
  for(let i=0;i<200;i++) vm.runInContext('Mesh.update();', ctx);
  const centerAfter=vm.runInContext(`Mesh.coherenceAt(World.w/2, World.h/2)`, ctx);
  const neighborAfter=vm.runInContext(`Mesh.coherenceAt(World.w/2+200, World.h/2)`, ctx);
  assert(centerAfter<0.95 && centerAfter>0.4, 'center decays/diffuses from initial deposit ('+centerAfter.toFixed(3)+')');
  assert(neighborAfter>before, 'a cell 200px away rose above baseline after diffusion ('+before.toFixed(3)+' -> '+neighborAfter.toFixed(3)+')');
})();

// ── Test 2: shim getter/setter round-trips sanely ───────────────────────────
(function testShim(){
  const ctx=buildContext();
  freshWorld(ctx,2);
  const r0=vm.runInContext('Mesh.resonance', ctx);
  assert(Math.abs(r0-0.5)<0.01, 'initial Mesh.resonance reads ~0.5 from the grid average ('+r0+')');
  vm.runInContext('Mesh.resonance = Math.min(1, Mesh.resonance + 0.2);', ctx);
  const r1=vm.runInContext('Mesh.resonance', ctx);
  assert(Math.abs(r1-0.7)<0.01, 'setter bump of +0.2 reflected in getter ('+r1+')');
  const allRaised=vm.runInContext(`
    let ok=true;
    for(let i=0;i<Mesh.coherence.length;i++){ if(Mesh.coherence[i]<0.65){ ok=false; break; } }
    ok;
  `, ctx);
  assert(allRaised, 'setter applied the delta uniformly across every grid cell');
})();

// ── Test 3: field-write distance delay (death -> grief) ─────────────────────
(function testFieldWriteDelay(){
  const ctx=buildContext();
  freshWorld(ctx,3);
  vm.runInContext(`
    const a=new Agent(World.w/2, World.h/2, 0);
    Agents.push(a);
    a.die();
  `, ctx);
  const griefAtDeath=vm.runInContext('Mesh.griefAt(World.w/2, World.h/2)', ctx);
  const griefFarImmediate=vm.runInContext('Mesh.griefAt(World.w/2+400, World.h/2+400)', ctx);
  assert(griefAtDeath>0.1, 'grief written immediately at death location ('+griefAtDeath.toFixed(3)+')');
  // Mesh.broadcast's existing global grief bump (kept, additive, per plan) still nudges every
  // cell uniformly — so a distant cell isn't zero, but it must be far weaker than the death site,
  // which is where writeField's spatially-precise deposit lands on top of that uniform ripple.
  assert(griefFarImmediate<griefAtDeath-0.1, 'a distant cell feels far less than the death site immediately ('+griefFarImmediate.toFixed(3)+' vs '+griefAtDeath.toFixed(3)+')');
  for(let i=0;i<150;i++) vm.runInContext('Mesh.update();', ctx);
  const griefNearAfter=vm.runInContext('Mesh.griefAt(World.w/2+60, World.h/2)', ctx);
  assert(griefNearAfter>0.02, 'grief has diffused to a nearby cell after ticks passed ('+griefNearAfter.toFixed(3)+')');
})();

// ── Test 4: floating criminality rises for a baseline-0 agent under sustained local dissonance ──
(function testFloatingCriminality(){
  const ctx=buildContext();
  freshWorld(ctx,4);
  const result=vm.runInContext(`
    const a=new Agent(World.w/2, World.h/2, 0);
    a._criminalBaseline=0; a.criminality=0;
    Agents.push(a);
    for(let i=0;i<60;i++){ Mesh.writeField(a.x,a.y,'dissonance',0.6,200); Mesh.update(); a.update(); }
    a.criminality;
  `, ctx);
  assert(result>0, 'a baseline-0 agent drifted toward nonzero criminality under sustained local dissonance ('+result.toFixed(3)+')');
})();

// ── Test 5: dissolution signature — no grief write, delayed coherence surge ─
(function testDissolutionSignature(){
  const ctx=buildContext();
  freshWorld(ctx,5);
  vm.runInContext(`
    const a=new Agent(World.altar.x, World.altar.y, 0);
    Agents.push(a);
    World.judgeCriminal(a);
  `, ctx);
  const griefAtAltar=vm.runInContext('Mesh.griefAt(World.altar.x, World.altar.y)', ctx);
  const disAtAltar=vm.runInContext('Mesh.dissonanceAt(World.altar.x, World.altar.y)', ctx);
  assert(griefAtAltar<0.02, 'ceremonial dissolution wrote no grief at the Altar ('+griefAtAltar.toFixed(3)+')');
  assert(disAtAltar>0.05, 'ceremonial dissolution wrote an immediate dissonance-spike ('+disAtAltar.toFixed(3)+')');
  const pendingBefore=vm.runInContext('World._pendingPulses.length', ctx);
  assert(pendingBefore===1, 'a coherence-surge pulse was scheduled for later ('+pendingBefore+' pending)');
  const cohBefore=vm.runInContext('Mesh.coherenceAt(World.altar.x, World.altar.y)', ctx);
  for(let i=0;i<60;i++) vm.runInContext('World.tick++; World.update(); Mesh.update();', ctx);
  const cohAfter=vm.runInContext('Mesh.coherenceAt(World.altar.x, World.altar.y)', ctx);
  const pendingAfter=vm.runInContext('World._pendingPulses.length', ctx);
  assert(cohAfter>cohBefore, 'coherence rose at the Altar once the delayed surge fired ('+cohBefore.toFixed(3)+' -> '+cohAfter.toFixed(3)+')');
  assert(pendingAfter===0, 'the pending pulse was consumed after it fired');
})();

// ── Test 7: economy — deposit surplus into the settlement store, keep reserve ─
(function testDepositSurplus(){
  const ctx=buildContext();
  freshWorld(ctx,20);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const a=new Agent(g.x,g.y,0);
    a.inv.food=8; a.inv.wood=3; a.wealth=0;
    doDeposit(a,g);
    ({foodStock:g.stock.food, woodStock:g.stock.wood, agFood:a.inv.food, agWood:a.inv.wood, wealth:a.wealth});
  `, ctx);
  assert(r.foodStock===6 && r.agFood===2, 'deposited surplus food to the store, kept a reserve of 2 ('+r.foodStock+' stored / '+r.agFood+' kept)');
  assert(r.woodStock===2 && r.agWood===1, 'deposited surplus wood, kept a reserve of 1 ('+r.woodStock+' stored / '+r.agWood+' kept)');
  assert(r.wealth>0, 'contributing to the store earned a small stipend ('+r.wealth.toFixed(2)+')');
})();

// ── Test 8: prosperity rises with staffed jobs + stock, decays when idle ────
(function testProsperity(){
  const ctx=buildContext();
  freshWorld(ctx,21);
  vm.runInContext(`
    const g=World.gathers[0];
    const s=mkSite(g.x,g.y,'market',0); s.built=true; s.level=1; s.workers=[1,2];
    World.sites.push(s); g.stock.food=20;
  `, ctx);
  const p0=vm.runInContext('World.gathers[0].prosperity', ctx);
  for(let i=0;i<180;i++) vm.runInContext('World.update();', ctx); // 3 aggregation passes
  const p1=vm.runInContext('World.gathers[0].prosperity', ctx);
  assert(p1>p0, 'prosperity rose with staffed jobs + stock ('+p0.toFixed(4)+' -> '+p1.toFixed(4)+')');

  const ctx2=buildContext();
  freshWorld(ctx2,22);
  vm.runInContext('World.gathers[0].prosperity=0.5;', ctx2);
  for(let i=0;i<120;i++) vm.runInContext('World.update();', ctx2);
  const p2=vm.runInContext('World.gathers[0].prosperity', ctx2);
  assert(p2<0.5, 'prosperity decays when nothing is produced (0.5 -> '+p2.toFixed(4)+')');
})();

// ── Test 9: production chain — workshop refines stocked raws into goods ─────
(function testProductionChain(){
  const ctx=buildContext();
  freshWorld(ctx,30);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const st=mkSite(g.x,g.y,'workshop',0); st.built=true; st.level=1; st.effRate=0.2; st.workers=[1];
    World.sites.push(st);
    g.stock.wood=6; g.stock.stone=3;
    const a=new Agent(st.x,st.y,0); a.id=1; a.job={siteRef:st,startTick:0}; Agents.push(a);
    const task=BehaviorById['doJob'].make(a); a.task=task;
    for(let i=0;i<160;i++){ task._t=i; if(task.onTick) task.onTick(a); }
    ({goods:g.stock.goods, wood:g.stock.wood, stone:g.stock.stone});
  `, ctx);
  assert(r.goods>0, 'a staffed workshop refined stocked wood/stone into trade goods ('+r.goods+')');
  assert(r.wood<6 && r.stone<3, 'goods production debited the raw inputs (wood '+r.wood+', stone '+r.stone+')');
})();

// ── Test 10: granary rations hold winter food security above the control ────
(function testWinterRations(){
  const ctx=buildContext();
  freshWorld(ctx,31);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const gr=mkSite(g.x,g.y,'granary',0); gr.built=true; gr.level=1; gr.capacity=1;
    World.sites.push(gr);
    World.season=3; // winter
    g.stock.rations=10; g.stock.food=0; World.dayTick=59; World.update();
    const withRations=g.foodSec;
    g.stock.rations=0;  World.dayTick=59; World.update();
    const without=g.foodSec;
    ({withRations, without});
  `, ctx);
  assert(r.withRations>r.without, 'winter rations hold food security above the rationless case ('+r.withRations.toFixed(2)+' vs '+r.without.toFixed(2)+')');
})();

// ── Test 11: medicine revives a failing agent and grants old-age protection ─
(function testTakeMedicine(){
  const ctx=buildContext();
  freshWorld(ctx,32);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    g.stock.medicine=3;
    const a=new Agent(g.x,g.y,0); a.energy=5; a.hunger=90; Agents.push(a);
    const b=BehaviorById['takeMedicine'];
    const w=b.weight(a);
    const task=b.make(a); if(task) task.onArrive(a);
    ({weight:w, energy:a.energy, medicine:g.stock.medicine, medicated:a.medicated});
  `, ctx);
  assert(r.weight>0, 'a failing agent near medicine stock seeks a remedy (weight '+r.weight+')');
  assert(r.energy>5 && r.medicine===2, 'the remedy restored energy and consumed one dose ('+r.energy+' energy, '+r.medicine+' left)');
  assert(r.medicated>0, 'the remedy granted temporary old-age protection ('+r.medicated+')');
})();

// ── Test 12: wages flow from the settlement treasury to the worker ─────────
(function testWages(){
  const ctx=buildContext();
  freshWorld(ctx,40);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const st=mkSite(g.x,g.y,'loreHall',0); st.built=true; st.level=1; st.effRate=0.1; st.workers=[1];
    World.sites.push(st);
    g.treasury=10;
    const a=new Agent(st.x,st.y,0); a.id=1; a.wealth=0; a.job={siteRef:st,startTick:0}; Agents.push(a);
    const task=BehaviorById['doJob'].make(a); a.task=task;
    for(let i=0;i<240;i++){ task._t=i; if(task.onTick) task.onTick(a); }  // wage tick at _t%80 -> 0,80,160
    ({wealth:a.wealth, treasury:g.treasury});
  `, ctx);
  assert(r.wealth===3 && r.treasury===7, 'wages moved coin from treasury to worker (wealth '+r.wealth+', treasury '+r.treasury+')');
})();

// ── Test 13: a life's wealth is inherited by the bonded partner ────────────
(function testInheritance(){
  const ctx=buildContext();
  freshWorld(ctx,41);
  const r=vm.runInContext(`
    const a=new Agent(World.w/2,World.h/2,0); a.id=1; a.wealth=7;
    const b=new Agent(World.w/2+10,World.h/2,0); b.id=2; b.wealth=0;
    a.bond=2; b.bond=1; Agents.push(a); Agents.push(b);
    a.die();
    ({heirWealth:b.wealth, deadWealth:a.wealth});
  `, ctx);
  assert(r.heirWealth===7 && r.deadWealth===0, 'a bonded partner inherited the deceased wealth (heir '+r.heirWealth+')');
})();

// ── Test 14: stark wealth inequality raises local fragmentation ────────────
(function testInequalityDissonance(){
  const ctx=buildContext();
  freshWorld(ctx,42);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    for(let i=0;i<5;i++){ const a=new Agent(g.x+(i-2)*4,g.y,0); a.wealth=(i===0?40:0); Agents.push(a); }
    const before=Mesh.dissonanceAt(g.x,g.y);
    for(let i=0;i<200;i++) World.update();
    ({before, after:Mesh.dissonanceAt(g.x,g.y)});
  `, ctx);
  assert(r.after>r.before+0.02, 'stark wealth inequality raised local fragmentation ('+r.before.toFixed(3)+' -> '+r.after.toFixed(3)+')');
})();

// ── Test 15: a caravan carries goods to another market and records a route ──
(function testCaravan(){
  const ctx=buildContext();
  freshWorld(ctx,50);
  const r=vm.runInContext(`
    const g0=World.gathers[0], g1=World.gathers[1];
    for(const gi of [0,1]){ const m=mkSite(World.gathers[gi].x,World.gathers[gi].y,'market',gi); m.built=true; m.level=1; m.workers=[99]; World.sites.push(m); }
    g0.stock.goods=10;
    const a=new Agent(g0.x,g0.y,1); Agents.push(a);
    const ok=beginCaravan(a,0,1);
    let ticks=0; while(a.caravan && ticks<20000){ a.update(); ticks++; }
    ({ok, goodsAtB:g1.stock.goods||0, routes:World.routes.length, strength:World.routes[0]?World.routes[0].strength:0, wealth:a.wealth});
  `, ctx);
  assert(r.ok, 'caravan loaded surplus and set out');
  assert(r.goodsAtB>0, 'caravan delivered goods to the destination settlement ('+r.goodsAtB+')');
  assert(r.routes===1 && r.strength===1, 'a trade route was recorded with strength 1 (routes '+r.routes+')');
  assert(r.wealth>0, 'the trader came home richer ('+r.wealth+')');
})();

// ── Test 16: highway robbery loots a caravan and shatters its route ─────────
(function testHighwayRobbery(){
  const ctx=buildContext();
  freshWorld(ctx,51);
  const r=vm.runInContext(`
    const g0=World.gathers[0];
    g0.stock.goods=10;
    const a=new Agent(g0.x,g0.y,1); Agents.push(a);
    beginCaravan(a,0,1);
    World.recordRoute(0,1,'land',5); World.recordRoute(0,1,'land',5);
    const strBefore=World.routes[0].strength;
    const thief=new Agent(a.x,a.y,2); thief.criminality=1; Agents.push(thief);
    const task=BehaviorById['steal'].make(thief); thief.task=task; task.targetAgent=a;
    task.onArrive(thief);
    ({hadCaravan:!!a.caravan, thiefGoods:(thief.inv.goods||0), strBefore, strAfter:World.routes[0].strength, wanted:thief.wanted});
  `, ctx);
  assert(!r.hadCaravan, 'highway robbery ended the caravan run');
  assert(r.thiefGoods>0, 'the robber looted the caravan cargo ('+r.thiefGoods+')');
  assert(r.strAfter<r.strBefore, 'the robbed route lost strength ('+r.strBefore+' -> '+r.strAfter+')');
})();

// ── Test 17: the dominant faction's structures set a settlement's character ─
(function testSpecialization(){
  const ctx=buildContext();
  freshWorld(ctx,60);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    for(let i=0;i<3;i++){ const s=mkSite(g.x,g.y,'workshop',0); s.built=true; s.level=1; s.faction=2; World.sites.push(s); }
    const c=mkSite(g.x,g.y,'farm',0); c.built=true; c.level=1; c.faction=0; World.sites.push(c);
    World.dayTick=59; World.update();
    ({spec:g.spec, specFaction:g.specFaction});
  `, ctx);
  assert(r.spec==='FORGEHOLD' && r.specFaction===2, 'a settlement built mostly by Forgers becomes a FORGEHOLD ('+r.spec+')');
})();

// ── Test 18: faction doctrine tilts production output ──────────────────────
(function testDoctrineOutput(){
  function goodsFrom(faction){
    const ctx=buildContext();
    freshWorld(ctx,61);
    return vm.runInContext(`
      const g=World.gathers[0];
      const st=mkSite(g.x,g.y,'workshop',0); st.built=true; st.level=1; st.workers=[1]; World.sites.push(st);
      g.stock.wood=100; g.stock.stone=100;
      const a=new Agent(st.x,st.y,${faction}); a.id=1; a.job={siteRef:st,startTick:0}; Agents.push(a);
      const task=BehaviorById['doJob'].make(a); a.task=task;
      for(let i=0;i<500;i++){ task._t=i; if(task.onTick) task.onTick(a); }
      g.stock.goods;
    `, ctx);
  }
  const forger=goodsFrom(2), cultivator=goodsFrom(0);
  assert(forger>cultivator, 'a Forger refines more goods per shift than a Cultivator ('+forger+' vs '+cultivator+')');
})();

// ── Test 19: a prosperous Stone Town unlocks a monument site ───────────────
(function testMonumentUnlock(){
  const ctx=buildContext();
  freshWorld(ctx,70);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    g.tier=5; g.prosperity=0.5;
    World.checkStructureUnlocks();
    World.sites.some(s=>s.type==='monument'&&s.gather===0);
  `, ctx);
  assert(r===true, 'a prosperous Stone Town unlocked a monument build site');
})();

// ── Test 20: offering beauty completes a monument (beauty finally has a sink)─
(function testMonumentBuild(){
  const ctx=buildContext();
  freshWorld(ctx,71);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const mon=mkSite(g.x,g.y,'monument',0); World.sites.push(mon);
    mon.matsWood=mon.needWood; mon.matsStone=mon.needStone;
    const a=new Agent(g.x,g.y,3); a.inv.beauty=50; Agents.push(a);
    const w=BehaviorById['offerBeauty'].weight(a);
    BehaviorById['offerBeauty'].make(a).onArrive(a);
    const beautyFilled=mon.matsBeauty;        // capture before construction resets it for the next level
    const ready=siteMatsReady(mon);
    const ct=BehaviorById['construct'].make(a);
    for(let i=0;i<400 && mon.level<1;i++){ ct.onTick(a); }
    ({weight:w, matsBeauty:beautyFilled, ready, built:mon.built, level:mon.level});
  `, ctx);
  assert(r.weight>0, 'an agent carrying beauty seeks a monument to offer it to');
  assert(r.matsBeauty>=10 && r.ready, 'offering beauty met the monument beauty requirement ('+r.matsBeauty+')');
  assert(r.built && r.level>=1, 'the monument was raised once all materials were in (level '+r.level+')');
})();

// ── Test 21: monument + wonder + full economy reaches the BEACON tier ──────
(function testBeaconTier(){
  const ctx=buildContext();
  freshWorld(ctx,72);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const req={hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1, barracks:1, temple:1, mine:1, harbor:1, tavern:1, quarry:1, monument:1, wonder:1};
    for(const type in req){ for(let i=0;i<req[type];i++){ const s=mkSite(g.x,g.y,type,0); s.built=true; s.level=1; World.sites.push(s); } }
    const t=World.tierOf(0);
    ({tier:t, isLast:t===SETTLEMENT_TIERS.length-1, name:SETTLEMENT_TIERS[t].name});
  `, ctx);
  assert(r.isLast && r.name==='BEACON', 'a settlement crowned by a monument and the Wonder reaches BEACON (tier '+r.tier+' '+r.name+')');
})();

// ── Test 22: being robbed drifts a soul toward ORDER ───────────────────────
(function testIdealDriftOrder(){
  const ctx=buildContext();
  freshWorld(ctx,80);
  const r=vm.runInContext(`
    const a=new Agent(100,100,0); a.inv.food=5; a.inv.wood=5;
    const thief=new Agent(100,100,0); thief.criminality=1;
    Agents.push(a); Agents.push(thief);
    const before=a.ideals.order;
    const task=BehaviorById['steal'].make(thief); thief.task=task; task.targetAgent=a; task.onArrive(thief);
    ({before, after:a.ideals.order});
  `, ctx);
  assert(r.after>r.before, 'being robbed drifts a soul toward ORDER ('+r.before.toFixed(3)+' -> '+r.after.toFixed(3)+')');
})();

// ── Test 23: worship drifts a soul toward FAITH ────────────────────────────
(function testIdealDriftFaith(){
  const ctx=buildContext();
  freshWorld(ctx,81);
  const r=vm.runInContext(`
    const a=new Agent(World.altar.x,World.altar.y,0); Agents.push(a);
    const before=a.ideals.faith;
    const task=BehaviorById['worship'].make(a); a.task=task; task._t=50; task.onTick(a);
    ({before, after:a.ideals.faith});
  `, ctx);
  assert(r.after>r.before, 'worship drifts a soul toward FAITH ('+r.before.toFixed(3)+' -> '+r.after.toFixed(3)+')');
})();

// ── Test 24: faction temperament seeds different starting beliefs ───────────
(function testIdealBias(){
  const ctx=buildContext();
  freshWorld(ctx,82);
  const r=vm.runInContext(`
    let w=0,c=0; const N=200;
    for(let i=0;i<N;i++){ w+=new Agent(0,0,1).ideals.freedom; c+=new Agent(0,0,0).ideals.freedom; }
    ({wayfarer:w/N, cultivator:c/N});
  `, ctx);
  assert(r.wayfarer>r.cultivator, 'Wayfarers begin freer-spirited than Cultivators ('+r.wayfarer.toFixed(2)+' vs '+r.cultivator.toFixed(2)+')');
})();

// ── Test 25: beliefs steer choice (idealWeight) ────────────────────────────
(function testIdealWeight(){
  const ctx=buildContext();
  freshWorld(ctx,83);
  const r=vm.runInContext(`
    const orderly={ideals:{order:1,communion:0,faith:0,material:0,freedom:0}};
    const free={ideals:{order:0,communion:0,faith:0,material:0,freedom:1}};
    const justice={cat:'justice',id:'subdue'}, crime={cat:'crime',id:'steal'}, explore={cat:'explore',id:'explore'};
    ({oJ:idealWeight(orderly,justice), fJ:idealWeight(free,justice),
      oC:idealWeight(orderly,crime), fC:idealWeight(free,crime),
      oE:idealWeight(orderly,explore), fE:idealWeight(free,explore)});
  `, ctx);
  assert(r.oJ>r.fJ, 'an order-believer weights justice higher than a freedom-believer');
  assert(r.oC<r.fC, 'an order-believer weights crime lower than a freedom-believer');
  assert(r.fE>r.oE, 'a freedom-believer weights exploration higher');
})();

// ── Test 26: ideal drift clamps to [0,1] ───────────────────────────────────
(function testIdealClamp(){
  const ctx=buildContext();
  freshWorld(ctx,84);
  const r=vm.runInContext(`
    const a=new Agent(0,0,0);
    for(let i=0;i<200;i++){ a.driftIdeal('faith',0.1); a.driftIdeal('order',-0.1); }
    ({faith:a.ideals.faith, order:a.ideals.order});
  `, ctx);
  assert(r.faith===1 && r.order===0, 'ideals clamp to [0,1] (faith '+r.faith+', order '+r.order+')');
})();

// ── Test 27: a settlement of communion-believers becomes COMMUNION ─────────
(function testCultureCommunion(){
  const ctx=buildContext();
  freshWorld(ctx,90);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    for(let i=0;i<8;i++){ const a=new Agent(g.x,g.y,3); a.ideals={order:0.3,communion:0.9,faith:0.4,material:0.3,freedom:0.3}; Agents.push(a); }
    for(let p=0;p<3;p++){ World.dayTick=59; World.update(); }
    g.fate;
  `, ctx);
  assert(r==='COMMUNION', 'a settlement of communion-believers becomes COMMUNION ('+r+')');
})();

// ── Test 28: fate is never latched — shifting the souls flips it (reversible)─
(function testFateReversible(){
  const ctx=buildContext();
  freshWorld(ctx,91);
  const r=vm.runInContext(`
    const g=World.gathers[0]; const souls=[];
    for(let i=0;i<8;i++){ const a=new Agent(g.x,g.y,3); a.ideals={order:0.3,communion:0.3,faith:0.9,material:0.3,freedom:0.3}; Agents.push(a); souls.push(a); }
    for(let p=0;p<3;p++){ World.dayTick=59; World.update(); }
    const first=g.fate;
    for(const a of souls) a.ideals={order:0.9,communion:0.3,faith:0.2,material:0.3,freedom:0.3};
    for(let p=0;p<4;p++){ World.dayTick=59; World.update(); }
    ({first, second:g.fate});
  `, ctx);
  assert(r.first==='DEVOTION', 'high-faith souls made the settlement DEVOTION ('+r.first+')');
  assert(r.second==='DOMINION' && r.second!==r.first, 'shifting the souls flipped the fate — never latched ('+r.first+' -> '+r.second+')');
})();

// ── Test 29: collapse makes RUIN regardless of what the souls believe ──────
(function testRuinFate(){
  const ctx=buildContext();
  freshWorld(ctx,92);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    for(let i=0;i<6;i++) Agents.push(new Agent(g.x,g.y,0));
    Mesh.writeField(g.x,g.y,'dissonance',0.8,300);
    World.dayTick=59; World.update();
    Mesh.writeField(g.x,g.y,'dissonance',0.8,300);
    World.dayTick=59; World.update();
    ({fate:g.fate, food:g.foodSec, prosp:g.prosperity, dis:Mesh.dissonanceAt(g.x,g.y)});
  `, ctx);
  assert(r.fate==='RUIN', 'famine + fragmentation + poverty makes RUIN regardless of ideals ('+r.fate+' | food '+r.food.toFixed(2)+' dis '+r.dis.toFixed(2)+')');
})();

// ── Test 30: the world Age reflects the majority (characterful) fate ───────
(function testWorldAge(){
  const ctx=buildContext();
  freshWorld(ctx,93);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    for(let i=0;i<8;i++){ const a=new Agent(g.x,g.y,3); a.ideals={order:0.3,communion:0.9,faith:0.3,material:0.3,freedom:0.3}; Agents.push(a); }
    for(let p=0;p<3;p++){ World.dayTick=59; World.update(); }
    World.age;
  `, ctx);
  assert(r==='AN AGE OF COMMUNION', 'the world Age reflects the majority fate ('+r+')');
})();

// ── Test 31: a culture that believes in ORDER polices crime harder (law) ───
(function testOrderLaw(){
  const ctx=buildContext();
  freshWorld(ctx,94);
  const r=vm.runInContext(`
    const g0=World.gathers[0], g1=World.gathers[1];
    g0.culture={order:0.9,communion:0.3,faith:0.3,material:0.3,freedom:0.3};
    g1.culture={order:0.1,communion:0.3,faith:0.3,material:0.3,freedom:0.3};
    function thiefWeightAt(g){ const t=new Agent(g.x,g.y,0); t.criminality=1; const v=new Agent(g.x,g.y,0); v.inv.food=5; v.inv.wood=5; Agents.push(t); Agents.push(v); return BehaviorById['steal'].weight(t); }
    ({wOrder:thiefWeightAt(g0), wFree:thiefWeightAt(g1)});
  `, ctx);
  assert(r.wOrder<r.wFree, 'a culture that believes in order suppresses theft more ('+r.wOrder.toFixed(1)+' vs '+r.wFree.toFixed(1)+')');
})();

// ── Test 32: a communion culture redistributes its treasury to the poorest ──
(function testRedistribution(){
  const ctx=buildContext();
  freshWorld(ctx,95);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const poor=new Agent(g.x,g.y,3); poor.wealth=0; poor.ideals={order:0.3,communion:0.9,faith:0.3,material:0.3,freedom:0.3}; Agents.push(poor);
    for(let i=0;i<5;i++){ const a=new Agent(g.x,g.y,3); a.wealth=5; a.ideals={order:0.3,communion:0.9,faith:0.3,material:0.3,freedom:0.3}; Agents.push(a); }
    g.treasury=20;
    const before=poor.wealth; World.dayTick=59; World.update();
    ({before, after:poor.wealth});
  `, ctx);
  assert(r.after>r.before, 'a communion culture shares its treasury with its poorest ('+r.before+' -> '+r.after+')');
})();

// ── Test 33: a prophet pulls nearby souls toward FAITH (a belief movement) ──
(function testProphet(){
  const ctx=buildContext();
  freshWorld(ctx,96);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    g.culture={order:0.3,communion:0.3,faith:0.7,material:0.3,freedom:0.3};
    const prophet=new Agent(g.x,g.y,3); prophet.ideals={order:0.3,communion:0.3,faith:0.9,material:0.3,freedom:0.3};
    const listener=new Agent(g.x+50,g.y,0); listener.ideals={order:0.5,communion:0.5,faith:0.3,material:0.5,freedom:0.5};
    Agents.push(prophet); Agents.push(listener);
    const w=BehaviorById['prophesy'].weight(prophet);
    const before=listener.ideals.faith;
    const task=BehaviorById['prophesy'].make(prophet); prophet.task=task; task._t=30; task.onTick(prophet);
    ({weight:w, before, after:listener.ideals.faith});
  `, ctx);
  assert(r.weight>0, 'a faithful soul in a faithful settlement prophesies');
  assert(r.after>r.before, 'the prophet pulls a nearby soul toward FAITH ('+r.before.toFixed(2)+' -> '+r.after.toFixed(2)+')');
})();

// ── Test 34: answering the call — an elective, celebrated dissolution ──────
(function testAnsweredCall(){
  const ctx=buildContext();
  freshWorld(ctx,97);
  const r=vm.runInContext(`
    const a=new Agent(World.altar.x,World.altar.y,3); a.ideals={order:0.3,communion:0.3,faith:0.9,material:0.3,freedom:0.3};
    Agents.push(a);
    BehaviorById['answerTheCall'].make(a).onArrive(a);
    ({grief:Mesh.griefAt(World.altar.x,World.altar.y), dead:!!a.dead, answered:World.altar.answered, dissolving:!!a._dissolving});
  `, ctx);
  assert(r.grief<0.02 && r.dead, 'answering the call dissolves the soul with NO grief cascade');
  assert(r.answered===1 && r.dissolving, 'the chosen dissolution was recorded as ceremonial');
})();

// ── Test 35: a held fate unlocks its unique capstone ──────────────────────
(function testDestinyUnlock(){
  const ctx=buildContext();
  freshWorld(ctx,100);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    g.fate='DOMINION'; g._destinyFateTracked='DOMINION'; g.destinyTicks=10;
    World.checkStructureUnlocks();
    World.sites.some(s=>s.type==='citadel'&&s.gather===0);
  `, ctx);
  assert(r===true, 'a settlement that held DOMINION unlocks a Citadel');
})();

// ── Test 36: raising a capstone crystallizes its destiny + prosperity floor ─
(function testDestinyBuild(){
  const ctx=buildContext();
  freshWorld(ctx,101);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const cit=mkSite(g.x,g.y,'citadel',0); cit.matsWood=cit.needWood; cit.matsStone=cit.needStone; World.sites.push(cit);
    const a=new Agent(g.x,g.y,2); Agents.push(a);
    const ct=BehaviorById['construct'].make(a);
    for(let i=0;i<600 && cit.level<1;i++){ ct.onTick(a); }
    ({built:cit.built, destiny:g.destiny, destinyFate:g.destinyFate, floor:g.destinyProsperity});
  `, ctx);
  assert(r.built && r.destiny==='THE CITADEL', 'raising a Citadel crystallizes THE CITADEL destiny ('+r.destiny+')');
  assert(r.destinyFate==='DOMINION' && r.floor>0, 'the destiny records its fate and floors prosperity');
})();

// ── Test 37: a destiny is LOST when the culture drifts off its fate ────────
(function testDestinyLost(){
  const ctx=buildContext();
  freshWorld(ctx,102);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    g.destiny='THE CITADEL'; g.destinyFate='DOMINION'; g.destinyProsperity=0.6;
    for(let i=0;i<8;i++){ const a=new Agent(g.x,g.y,3); a.ideals={order:0.2,communion:0.9,faith:0.3,material:0.3,freedom:0.3}; Agents.push(a); }
    for(let p=0;p<4;p++){ World.dayTick=59; World.update(); }
    ({fate:g.fate, destiny:g.destiny});
  `, ctx);
  assert(r.fate==='COMMUNION' && !r.destiny, 'a destiny is lost when the culture drifts off its fate — never permanent');
})();

// ── Test 38: a Citadel makes order near-absolute ───────────────────────────
(function testCitadelLaw(){
  const ctx=buildContext();
  freshWorld(ctx,103);
  const r=vm.runInContext(`
    const g0=World.gathers[0], g1=World.gathers[1];
    g0.culture={order:0.5,communion:0.3,faith:0.3,material:0.3,freedom:0.3}; g0.destiny='THE CITADEL';
    g1.culture={order:0.5,communion:0.3,faith:0.3,material:0.3,freedom:0.3};
    function w(g){ const t=new Agent(g.x,g.y,0); t.criminality=1; const v=new Agent(g.x,g.y,0); v.inv.food=5; v.inv.wood=5; Agents.push(t); Agents.push(v); return BehaviorById['steal'].weight(t); }
    ({citadel:w(g0), plain:w(g1)});
  `, ctx);
  assert(r.citadel<r.plain, 'a Citadel suppresses theft harder than an equal settlement without one ('+r.citadel.toFixed(1)+' vs '+r.plain.toFixed(1)+')');
})();

// ── Test 39: sustained RUIN crumbles a settlement's structures ─────────────
(function testRuinDecay(){
  const ctx=buildContext();
  freshWorld(ctx,104);
  const r=vm.runInContext(`
    const g=World.gathers[0];
    const m=mkSite(g.x,g.y,'market',0); m.built=true; m.level=2; World.sites.push(m);
    for(let i=0;i<6;i++) Agents.push(new Agent(g.x,g.y,0));
    const before=m.level;
    for(let p=0;p<20;p++){ Mesh.writeField(g.x,g.y,'dissonance',0.9,300); World.dayTick=59; World.update(); }
    ({before, after:m.level, fate:g.fate});
  `, ctx);
  assert(r.fate==='RUIN' && r.after<r.before, 'a settlement in sustained RUIN crumbles its structures (lvl '+r.before+' -> '+r.after+')');
})();

// ── Test 6: multi-seed long-run regression — no crashes across full systems ─
(function testRegression(){
  for(const seed of [10,11,12]){
    const ctx=buildContext();
    freshWorld(ctx,seed);
    vm.runInContext('spawnAgents(40);', ctx);
    try{
      vm.runInContext(`
        for(let i=0;i<2000;i++){
          World.tick++;
          World.update();
          Underground.update();
          Mesh.update();
          updateAgents();
          Events.update();
        }
      `, ctx);
      const pop=vm.runInContext('Agents.length', ctx);
      assert(pop>=0, 'seed '+seed+' ran 2000 ticks with 40 agents with no exceptions (pop='+pop+')');
    } catch(e){
      assert(false, 'seed '+seed+' threw during long run: '+e.message);
    }
  }
})();
