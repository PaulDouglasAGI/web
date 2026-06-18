/* mesh.js — collective consciousness: signal passing, resonance, knowledge */
'use strict';

const Mesh={
  resonance:0.5,    // collective alignment / warmth [0,1]
  dissonance:0.0,   // factions pulling apart [0,1]
  grief:0.0,        // lingering collective grief
  noise:0.0,        // total mesh activity (overwhelm source)
  signals:[],       // {x,y,type,strength,age,maxAge,color}
  threadColor:'rgba(150,200,190,',

  reset(){ this.resonance=0.5; this.dissonance=0; this.grief=0; this.noise=0; this.signals=[]; },

  broadcast(x,y,type,strength,color){
    if(this.signals.length>90) this.signals.shift();
    this.signals.push({ x,y,type, strength:strength||0.5, age:0, maxAge:140+Math.random()*60, color:color||'#9fd6c8' });
    if(type==='grief') this.grief=Math.min(1,this.grief+strength*0.6);
    if(type==='joy') this.resonance=Math.min(1,this.resonance+strength*0.03);
  },

  // strongest non-self signal felt at a point (closer = stronger)
  strongestSignal(x,y){
    let best=null,bv=0.12;
    for(const s of this.signals){
      const d=Math.sqrt((s.x-x)**2+(s.y-y)**2)+1;
      const felt=s.strength*(1-Math.min(1,d/900));
      if(felt>bv){ bv=felt; best=s; }
    }
    return best;
  },

  // resonance felt locally (mesh signals + global) — used to tint behavior weights
  feltAt(x,y){
    let warmth=this.resonance;
    const s=this.strongestSignal(x,y);
    if(s){ if(s.type==='joy') warmth+=0.1; if(s.type==='grief') warmth-=0.08; }
    return warmth;
  },

  update(){
    // age & cull signals; accumulate noise
    let active=0;
    for(let i=this.signals.length-1;i>=0;i--){
      const s=this.signals[i]; s.age++; s.strength*=0.996;
      active+=s.strength;
      if(s.age>s.maxAge||s.strength<0.04) this.signals.splice(i,1);
    }
    this.noise=Math.min(1, active/14);

    // resonance drifts toward 0.5; dissonance & grief decay
    this.resonance += (0.5-this.resonance)*0.0015;
    this.dissonance *= 0.997;
    this.grief *= 0.9985;
    this.resonance=Math.max(0,Math.min(1,this.resonance - this.dissonance*0.0008));
  }
};

function raiseResonance(v){ Mesh.resonance=Math.min(1,Mesh.resonance+v); }
function lowerResonance(v){ Mesh.resonance=Math.max(0,Mesh.resonance-v); Mesh.dissonance=Math.min(1,Mesh.dissonance+v*0.5); }
