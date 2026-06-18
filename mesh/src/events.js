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
    else if(roll<0.16) kind='discovery';
    else if(roll<0.30) kind='birth';
    else if(roll<0.42) kind='surge';
    else if(roll<0.56) kind='dissonance';
    else if(roll<0.68) kind='drought';
    else if(roll<0.80) kind='migration';
    else if(roll<0.90) kind='ruin';
    else kind='depletion';
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
        const a=pick(Agents); if(a){ this.banner='A DISCOVERY SPREADS'; Mesh.broadcast(a.x,a.y,'discovery',0.9,'#e6b455'); a.remember('made a discovery'); raiseResonance(0.04);
          // a new resource node appears
          World.nodes.push({type:'food',sub:'berry',x:a.x,y:a.y,amount:1,max:1,regen:0.00008}); }
        break; }
      case 'birth':
        this.banner='A NEW LIFE BEGINS';
        if(Agents.length<140) birthAgent();
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
    }
    this.active=kind; this.activeT=260;
  },

  update(){
    this.timer++;
    if(this.timer>=this.interval){ this.trigger(); this.schedule(); }
    if(this.activeT>0){ this.activeT--; if(this.activeT<=0){ this.active=null; this.banner=''; } }

    // organic births when society thrives
    if(Mesh.resonance>0.7 && Agents.length<120 && Math.random()<0.0008) birthAgent();
    // collapse safety: if very few agents, repopulate gently
    if(Agents.length<24 && Math.random()<0.02) birthAgent();
  }
};
