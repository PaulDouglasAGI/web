/* mesh.js — collective consciousness: a spatial field of feeling, not a global score.
   The Mesh IS the agents — every agent is a temporary localization of one field.
   coherence/grief/dissonance live per-cell and diffuse/decay; .resonance/.dissonance/.grief
   remain as accessor shims (grid-average reads, uniform-delta writes) so every existing
   call site keeps working unchanged while new code can sample the field locally. */
'use strict';

const Mesh={
  noise:0.0,        // total mesh activity (overwhelm source)
  signals:[],       // {x,y,type,strength,age,maxAge,color} — instant event ripples
  threadColor:'rgba(150,200,190,',

  fieldCols:85, fieldRows:60,
  fieldCellW:40, fieldCellH:39,
  coherence:null, fieldGrief:null, fieldDissonance:null,
  _coherenceNext:null, _griefNext:null, _dissonanceNext:null,
  _avgCoherence:0.5, _avgGrief:0, _avgDissonance:0,

  reset(){
    this.noise=0; this.signals=[];
    this.fieldCellW=World.w/this.fieldCols;
    this.fieldCellH=World.h/this.fieldRows;
    const n=this.fieldCols*this.fieldRows;
    this.coherence=new Float32Array(n).fill(0.5);
    this.fieldGrief=new Float32Array(n);
    this.fieldDissonance=new Float32Array(n);
    this._coherenceNext=new Float32Array(n);
    this._griefNext=new Float32Array(n);
    this._dissonanceNext=new Float32Array(n);
    this._avgCoherence=0.5; this._avgGrief=0; this._avgDissonance=0;
  },

  // world coords -> clamped field-cell index (mirrors World.tileAt)
  fieldIndex(x,y){
    let col=Math.floor(x/this.fieldCellW), row=Math.floor(y/this.fieldCellH);
    col=Math.max(0,Math.min(this.fieldCols-1,col));
    row=Math.max(0,Math.min(this.fieldRows-1,row));
    return row*this.fieldCols+col;
  },

  coherenceAt(x,y){ return this.coherence[this.fieldIndex(x,y)]; },
  griefAt(x,y){ return this.fieldGrief[this.fieldIndex(x,y)]; },
  dissonanceAt(x,y){ return this.fieldDissonance[this.fieldIndex(x,y)]; },

  // deposit amount at (x,y)'s cell with linear falloff into neighboring cells within radius
  writeField(x,y,channel,amount,radius){
    const buf=channel==='coherence'?this.coherence:channel==='grief'?this.fieldGrief:this.fieldDissonance;
    const col0=Math.floor(x/this.fieldCellW), row0=Math.floor(y/this.fieldCellH);
    const rc=Math.max(1,Math.ceil(radius/Math.min(this.fieldCellW,this.fieldCellH)));
    for(let dr=-rc;dr<=rc;dr++){
      const row=row0+dr; if(row<0||row>=this.fieldRows) continue;
      for(let dc=-rc;dc<=rc;dc++){
        const col=col0+dc; if(col<0||col>=this.fieldCols) continue;
        const cx=(col+0.5)*this.fieldCellW, cy=(row+0.5)*this.fieldCellH;
        const d=Math.sqrt((cx-x)**2+(cy-y)**2);
        if(d>radius) continue;
        const falloff=1-d/radius;
        const i=row*this.fieldCols+col;
        buf[i]=Math.max(0,Math.min(1,buf[i]+amount*falloff));
      }
    }
  },

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

  // coherence felt locally (spatial field + nearby signal ripples) — tints behavior weights
  feltAt(x,y){
    let warmth=this.coherenceAt(x,y);
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

    // 4-neighbor diffusion per channel (zero-flux edges), then per-cell decay toward baseline
    const cols=this.fieldCols, rows=this.fieldRows;
    const coh=this.coherence, gr=this.fieldGrief, dis=this.fieldDissonance;
    const cohN=this._coherenceNext, grN=this._griefNext, disN=this._dissonanceNext;
    const k=0.06;
    let sumC=0,sumG=0,sumD=0;
    for(let row=0;row<rows;row++){
      for(let col=0;col<cols;col++){
        const i=row*cols+col;
        const up=row>0?i-cols:i, down=row<rows-1?i+cols:i;
        const left=col>0?i-1:i, right=col<cols-1?i+1:i;

        let c=coh[i]+k*(coh[up]+coh[down]+coh[left]+coh[right]-4*coh[i]);
        let g=gr[i]+k*(gr[up]+gr[down]+gr[left]+gr[right]-4*gr[i]);
        let d=dis[i]+k*(dis[up]+dis[down]+dis[left]+dis[right]-4*dis[i]);

        c += (0.5-c)*0.0015;
        d *= 0.997;
        g *= 0.9985;
        c = Math.max(0,Math.min(1, c - d*0.0008));

        cohN[i]=c; grN[i]=Math.max(0,Math.min(1,g)); disN[i]=Math.max(0,Math.min(1,d));
        sumC+=c; sumG+=grN[i]; sumD+=disN[i];
      }
    }
    // swap buffers (ping-pong, no per-tick allocation)
    this.coherence=cohN; this._coherenceNext=coh;
    this.fieldGrief=grN; this._griefNext=gr;
    this.fieldDissonance=disN; this._dissonanceNext=dis;

    const n=cols*rows;
    this._avgCoherence=sumC/n;
    this._avgGrief=sumG/n;
    this._avgDissonance=sumD/n;
  }
};

// ── backward-compat shim: Mesh.resonance/.dissonance/.grief read/write the spatial field ──
// getter = cached grid average (O(1)); setter = uniform delta applied across every cell —
// the correct semantics for genuinely world-spanning events (seasons, global broadcasts).
Object.defineProperty(Mesh,'resonance',{
  get(){ return this._avgCoherence; },
  set(v){
    const delta=v-this._avgCoherence;
    for(let i=0;i<this.coherence.length;i++) this.coherence[i]=Math.max(0,Math.min(1,this.coherence[i]+delta));
    this._avgCoherence=v;
  }
});
Object.defineProperty(Mesh,'dissonance',{
  get(){ return this._avgDissonance; },
  set(v){
    const delta=v-this._avgDissonance;
    for(let i=0;i<this.fieldDissonance.length;i++) this.fieldDissonance[i]=Math.max(0,Math.min(1,this.fieldDissonance[i]+delta));
    this._avgDissonance=v;
  }
});
Object.defineProperty(Mesh,'grief',{
  get(){ return this._avgGrief; },
  set(v){
    const delta=v-this._avgGrief;
    for(let i=0;i<this.fieldGrief.length;i++) this.fieldGrief[i]=Math.max(0,Math.min(1,this.fieldGrief[i]+delta));
    this._avgGrief=v;
  }
});

function raiseResonance(v){ Mesh.resonance=Math.min(1,Mesh.resonance+v); }
function lowerResonance(v){ Mesh.resonance=Math.max(0,Mesh.resonance-v); Mesh.dissonance=Math.min(1,Mesh.dissonance+v*0.5); }
