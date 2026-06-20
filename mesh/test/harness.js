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
