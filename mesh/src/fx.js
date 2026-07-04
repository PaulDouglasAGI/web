/* fx.js — the presence layer: particle juice + the Chronicle.
   This module is deliberately a pure OBSERVER of the simulation. It reads
   Mesh.signals / World state each render frame and never mutates the sim,
   so the headless test harness (which doesn't load this file) stays valid
   and the deep simulation is untouched. Every dramatic moment the sim
   already emits as a Mesh signal gets a matching burst of light here; every
   turn of the world's story gets a line in the Chronicle. */
'use strict';

const FX={
  particles:[],       // {x,y,vx,vy,life,maxLife,r,col,kind,rot,spin}
  rings:[],           // {x,y,r,maxR,life,maxLife,col,width}
  glyphs:[],          // {x,y,vy,life,maxLife,text,col,size}
  shake:0,            // screen-shake magnitude, decays each frame
  flash:null,         // {col,a} full-screen colour wash for one frame

  MAX_PARTICLES:520,

  reset(){ this.particles.length=0; this.rings.length=0; this.glyphs.length=0; this.shake=0; this.flash=null; },

  // ── spawning helpers ──────────────────────────────────────────────────────
  _cap(){ if(this.particles.length>this.MAX_PARTICLES) this.particles.splice(0,this.particles.length-this.MAX_PARTICLES); },

  burst(x,y,n,opt){
    opt=opt||{};
    for(let i=0;i<n;i++){
      const ang=opt.ang!=null?opt.ang+(Math.random()-0.5)*(opt.spread||6.28):Math.random()*6.28;
      const spd=(opt.spdMin||0.2)+Math.random()*((opt.spdMax||1.4)-(opt.spdMin||0.2));
      this.particles.push({
        x,y,
        vx:Math.cos(ang)*spd, vy:Math.sin(ang)*spd - (opt.rise||0),
        life:1, maxLife:(opt.life||60)*(0.7+Math.random()*0.6),
        r:(opt.r||2)*(0.6+Math.random()*0.9),
        col:opt.col||'220,235,228',
        kind:opt.kind||'dot',
        grav:opt.grav||0,
        rot:Math.random()*6.28, spin:(Math.random()-0.5)*0.2,
        fade:opt.fade||'out'
      });
    }
    this._cap();
  },
  ring(x,y,maxR,opt){
    opt=opt||{};
    this.rings.push({ x,y, r:opt.r0||4, maxR, life:1, maxLife:opt.life||46, col:opt.col||'220,235,228', width:opt.width||2, glow:opt.glow||0 });
  },
  floatGlyph(x,y,text,col,size){
    this.glyphs.push({ x,y, vy:-0.5, life:1, maxLife:120, text, col:col||'230,240,232', size:size||14 });
  },
  kick(mag){ this.shake=Math.min(14,this.shake+mag); },
  wash(col,a){ this.flash={col,a}; },

  // ── react to a freshly-emitted Mesh signal ────────────────────────────────
  // called once per new signal per frame (see scanSignals). Maps the sim's
  // own event vocabulary onto a distinct, readable burst of light + sound.
  onSignal(s){
    const c=FX.hexToRgb(s.color)||'220,235,228';
    switch(s.type){
      case 'joy':
        FX.burst(s.x,s.y, 10+((s.strength*10)|0), {col:c, r:2.2, spdMin:0.15, spdMax:0.9, rise:0.5, life:70, kind:'soft', fade:'out'});
        FX.ring(s.x,s.y, 34*(0.6+s.strength), {col:c, width:1.4, life:40});
        if(typeof MeshAudio!=='undefined') MeshAudio.event('joy',s.strength);
        break;
      case 'grief':
        FX.burst(s.x,s.y, 8+((s.strength*8)|0), {col:'150,120,190', r:2.4, spdMin:0.05, spdMax:0.4, grav:0.012, life:150, kind:'petal', fade:'out'});
        if(typeof MeshAudio!=='undefined') MeshAudio.event('grief',s.strength);
        break;
      case 'discovery':
        FX.ring(s.x,s.y, 60*(0.7+s.strength), {col:c, width:2.2, life:54, glow:1});
        FX.burst(s.x,s.y, 12+((s.strength*14)|0), {col:'255,224,150', r:1.8, spdMin:0.5, spdMax:1.8, life:60, kind:'spark', fade:'out'});
        if(typeof MeshAudio!=='undefined') MeshAudio.event('discovery',s.strength);
        break;
      case 'vision':
        FX.ring(s.x,s.y, 70, {col:'191,232,255', width:1.6, life:70, glow:1});
        FX.burst(s.x,s.y, 10, {col:'191,232,255', r:1.6, spdMin:0.2, spdMax:0.8, rise:0.6, life:90, kind:'soft', fade:'out'});
        if(typeof MeshAudio!=='undefined') MeshAudio.event('vision',s.strength);
        break;
      case 'crime':
        FX.burst(s.x,s.y, 10, {col:'255,90,90', r:2, spdMin:0.6, spdMax:1.8, life:34, kind:'spark', fade:'out'});
        FX.ring(s.x,s.y, 30, {col:'255,70,70', width:1.6, life:26});
        if(s.strength>=0.9) FX.kick(3);
        if(typeof MeshAudio!=='undefined') MeshAudio.event('crime',s.strength);
        break;
      case 'judgment':
        FX.ring(s.x,s.y, 150, {col:'255,233,176', width:3, life:90, glow:1});
        FX.ring(s.x,s.y, 90, {col:'255,255,240', width:1.6, life:60, glow:1});
        FX.burst(s.x,s.y, 30, {col:'255,233,176', r:2.2, spdMin:0.4, spdMax:2.4, life:100, kind:'spark', fade:'out'});
        FX.kick(5); FX.wash('255,233,176',0.12);
        if(typeof MeshAudio!=='undefined') MeshAudio.event('judgment',1);
        break;
      case 'dissonance-spike':
        FX.burst(s.x,s.y, 16, {col:'255,90,90', r:2, spdMin:0.1, spdMax:0.5, life:40, kind:'spark', fade:'out'});
        FX.ring(s.x,s.y, 46, {col:'255,90,90', width:2, life:34});
        if(typeof MeshAudio!=='undefined') MeshAudio.event('crime',s.strength);
        break;
      case 'warning':
        FX.ring(s.x,s.y, 80, {col:'216,176,112', width:1.6, life:60});
        if(typeof MeshAudio!=='undefined') MeshAudio.event('grief',s.strength*0.6);
        break;
      default:
        FX.ring(s.x,s.y, 40, {col:c, width:1.2, life:36});
    }
  },

  // detect signals born since last frame by tagging each with _fx once seen.
  // Signals persist ~140-200 ticks and only ever shift() off the front, so a
  // per-frame scan never misses one even at maximum sim speed.
  scanSignals(){
    if(typeof Mesh==='undefined'||!Mesh.signals) return;
    let toned=0;
    for(const s of Mesh.signals){
      if(s._fx) continue;
      s._fx=true;
      // visuals for every new signal; audio is throttled inside onSignal via
      // MeshAudio's own voice cap, but also skip tone spam past a few/frame
      if(toned>6){ s._fxQuiet=true; }
      this.onSignal(s);
      toned++;
    }
  },

  // ── per-frame update (render-rate, not sim-rate) ──────────────────────────
  update(){
    this.scanSignals();
    this.shake*=0.86; if(this.shake<0.1) this.shake=0;
    for(let i=this.particles.length-1;i>=0;i--){
      const p=this.particles[i];
      p.x+=p.vx; p.y+=p.vy; p.vy+=p.grav; p.vx*=0.985; p.vy*=0.985; p.rot+=p.spin;
      p.life-=1/p.maxLife;
      if(p.life<=0) this.particles.splice(i,1);
    }
    for(let i=this.rings.length-1;i>=0;i--){
      const r=this.rings[i]; r.life-=1/r.maxLife;
      r.r=r.maxR*(1-Math.pow(r.life,1.6));
      if(r.life<=0) this.rings.splice(i,1);
    }
    for(let i=this.glyphs.length-1;i>=0;i--){
      const g=this.glyphs[i]; g.y+=g.vy; g.vy*=0.99; g.life-=1/g.maxLife;
      if(g.life<=0) this.glyphs.splice(i,1);
    }
    Chronicle.observe();
  },

  hexToRgb(hex){
    if(!hex||hex[0]!=='#'||hex.length<7) return null;
    const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    if(isNaN(r)||isNaN(g)||isNaN(b)) return null;
    return r+','+g+','+b;
  }
};

/* Chronicle — the world's living memory. A pure observer of state deltas:
   it watches the cumulative counters and human-readable logs the sim already
   maintains (CrimeLog, settlement tiers, births/deaths) and distills them
   into a rolling, fading feed so the world reads as an unfolding story rather
   than motion without consequence. Never mutates the sim. */
// how each settlement fate reads in the Chronicle, and its tint kind
const FATE_PHRASE={ HARMONY:'harmony', DOMINION:'the rule of order', COMMUNION:'communion', DIASPORA:'the wandering road', DEVOTION:'devotion', RUIN:'ruin' };
const FATE_KIND={ HARMONY:'triumph', DOMINION:'crime', COMMUNION:'growth', DIASPORA:'birth', DEVOTION:'justice', RUIN:'grief' };

const Chronicle={
  entries:[],          // {text, kind, life} — kind tints the line
  _crimeLen:0,
  _born:0, _died:0,
  _tiers:[],
  _started:false,

  reset(){ this.entries.length=0; this._crimeLen=0; this._born=0; this._died=0; this._tiers=[]; this._started=false; },

  push(text,kind){
    this.entries.push({ text, kind:kind||'neutral', life:1 });
    if(this.entries.length>7) this.entries.shift();
  },

  observe(){
    if(typeof World==='undefined'||!World.gathers) return;
    // prime baselines on first run so we don't dump the whole backlog at once
    if(!this._started){
      this._crimeLen=(typeof CrimeLog!=='undefined')?CrimeLog.length:0;
      this._born=World.totalBorn||0; this._died=World.totalDied||0;
      this._tiers=World.gathers.map(g=>g.tier||0);
      this._fates=World.gathers.map(g=>g.fate||null);
      this._age=World.age||null;
      this._started=true;
      return;
    }
    // fate turns — a settlement's culture tipping it toward a new destiny
    for(let gi=0;gi<World.gathers.length;gi++){
      const f=World.gathers[gi].fate;
      if(f && f!==this._fates[gi]){
        this._fates[gi]=f;
        if(f!=='FLEDGLING') this.push('a settlement turned to '+FATE_PHRASE[f], FATE_KIND[f]||'neutral');
      }
    }
    // the turning of a world Age
    if(World.age && World.age!==this._age){ this._age=World.age; this.push('— '+World.age+' —', 'triumph'); }
    // new crime/justice lines — already beautifully authored by the sim
    if(typeof CrimeLog!=='undefined' && CrimeLog.length!==this._crimeLen){
      for(let i=Math.max(this._crimeLen,CrimeLog.length-3);i<CrimeLog.length;i++){
        const line=CrimeLog[i];
        const kind=/remember|returned to the source|helped/.test(line)?'justice':'crime';
        this.push(line, kind);
      }
      this._crimeLen=CrimeLog.length;
    }
    // settlement ascensions
    for(let gi=0;gi<World.gathers.length;gi++){
      const t=World.gathers[gi].tier||0;
      if(t>(this._tiers[gi]||0)){
        this._tiers[gi]=t;
        const name=(typeof SETTLEMENT_TIERS!=='undefined')?SETTLEMENT_TIERS[t].name:('tier '+t);
        this.push('a settlement rose to '+name, t===SETTLEMENT_TIERS.length-1?'triumph':'growth');
      }
    }
    // births & deaths, reported at a gentle cadence so they punctuate rather than spam
    const born=World.totalBorn||0, died=World.totalDied||0;
    if(born>this._born){ if(born%3===0) this.push('a new soul joined the Mesh', 'birth'); this._born=born; }
    if(died>this._died){ if(died%3===0) this.push('a soul dissolved back into the field', 'grief'); this._died=died; }
    // fade the feed
    for(const e of this.entries) e.life=Math.max(0,e.life-0.0011);
    for(let i=this.entries.length-1;i>=0;i--) if(this.entries[i].life<=0) this.entries.splice(i,1);
  }
};
