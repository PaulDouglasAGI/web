/* agents.js — agent class, weighted desire system, movement, lifecycle */
'use strict';

const Agents=[];
const Marks=[];       // landscape marks {x,y,type,faction,age}
const Sounds=[];      // music waves {x,y,r,life}
const Exchanges=[];   // trade particles {x,y,tx,ty,life}
let _agentId=1;

const NAME_A=['Su','Ka','Mi','Ev','Ar','Ny','Ol','Ta','Wr','Fen','Lir','Mor','Sel','Ash','Ber','Cael','Dun','Ro','Vey','Ilo','Quen','Bryn','Nim','Oro'];
const NAME_B=['ren','la','dor','wyn','eth','is','ka','mar','ven','os','ya','rin','del','an','ux','ele','aro','iss','und','ora','ix','ael'];
function genName(){ return NAME_A[(Math.random()*NAME_A.length)|0]+NAME_B[(Math.random()*NAME_B.length)|0]; }

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
    this.skills=1+((Math.random()*3)|0);
    this.meshSensitivity=0.4+Math.random()*0.6;
    this.bond=null;
    this.memory=[];
    this.task=null;
    this.reeval=0;
    this.meshMuted=0;
    this.driftScore=[0,0,0,0];
    this.speed=(0.9+Math.random()*0.4)*(faction===1?1.25:1);
  }

  remember(s){ this.memory.push(s); if(this.memory.length>6) this.memory.shift(); }

  emitExchange(other){ Exchanges.push({x:this.x,y:this.y,tx:other.x,ty:other.y,life:1}); }
  emitSound(){ Sounds.push({x:this.x,y:this.y,r:4,life:1}); }
  leaveMark(type){ Marks.push({x:this.x,y:this.y,type,faction:this.faction,age:0}); if(Marks.length>240) Marks.shift(); }

  driftFaction(){
    // shift toward the faction of nearby agents after a "powerful experience"
    const counts=[0,0,0,0];
    for(const o of Agents){ if(o===this) continue; if(dist2(this.x,this.y,o.x,o.y)<240*240) counts[o.faction]++; }
    let best=this.faction,bv=-1;
    for(let f=0;f<4;f++){ if(f!==this.faction && counts[f]>bv){ bv=counts[f]; best=f; } }
    if(bv>2 && Math.random()<0.5){ this.faction=best; this.remember('drifted toward '+Factions[best].name.toLowerCase()); this.speed=(0.9+Math.random()*0.4)*(best===1?1.25:1); }
  }

  // ── desire scoring ──────────────────────────────────────────────────────--
  chooseTask(){
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
      // mesh resonance modifiers
      if(felt>0.65 && (b.cat==='creative'||b.cat==='social')) w*=1.4;
      if(felt<0.4 && b.cat==='social') w*=0.7;
      if(Mesh.grief>0.3 && b.cat==='social') w*=1.3;
      // personal overwhelm
      if(this.overwhelmed>0.5 && b.cat!=='inner') w*=0.5;
      // noise so they feel alive
      w*=0.55+Math.random()*0.9;
      scored.push({b,w});
    }
    if(!scored.length){ this.task=this.fallback(); return; }
    scored.sort((p,q)=>q.w-p.w);
    const top=scored.slice(0,5);
    let sum=0; for(const s of top) sum+=s.w;
    let r=Math.random()*sum, chosen=top[0];
    for(const s of top){ r-=s.w; if(r<=0){ chosen=s; break; } }
    const task=chosen.b.make(this);
    this.task=task||this.fallback();
    if(this.task) this.task._t=0;
  }
  fallback(){ const p=wanderPoint(this,200); const t=gotoPoint(this,'wandering','~','inner',p.x,p.y,80); t._t=0; return t; }

  // ── per-tick update ─────────────────────────────────────────────────────--
  update(){
    // needs
    this.hunger=Math.min(100,this.hunger+0.012);
    this.social=Math.min(100,this.social+0.01);
    if(this.meshMuted>0) this.meshMuted--;
    // mesh overwhelm
    if(this.meshMuted<=0) this.overwhelmed=Math.min(1,this.overwhelmed + (Mesh.noise*this.meshSensitivity-0.35)*0.004);
    else this.overwhelmed=Math.max(0,this.overwhelmed-0.004);
    this.joy=Math.max(0,Math.min(1, this.joy + (Mesh.resonance-0.5)*0.002 - (this.hunger>70?0.002:0)));
    if(this.hunger>92||this.energy<4){ this.joy=Math.max(0,this.joy-0.003); }

    // aging & mortality
    this.age+=1/World.dayLen;
    if((this.age>60 && Math.random()<0.000018*(this.age-55)) || this.energy<-20){ this.die(); return; }

    // pick a task if none
    if(!this.task){ this.chooseTask(); }
    const t=this.task;

    // movement toward target
    if(t.targetAgent){ if(t.targetAgent.dead){ this.task=null; return; } t.target.x=t.targetAgent.x; t.target.y=t.targetAgent.y; }
    if(t.target && !t._arrived){
      const dx=t.target.x-this.x, dy=t.target.y-this.y;
      const d=Math.hypot(dx,dy);
      if(d<(t.arrive||14)){ t._arrived=true; if(t.onArrive) t.onArrive(this); }
      else {
        const sp=this.speed*(0.6+this.energy/200);
        this.vx+=(dx/d)*sp*0.16; this.vy+=(dy/d)*sp*0.16;
        this.energy-=0.018;
      }
    } else { t._arrived=true; }

    // task progress timer (after arrival / for stay tasks)
    if(t._arrived || t.stay){
      t._t++;
      if(t.onTick) t.onTick(this);
      if(t._t>=(t.dur||60)){ this.task=null; }
    }

    // friction + integrate
    this.vx*=0.86; this.vy*=0.86;
    let nx=this.x+this.vx, ny=this.y+this.vy;
    if(World.walkable(nx,this.y)) this.x=nx; else this.vx*=-0.4;
    if(World.walkable(this.x,ny)) this.y=ny; else this.vy*=-0.4;
    this.x=Math.max(6,Math.min(World.w-6,this.x));
    this.y=Math.max(6,Math.min(World.h-6,this.y));
  }

  die(){
    this.dead=true;
    Mesh.broadcast(this.x,this.y,'grief',0.9,Factions[this.faction].color);
    Mesh.grief=Math.min(1,Mesh.grief+0.25);
    // bonded partner grieves hardest
    for(const o of Agents){ if(o.bond===this.id){ o.bond=null; o.grieving=1; o.remember('lost '+this.name);} }
    // nearby feel it
    for(const o of Agents){ if(o!==this && dist2(this.x,this.y,o.x,o.y)<420*420){ o.grieving=Math.min(1,o.grieving+0.4); } }
  }
}

function nearestAgent(a,filter){
  let best=null,bd=Infinity;
  for(const o of Agents){
    if(o.dead) continue;
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
