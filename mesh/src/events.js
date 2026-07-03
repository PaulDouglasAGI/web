/* events.js — world events, crises, discoveries that ripple through the mesh */
'use strict';

const Events={
  timer:0,
  interval:1400,
  active:null,
  activeT:0,
  banner:'',

  schedule(){ this.interval=1100+((Math.random()*1400)|0); this.timer=0; },

  trigger(){
    const roll=Math.random();
    let kind;
    if(World.season===3 && roll<0.4) kind='winter';
    else if(roll<0.14) kind='discovery';
    else if(roll<0.26) kind='birth';
    else if(roll<0.37) kind='surge';
    else if(roll<0.49) kind='dissonance';
    else if(roll<0.59) kind='drought';
    else if(roll<0.69) kind='migration';
    else if(roll<0.77) kind='ruin';
    else if(roll<0.85) kind='depletion';
    else if(roll<0.93) kind='festival';
    else kind='caravanBoom';
    this.apply(kind);
  },

  apply(kind){
    const center={x:Math.random()*World.w,y:Math.random()*World.h};
    switch(kind){
      case 'winter':
        this.banner='A HARSH WINTER GATHERS';
        for(const a of Agents){ if(a.faction===0) a.inv.food+=0; a.remember('felt the cold coming'); }
        Mesh.broadcast(World.w/2,World.h/2,'warning',0.8,'#9fd6ff');
        Mesh.dissonance=Math.min(1,Mesh.dissonance+0.15);
        break;
      case 'discovery': {
        const a=pick(Agents.filter(o=>!o.underground)); if(a){ this.banner='A DISCOVERY SPREADS'; Mesh.broadcast(a.x,a.y,'discovery',0.9,'#e6b455'); a.remember('made a discovery'); raiseResonance(0.04);
          // a new resource node appears
          World.nodes.push({type:'food',sub:'berry',x:a.x,y:a.y,amount:1,max:1,regen:0.00008}); }
        break; }
      case 'birth':
        this.banner='A NEW LIFE BEGINS';
        if(Agents.length<World.housingCapacity()) birthAgent();
        break;
      case 'surge':
        this.banner='A MESH SURGE — EUPHORIA';
        Mesh.resonance=Math.min(1,Mesh.resonance+0.3);
        for(const a of Agents){ a.joy=Math.min(1,a.joy+0.3); }
        Mesh.broadcast(World.w/2,World.h/2,'joy',1,'#ffe0a8');
        break;
      case 'dissonance':
        this.banner='THE MESH FLICKERS — DISSONANCE';
        Mesh.dissonance=Math.min(1,Mesh.dissonance+0.4);
        Mesh.resonance=Math.max(0,Mesh.resonance-0.15);
        for(const a of Agents){ if(Math.random()<0.4) a.overwhelmed=Math.min(1,a.overwhelmed+0.4); }
        break;
      case 'drought':
        this.banner='A DROUGHT SETTLES IN';
        for(const nd of World.nodes){ if(nd.type==='water'||nd.type==='food') nd.amount*=0.4; }
        Mesh.broadcast(center.x,center.y,'warning',0.7,'#d8b070');
        break;
      case 'migration':
        this.banner='GAME MIGRATES — HUNTERS FOLLOW';
        for(const nd of World.nodes){ if(nd.type==='fish') nd.amount=nd.max; }
        Mesh.broadcast(center.x,center.y,'discovery',0.6,'#9fc08a');
        break;
      case 'ruin':
        this.banner='AN OLD RUIN IS UNCOVERED';
        Mesh.broadcast(center.x,center.y,'vision',0.7,'#bfa0e8');
        raiseResonance(0.02);
        break;
      case 'depletion':
        this.banner='A RESOURCE RUNS DRY';
        { const nd=pick(World.nodes); if(nd) nd.amount=0; }
        Mesh.dissonance=Math.min(1,Mesh.dissonance+0.1);
        break;
      case 'festival': {
        // a prosperous settlement pours its treasury into a celebration —
        // wealth spent on joy, which lifts the whole field around it
        let best=null; for(const g of World.gathers){ if(!best || (g.prosperity||0)>(best.prosperity||0)) best=g; }
        if(best && (best.prosperity||0)>0.35){
          this.banner='A FESTIVAL FILLS THE STREETS';
          best.treasury=Math.max(0,(best.treasury||0)-10);
          Mesh.broadcast(best.x,best.y,'joy',1,'#ffe0a8');
          raiseResonance(0.15);
          for(const a of Agents){ if(!a.underground && dist2(a.x,a.y,best.x,best.y)<400*400) a.joy=Math.min(1,a.joy+0.25); }
        } else {
          this.banner='THE MESH FLICKERS — DISSONANCE';
          Mesh.dissonance=Math.min(1,Mesh.dissonance+0.2); // no one prospers enough to celebrate
        }
        break; }
      case 'caravanBoom':
        this.banner='THE ROADS HUM WITH TRADE';
        for(const r of World.routes) r.strength=Math.min(30,r.strength+1);
        Mesh.broadcast(World.w/2,World.h/2,'discovery',0.8,'#e6b455');
        raiseResonance(0.05);
        break;
    }
    this.active=kind; this.activeT=260;
  },

  update(){
    this.timer++;
    if(this.timer>=this.interval){ this.trigger(); this.schedule(); }
    if(this.activeT>0){ this.activeT--; if(this.activeT<=0){ this.active=null; this.banner=''; } }

    // organic births when society thrives — gated by how much housing has actually been built
    const cap=World.housingCapacity();
    if(Mesh.resonance>0.6 && Agents.length<cap && Math.random()<0.0014) birthAgent();
    // collapse safety: if very few agents, repopulate gently (never above the housing cap)
    if(Agents.length<Math.min(24,cap) && Math.random()<0.02) birthAgent();
  }
};
