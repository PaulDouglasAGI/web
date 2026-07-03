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
