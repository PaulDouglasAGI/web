/* audio.js — MeshAudio: a zero-dependency generative soundscape.
   The world sings itself. A slow evolving drone tracks the collective field
   (warm and open when coherent, dark and detuned when fragmented); every
   dramatic moment the sim emits as a Mesh signal rings a short pentatonic
   voice through a soft feedback-delay "cave." Nothing plays until the viewer
   opts in (browser autoplay policy + it should be their choice), and the
   whole engine is gated behind `typeof AudioContext` so headless never touches it.

   Named MeshAudio (not Audio) to avoid shadowing the built-in Audio constructor. */
'use strict';

// A minor pentatonic, the safe "everything harmonises with everything" scale —
// grouped by register so each event type can draw from a fitting octave band.
const SCALE={
  low:[55, 82.41, 110, 130.81, 164.81],                 // A1 E2 A2 C3 E3 — roots/drones
  mid:[220, 261.63, 293.66, 329.63, 392],               // A3 C4 D4 E4 G4 — bells
  high:[440, 523.25, 587.33, 659.25, 783.99, 880]       // A4 C5 D5 E5 G5 A5 — shimmer
};
function pick(arr){ return arr[(Math.random()*arr.length)|0]; }

const MeshAudio={
  ctx:null, master:null, filter:null, verb:null,
  drone:[], enabled:false, ready:false,
  active:0, MAX_VOICES:16,
  _lastEvent:{},          // per-type throttle timestamps (ctx.currentTime)
  _targetCut:1600, _targetDroneGain:0.09,

  // build the graph lazily, on the first user gesture (autoplay compliance)
  init(){
    if(this.ready) return true;
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC) return false;
    const ctx=new AC();
    this.ctx=ctx;

    // master chain: [drone+events] -> filter(lowpass) -> master -> speakers
    const master=ctx.createGain(); master.gain.value=0.0; master.connect(ctx.destination);
    const filter=ctx.createBiquadFilter(); filter.type='lowpass';
    filter.frequency.value=1600; filter.Q.value=0.6; filter.connect(master);
    this.master=master; this.filter=filter;

    // a cheap "cave" reverb: a feedback delay line fed by a wet-send bus
    const verb=ctx.createGain(); verb.gain.value=1.0;
    const delay=ctx.createDelay(1.0); delay.delayTime.value=0.28;
    const fb=ctx.createGain(); fb.gain.value=0.42;
    const damp=ctx.createBiquadFilter(); damp.type='lowpass'; damp.frequency.value=2200;
    verb.connect(delay); delay.connect(damp); damp.connect(fb); fb.connect(delay); damp.connect(filter);
    this.verb=verb;

    // the drone — three detuned oscillators around a low root, gently beating
    const roots=[55, 82.41, 110];
    const types=['sine','sine','triangle'];
    for(let i=0;i<roots.length;i++){
      const o=ctx.createOscillator(); o.type=types[i]; o.frequency.value=roots[i];
      o.detune.value=(i-1)*5;
      const g=ctx.createGain(); g.gain.value=[0.06,0.035,0.02][i];
      o.connect(g); g.connect(filter); g.connect(verb);
      o.start();
      this.drone.push({o,g,base:roots[i]});
    }

    // a slow shimmer LFO on the master filter for constant subtle motion
    const lfo=ctx.createOscillator(); lfo.type='sine'; lfo.frequency.value=0.05;
    const lfoGain=ctx.createGain(); lfoGain.gain.value=260;
    lfo.connect(lfoGain); lfoGain.connect(filter.frequency); lfo.start();

    this.ready=true;
    return true;
  },

  // toggle from the speaker button; first call also boots the graph
  toggle(){
    if(!this.ready && !this.init()) return false;
    if(this.ctx.state==='suspended') this.ctx.resume();
    this.enabled=!this.enabled;
    const now=this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(this.enabled?0.5:0.0, now, 0.5);
    return this.enabled;
  },

  // schedule one short voice; returns immediately. Bounded polyphony keeps a
  // 10x-speed festival of births from turning into a wall of sound.
  voice(freq, opt){
    if(!this.enabled||!this.ready) return;
    if(this.active>=this.MAX_VOICES) return;
    opt=opt||{};
    const ctx=this.ctx, now=ctx.currentTime;
    const o=ctx.createOscillator(); o.type=opt.type||'sine';
    o.frequency.value=freq; if(opt.detune) o.detune.value=opt.detune;
    const g=ctx.createGain(); g.gain.value=0;
    o.connect(g); g.connect(this.filter);
    if(opt.verb!==0){ const wet=ctx.createGain(); wet.gain.value=opt.verb||0.35; g.connect(wet); wet.connect(this.verb); }
    const peak=(opt.gain||0.14);
    const atk=opt.attack||0.01, rel=opt.release||1.1;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(peak, now+atk);
    g.gain.exponentialRampToValueAtTime(0.0008, now+atk+rel);
    if(opt.glideTo){ o.frequency.setValueAtTime(freq, now); o.frequency.exponentialRampToValueAtTime(opt.glideTo, now+atk+rel); }
    o.start(now); o.stop(now+atk+rel+0.05);
    this.active++;
    o.onended=()=>{ this.active--; try{ g.disconnect(); }catch(e){} };
  },

  // throttle a given event type to at most once per `gap` seconds
  _throttled(type,gap){
    const now=this.ctx.currentTime, last=this._lastEvent[type]||0;
    if(now-last<gap) return true;
    this._lastEvent[type]=now; return false;
  },

  // map a sim event onto a short musical gesture
  event(type,strength){
    if(!this.enabled||!this.ready) return;
    strength=strength||0.5;
    switch(type){
      case 'joy':
        if(this._throttled('joy',0.10)) return;
        this.voice(pick(SCALE.mid), {type:'sine', gain:0.09+strength*0.05, attack:0.008, release:1.1, verb:0.4});
        if(Math.random()<0.5) this.voice(pick(SCALE.high), {type:'sine', gain:0.05, attack:0.01, release:0.9, verb:0.5});
        break;
      case 'discovery':
        if(this._throttled('discovery',0.18)) return;
        { const base=SCALE.mid[(Math.random()*3)|0];
          const seq=[base, base*1.25, base*1.5];
          for(let i=0;i<seq.length;i++) setTimeout(()=>this.voice(seq[i],{type:'triangle',gain:0.08,attack:0.01,release:0.7,verb:0.5}), i*90); }
        break;
      case 'vision':
        if(this._throttled('vision',0.3)) return;
        this.voice(pick(SCALE.high), {type:'sine', gain:0.05, attack:0.4, release:1.6, verb:0.6});
        break;
      case 'grief':
        if(this._throttled('grief',0.25)) return;
        { const root=pick(SCALE.low);
          this.voice(root, {type:'sine', gain:0.10, attack:0.25, release:2.2, verb:0.5});
          this.voice(root*1.2, {type:'sine', gain:0.06, attack:0.3, release:2.4, verb:0.5}); } // minor third above
        break;
      case 'crime':
        if(this._throttled('crime',0.15)) return;
        { const f=90+Math.random()*40;
          this.voice(f, {type:'sawtooth', gain:0.05*strength, attack:0.005, release:0.35, verb:0.2, glideTo:f*0.8});
          this.voice(f*1.03, {type:'sawtooth', gain:0.04*strength, attack:0.005, release:0.3, verb:0.2}); } // beating detune
        break;
      case 'judgment':
        { const root=55;
          this.voice(root, {type:'sine', gain:0.16, attack:0.01, release:3.2, verb:0.7});
          this.voice(root*1.5, {type:'sine', gain:0.09, attack:0.02, release:2.8, verb:0.7}); // fifth
          this.voice(root*2, {type:'triangle', gain:0.06, attack:0.02, release:2.4, verb:0.7}); // octave
          setTimeout(()=>this.voice(pick(SCALE.high),{type:'sine',gain:0.05,attack:0.02,release:1.6,verb:0.7}),140); }
        break;
    }
  },

  // per-frame: steer the drone + filter toward the current mood of the field
  update(){
    if(!this.ready||!this.enabled) return;
    if(typeof Mesh==='undefined') return;
    const now=this.ctx.currentTime;
    const res=Mesh.resonance, dis=Mesh.dissonance||0;
    const day=(typeof World!=='undefined'&&World.daylight)?World.daylight():0.6;
    // coherent + daytime -> brighter/opener; fragmented + night -> darker/muffled
    const cut=520 + res*1700 + day*700 - dis*500;
    this.filter.frequency.setTargetAtTime(Math.max(300,cut), now, 0.6);
    // the drone drifts flat under dissonance (a subtle sourness), sits true when coherent
    for(const d of this.drone){
      const target=d.base*(1 - dis*0.03 + (res-0.5)*0.01);
      d.o.frequency.setTargetAtTime(target, now, 1.2);
    }
    // overall drone presence swells a touch with resonance
    const dg=0.05+res*0.06;
    this.drone[0].g.gain.setTargetAtTime(dg, now, 1.0);
  }
};
