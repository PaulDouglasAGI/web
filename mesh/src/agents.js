/* agents.js — agent class, weighted desire system, movement, lifecycle */
'use strict';

const Agents=[];
const Marks=[];       // landscape marks {x,y,type,faction,age}
const Sounds=[];      // music waves {x,y,r,life}
const Exchanges=[];   // trade particles {x,y,tx,ty,life}
const CrimeLog=[];    // rolling log of theft/murder/justice events, world-readable
function logCrime(msg,faction){ CrimeLog.push(msg); if(CrimeLog.length>20) CrimeLog.shift(); World.totalCrimes=(World.totalCrimes||0)+1; if(faction!=null) World.crimesByFaction[faction]=(World.crimesByFaction[faction]||0)+1; }
function logJustice(msg){ CrimeLog.push(msg); if(CrimeLog.length>20) CrimeLog.shift(); }
let _agentId=1;

const NAME_A=['Su','Ka','Mi','Ev','Ar','Ny','Ol','Ta','Wr','Fen','Lir','Mor','Sel','Ash','Ber','Cael','Dun','Ro','Vey','Ilo','Quen','Bryn','Nim','Oro'];
const NAME_B=['ren','la','dor','wyn','eth','is','ka','mar','ven','os','ya','rin','del','an','ux','ele','aro','iss','und','ora','ix','ael'];
function genName(){ return NAME_A[(Math.random()*NAME_A.length)|0]+NAME_B[(Math.random()*NAME_B.length)|0]; }

const SKIN_TONES=['#e8b894','#d49e6e','#c98f5e','#a06a40','#8d5a3c','#5c3a24','#f0c9a0'];
const HAIR_COLORS=['#2b1d12','#4a2f1d','#6b4423','#1a1a1a','#7a5230','#c9a35a','#3a2418'];

class Agent{
  constructor(x,y,faction){
    this.id=_agentId++;
    this.name=genName();
    this.faction=faction;
    this.age=4+Math.random()*40;          // in "days"
    this.x=x; this.y=y; this.vx=0; this.vy=0;
    this.energy=60+Math.random()*40;
    this.hunger=Math.random()*40;
    this.social=Math.random()*60;
    this.joy=0.4+Math.random()*0.2;
    this.grieving=0;
    this.overwhelmed=0;
    this.inv=newInventory();
    this.inv.food=Math.random()<0.5?1:0;
    this.wealth=0;                         // personal coin — earned as wages / deposits, spent in taverns & commissions (S1/S4)
    this.medicated=0;                      // ticks of remaining protection from an old-age death, granted by medicine (S2)
    this.skills=1+((Math.random()*3)|0);
    this.meshSensitivity=0.4+Math.random()*0.6;
    this.bond=null;
    this.memory=[];
    this.task=null;
    this.reeval=0;
    this.meshMuted=0;
    this.driftScore=[0,0,0,0];
    this.lastCat=null; this.catStreak=0; this.lastBehaviorId=null;   // commitment/memory: see chooseTask()
    this.speed=(0.9+Math.random()*0.4)*(faction===1?1.25:1);
    this.skin=SKIN_TONES[(Math.random()*SKIN_TONES.length)|0];
    this.hair=HAIR_COLORS[(Math.random()*HAIR_COLORS.length)|0];
    this.walkPhase=Math.random()*Math.PI*2;
    this._stuckTicks=0; this._lastDist=Infinity;
    this.job=null;
    // a small fraction of agents are predisposed toward theft/violence — hidden until they act on it.
    // criminality itself floats: sustained local dissonance can pull *any* agent toward crime.
    this._criminalBaseline=Math.random()<0.06 ? 0.35+Math.random()*0.65 : 0;
    this.criminality=this._criminalBaseline;
    this.wanted=false; this.crime=null; this.crimeTick=0; this.captured=false;
    this._dissolving=false;
    this.underground=false; this.mineJob=null;
  }

  remember(s){ this.memory.push(s); if(this.memory.length>6) this.memory.shift(); }

  emitExchange(other){ Exchanges.push({x:this.x,y:this.y,tx:other.x,ty:other.y,life:1}); }
  emitSound(){ Sounds.push({x:this.x,y:this.y,r:4,life:1}); }
  leaveMark(type){ Marks.push({x:this.x,y:this.y,type,faction:this.faction,age:0}); if(Marks.length>240) Marks.shift(); }

  driftFaction(){
    // shift toward the faction of nearby agents after a "powerful experience"
    const counts=[0,0,0,0];
    for(const o of Agents){ if(o===this || o.underground) continue; if(dist2(this.x,this.y,o.x,o.y)<240*240) counts[o.faction]++; }
    let best=this.faction,bv=-1;
    for(let f=0;f<4;f++){ if(f!==this.faction && counts[f]>bv){ bv=counts[f]; best=f; } }
    if(bv>2 && Math.random()<0.5){ this.faction=best; this.remember('drifted toward '+Factions[best].name.toLowerCase()); this.speed=(0.9+Math.random()*0.4)*(best===1?1.25:1); }
  }

  // ── desire scoring ──────────────────────────────────────────────────────--
  chooseTask(){
    if(this.captured){
      this.task={ label:'being led to the altar', glyph:'⛓', cat:'justice', pose:'work',
        target:{x:World.altar.x,y:World.altar.y}, arrive:24, dur:999999,
        onArrive:(ag)=>{ World.judgeCriminal(ag); } };
      this.task._t=0;
      return;
    }
    const f=this.faction;
    const day=World.daylight();               // 0 night .. 1 noon
    const night=World.isNight();
    const felt=this.meshMuted>0?0.5:Mesh.feltAt(this.x,this.y);
    const scored=[];
    for(const b of Behaviors){
      let w=b.weight(this);
      if(w<=0) continue;
      w*=factionWeight(f,b.cat);
      // time-of-day modifiers
      if(b.cat==='inner'&&night) w*=1.6;
      if(b.cat==='explore'&&night) w*=0.4;
      if((b.cat==='social'||b.cat==='creative')&&night) w*=1.25;
      if(b.cat==='survival'&&day>0.4) w*=1.2;
      // season modifiers
      if(World.season===3){ if(b.cat==='survival') w*=1.5; if(b.cat==='explore') w*=0.6; }
      if(World.season===0&&b.cat==='creative') w*=1.2;
      // mesh field modifiers — sampled at this agent's location, not the global average
      if(felt>0.65 && (b.cat==='creative'||b.cat==='social')) w*=1.4;
      if(felt<0.4 && b.cat==='social') w*=0.7;
      if(Mesh.griefAt(this.x,this.y)>0.3 && b.cat==='social') w*=1.3;
      const localCoh=Mesh.coherenceAt(this.x,this.y), localDis=Mesh.dissonanceAt(this.x,this.y);
      if(localCoh>0.65 && (b.cat==='social'||b.cat==='trade'||b.cat==='creative')) w*=1.2;
      if(localDis>0.4 && b.cat==='survival') w*=1.15;
      // personal overwhelm
      if(this.overwhelmed>0.5 && b.cat!=='inner') w*=0.5;
      // commitment: an agent who just settled into a category sticks with it through the next
      // reroll instead of a clean-slate coin flip — without this, every task-end looks like
      // aimless flip-flopping even when the same need (e.g. hunger) is still driving them.
      // (tried adding a streak-fatigue penalty on top of this to force variety after a few reps,
      // but measured it actually *increasing* total category switches — it cut off long
      // need-driven runs before the need was resolved, so agents got yanked off, then immediately
      // pulled right back. needs-driven persistence should run its course; dropped that half.)
      if(b.cat===this.lastCat && this.catStreak<2) w*=1.4;
      // short-term memory: the exact same behavior just played out — even while staying in the
      // same category, doing the *identical* thing again right away (wander, then wander to
      // another spot, then wander again) reads as a mindless loop rather than a varied sequence
      // of choices, so nudge toward a different behavior within that category instead
      if(b.id===this.lastBehaviorId) w*=0.6;
      // noise so they feel alive
      w*=0.55+Math.random()*0.9;
      scored.push({b,w});
    }
    let chosenId=null;
    if(!scored.length){ this.task=this.fallback(); }
    else {
      scored.sort((p,q)=>q.w-p.w);
      const top=scored.slice(0,5);
      let sum=0; for(const s of top) sum+=s.w;
      let r=Math.random()*sum, chosen=top[0];
      for(const s of top){ r-=s.w; if(r<=0){ chosen=s; break; } }
      const task=chosen.b.make(this);
      this.task=task||this.fallback();
      chosenId=chosen.b.id;
    }
    if(this.task){
      this.task._t=0;
      const cat=this.task.cat;
      this.catStreak=(cat===this.lastCat)?this.catStreak+1:1;
      this.lastCat=cat;
      this.lastBehaviorId=chosenId;
    }
  }
  fallback(){ const p=wanderPoint(this,200); const t=gotoPoint(this,'wandering','~','inner',p.x,p.y,80); t._t=0; return t; }

  // nearest settlement's granary food-security / hut rest-bonus auras (0 / 1 if none built yet)
  settlementBonus(){
    const g=World.nearestOf(World.gathers,this.x,this.y);
    return g?{foodSec:g.foodSec||0,restMult:g.restMult||1,tavernBonus:g.tavernBonus||0}:{foodSec:0,restMult:1,tavernBonus:0};
  }

  // ── per-tick update ─────────────────────────────────────────────────────--
  update(){
    // an agent down in the mine runs a small self-contained loop instead of the
    // normal weighted Behaviors system — the cave isn't wired into chooseTask's
    // surface-only node/site lookups, and the trip is short and bounded anyway
    if(this.underground){ this.updateUnderground(); return; }
    // a caravan runner likewise follows a self-contained multi-leg surface trip
    // (mirrors the mine's state-machine pattern) rather than the task system
    if(this.caravan){ this.updateCaravan(); return; }
    // needs — a granary's food-security aura slows hunger growth for everyone near it
    const bonus=this.settlementBonus();
    this.hunger=Math.min(100,this.hunger+Math.max(0.004,0.012-bonus.foodSec*0.0015));
    this.social=Math.min(100,this.social+0.01+bonus.tavernBonus*0.02);
    // criminality floats with the local field — sustained dissonance can pull anyone toward crime
    this.criminality=Math.min(1,this._criminalBaseline + Mesh.dissonanceAt(this.x,this.y)*0.4);
    if(this.meshMuted>0) this.meshMuted--;
    // mesh overwhelm
    if(this.meshMuted<=0) this.overwhelmed=Math.min(1,this.overwhelmed + (Mesh.noise*this.meshSensitivity-0.35)*0.004);
    else this.overwhelmed=Math.max(0,this.overwhelmed-0.004);
    this.joy=Math.max(0,Math.min(1, this.joy + (Mesh.resonance-0.5)*0.002 - (this.hunger>70?0.002:0)));
    if(this.hunger>92||this.energy<4){ this.joy=Math.max(0,this.joy-0.003); }

    // aging & mortality — softened: dying of old age stays rare, and starvation/exhaustion
    // is caught by the emergency rest override below before energy can spiral this low
    this.age+=1/World.dayLen;
    // medicine (S2) staves off the old-age death roll while it lasts
    if(this.medicated>0) this.medicated--;
    // a captured criminal's fate is the Altar's to decide, not exhaustion en route
    const oldAge = this.age>60 && this.medicated<=0 && Math.random()<0.000018*(this.age-55);
    if(!this.captured && (oldAge || this.energy<-30)){ this.die(); return; }

    // emergency override: force a re-roll toward rest/sleep before energy bottoms out,
    // rather than letting the weighted system possibly keep grinding on something else
    if(this.energy<8 && this.task && this.task.label!=='resting' && this.task.label!=='sleeping') this.task=null;

    // once tenure is met, a small per-tick chance to step down from a job and free the
    // slot for new applicants — a soft decay valve rather than an instant kick, and only
    // when not actively mid-shift so a working agent isn't yanked off their own task
    if(this.job && World.tick-this.job.startTick>=MIN_TENURE_TICKS && !(this.task&&this.task.isJobTask) && Math.random()<0.002){
      const st=this.job.siteRef;
      if(st&&st.workers){ const idx=st.workers.indexOf(this.id); if(idx>=0) st.workers.splice(idx,1); }
      this.job=null;
    }

    // pick a task if none
    if(!this.task){ this.chooseTask(); }
    const t=this.task;

    // movement toward target
    if(t.targetAgent){ if(t.targetAgent.dead){ this.task=null; return; } t.target.x=t.targetAgent.x; t.target.y=t.targetAgent.y; }
    if(t.animal){
      if(!t.animal.alive){ this.task=null; return; }
      if(t._arrived && dist2(this.x,this.y,t.animal.x,t.animal.y)>(t.arrive||14)*(t.arrive||14)*2.2) t._arrived=false;
    }
    if(t.target && !t._arrived){
      const dx=t.target.x-this.x, dy=t.target.y-this.y;
      const d=Math.hypot(dx,dy);
      if(d<(t.arrive||14)){ t._arrived=true; if(t.onArrive) t.onArrive(this); this._stuckTicks=0; this._lastDist=Infinity; }
      else {
        const sp=this.speed*(0.6+this.energy/200);
        this.vx+=(dx/d)*sp*0.16; this.vy+=(dy/d)*sp*0.16;
        if(!this.captured) this.energy-=0.018;
        // stuck watchdog: catches targets reachable() couldn't filter (e.g. peninsulas) —
        // if distance-to-target hasn't meaningfully decreased for a long while, give up
        if(d>this._lastDist-0.4) this._stuckTicks++; else this._stuckTicks=0;
        this._lastDist=d;
        if(this._stuckTicks>180){ this.task=null; this._stuckTicks=0; this._lastDist=Infinity; return; }
      }
    } else { t._arrived=true; this._stuckTicks=0; this._lastDist=Infinity; }

    // task progress timer (after arrival / for stay tasks)
    if(t._arrived || t.stay){
      t._t++;
      if(t.onTick) t.onTick(this);
      if(t._t>=(t.dur||60)){ this.task=null; }
    }

    // friction + integrate
    if(t.pose==='work') this.walkPhase+=0.18;
    this.walkPhase+=Math.hypot(this.vx,this.vy)*0.6;
    this.vx*=0.86; this.vy*=0.86;
    let nx=this.x+this.vx, ny=this.y+this.vy;
    if(World.walkable(nx,this.y)) this.x=nx; else this.vx*=-0.4;
    if(World.walkable(this.x,ny)) this.y=ny; else this.vy*=-0.4;
    this.x=Math.max(6,Math.min(World.w-6,this.x));
    this.y=Math.max(6,Math.min(World.h-6,this.y));
  }

  // self-contained descend → find ore → mine → return-to-entrance → ascend loop,
  // run instead of chooseTask while this.underground is true (see update() above)
  updateUnderground(){
    this.hunger=Math.min(100,this.hunger+0.006);
    this.age+=1/World.dayLen;
    if(this.energy<-30){ this.die(); return; }
    const job=this.mineJob;
    if(!job){ Underground.ascend(this); return; }
    if(job.stage==='toOre'){
      const ore=job.oreTarget||(job.oreTarget=Underground.nearestOre(this.x,this.y));
      if(!ore || ore.amount<0.2){ job.stage='toExit'; job.oreTarget=null; }
      else {
        const d=Math.hypot(ore.x-this.x,ore.y-this.y);
        if(d<14){ job.stage='mining'; job.t=0; }
        else { const sp=this.speed*0.8; this.x+=(ore.x-this.x)/d*sp; this.y+=(ore.y-this.y)/d*sp; }
      }
    } else if(job.stage==='mining'){
      job.t++;
      if(job.t%30===0 && job.oreTarget && job.oreTarget.amount>0.2){
        job.oreTarget.amount-=0.3; this.inv.ore=(this.inv.ore||0)+1;
      }
      if(job.t>=150 || (this.inv.ore||0)>=4 || !job.oreTarget || job.oreTarget.amount<0.2) job.stage='toExit';
    } else if(job.stage==='toExit'){
      const ent=job.entrance;
      const d=Math.hypot(ent.x-this.x,ent.y-this.y);
      if(d<14) Underground.ascend(this);
      else { const sp=this.speed*0.8; this.x+=(ent.x-this.x)/d*sp; this.y+=(ent.y-this.y)/d*sp; }
    }
  }

  // self-contained two-leg surface trade run: walk cargo to the destination
  // settlement, deliver it and collect payment, then walk home to record the
  // route. Runs instead of chooseTask while this.caravan is set (see update()).
  // The straight-line path is safe: routes are only started between gathers
  // that passed World.reachable (no open water between them), and sea routes
  // are permitted to cross water by design.
  updateCaravan(){
    const c=this.caravan;
    const from=World.gathers[c.from], to=World.gathers[c.to];
    if(!from||!to||!from.stock||!to.stock){ this.caravan=null; this.task=null; return; }
    this.hunger=Math.min(100,this.hunger+0.006);
    this.age+=1/World.dayLen;
    if(this.medicated>0) this.medicated--;
    if(this.energy<-30){ this.die(); return; }
    const dest=c.stage==='toB'?to:from;
    const dx=dest.x-this.x, dy=dest.y-this.y, d=Math.hypot(dx,dy)||1;
    this.walkPhase+=0.28;
    if(d<18){
      if(c.stage==='toB'){
        // deliver the load into the destination store and take payment home:
        // coin split between the trader and both settlements' treasuries
        let value=0;
        for(const k in c.cargo){ to.stock[k]=(to.stock[k]||0)+c.cargo[k]; value+=c.cargo[k]; }
        const pay=Math.ceil(value*1.2);
        this.wealth=(this.wealth||0)+Math.ceil(pay*0.4);
        to.treasury=(to.treasury||0)+Math.ceil(pay*0.3);
        from.treasury=(from.treasury||0)+Math.ceil(pay*0.3);
        c.value=value; c.cargo={}; c.stage='home';
        this.remember('traded a caravan load at a distant market');
      } else {
        // home again — the route is recorded and both ends prosper
        World.recordRoute(c.from, c.to, c.mode, c.value||1, this.faction);
        Mesh.broadcast(this.x,this.y,'discovery',0.6,Factions[this.faction].color);
        this.remember('returned from a trade run');
        this.caravan=null; this.task=null;
        return;
      }
    } else {
      const sp=this.speed*(c.mode==='sea'?1.6:1)*0.9;
      this.x+=dx/d*sp; this.y+=dy/d*sp; this.energy-=0.02;
      this.x=Math.max(6,Math.min(World.w-6,this.x));
      this.y=Math.max(6,Math.min(World.h-6,this.y));
    }
  }

  die(){
    this.dead=true;
    World.totalDied=(World.totalDied||0)+1;
    if(this.job&&this.job.siteRef&&this.job.siteRef.workers){ const idx=this.job.siteRef.workers.indexOf(this.id); if(idx>=0) this.job.siteRef.workers.splice(idx,1); }
    // a death underground has no surface coordinates of its own — the Mesh field
    // (and other agents' grieving radius) only make sense on the surface, so a
    // dissolving-in-the-mine death is felt at the mine's entrance instead
    const wx=this.underground&&this.mineJob ? this.mineJob.site.x : this.x;
    const wy=this.underground&&this.mineJob ? this.mineJob.site.y : this.y;
    if(this._dissolving){
      // ceremonial dissolution at the Altar is a merciful re-integration, not a tragedy —
      // a spike of friction as the localized self lets go, then (scheduled in World) a coherence surge
      Mesh.broadcast(wx,wy,'dissonance-spike',1,'#ff5a5a');
      Mesh.writeField(wx,wy,'dissonance',0.3,140);
    } else {
      Mesh.broadcast(wx,wy,'grief',0.9,Factions[this.faction].color);
      Mesh.grief=Math.min(1,Mesh.grief+0.25);
      Mesh.writeField(wx,wy,'grief',0.5,180);
    }
    // bonded partner grieves hardest — and inherits
    let heir=null;
    for(const o of Agents){ if(o.bond===this.id){ o.bond=null; o.grieving=1; o.remember('lost '+this.name); if(!heir) heir=o; } }
    // inheritance — a life's coin passes to the bonded partner, or into the
    // settlement treasury if they died with no one to leave it to
    if(this.wealth>0){
      if(heir){ heir.wealth=(heir.wealth||0)+this.wealth; }
      else { const g=World.nearestOf(World.gathers,wx,wy); if(g) g.treasury=(g.treasury||0)+this.wealth; }
      this.wealth=0;
    }
    // nearby feel it (skipped for underground deaths — "nearby" has no meaning across the two maps)
    if(!this.underground){
      for(const o of Agents){ if(o!==this && !o.underground && dist2(this.x,this.y,o.x,o.y)<420*420){ o.grieving=Math.min(1,o.grieving+0.4); } }
    }
  }
}

function nearestAgent(a,filter){
  let best=null,bd=Infinity;
  for(const o of Agents){
    if(o.dead || o.underground) continue;
    if(filter && !filter(o)) continue;
    const d=dist2(a.x,a.y,o.x,o.y);
    if(d<bd){ bd=d; best=o; }
  }
  return best;
}
function agentById(id){ for(const o of Agents){ if(o.id===id) return o; } return null; }

function spawnAgents(count){
  const spots=World.gathers.length?World.gathers:[{x:World.w/2,y:World.h/2}];
  for(let i=0;i<count;i++){
    const s=spots[(Math.random()*spots.length)|0];
    let x=s.x+(Math.random()-0.5)*300, y=s.y+(Math.random()-0.5)*300;
    let tries=0; while(!World.walkable(x,y)&&tries++<20){ x=s.x+(Math.random()-0.5)*400; y=s.y+(Math.random()-0.5)*400; }
    Agents.push(new Agent(x,y,(Math.random()*4)|0));
  }
}

function birthAgent(){
  // child born near a Tender or gathering spot, inherits a nearby faction
  const spot=World.gathers[(Math.random()*World.gathers.length)|0]||{x:World.w/2,y:World.h/2};
  const a=new Agent(spot.x+(Math.random()-0.5)*120, spot.y+(Math.random()-0.5)*120, (Math.random()*4)|0);
  a.age=0; a.skills=1; a.energy=80;
  Agents.push(a);
  World.totalBorn=(World.totalBorn||0)+1;
  Mesh.broadcast(a.x,a.y,'joy',0.7,Factions[a.faction].color);
  Mesh.resonance=Math.min(1,Mesh.resonance+0.03);
}

function updateAgents(){
  for(let i=Agents.length-1;i>=0;i--){
    Agents[i].update();
    if(Agents[i].dead) Agents.splice(i,1);
  }
  // grief decays per agent
  for(const a of Agents){ if(a.grieving>0) a.grieving=Math.max(0,a.grieving-0.0008); }

  // effect particles
  for(let i=Exchanges.length-1;i>=0;i--){ const e=Exchanges[i]; e.life-=0.03; if(e.life<=0) Exchanges.splice(i,1); }
  for(let i=Sounds.length-1;i>=0;i--){ const s=Sounds[i]; s.r+=0.9; s.life-=0.02; if(s.life<=0) Sounds.splice(i,1); }
  for(const m of Marks){ if(m.age<99999) m.age++; }
}
