/* renderer.js — terrain, mesh threads, agents, lighting, seasons, camera */
'use strict';

const Camera={ x:0, y:0, zoom:1, minZoom:0.35, maxZoom:3.2 };

const Renderer={
  cnv:null, ctx:null, W:0, H:0, dpr:1,

  // base terrain colors [r,g,b]
  TCOL:{
    0:[26,52,74],   // water
    1:[120,128,96], // shore
    2:[64,92,54],   // plain
    3:[36,68,40],   // forest
    4:[92,84,68],   // hill
    5:[70,66,72],   // ruin
    6:[80,60,46],   // fire area
    7:[78,98,60]    // gathering spot
  },
  // per-season tint multipliers (r,g,b) and ambient
  SEASON:[
    {m:[1.0,1.08,0.95]}, // spring — lush
    {m:[1.12,1.05,0.78]},// summer — dry gold
    {m:[1.15,0.92,0.66]},// autumn — amber
    {m:[0.86,0.92,1.05]} // winter — cold pale
  ],

  init(){
    this.cnv=document.getElementById('world');
    this.ctx=this.cnv.getContext('2d');
    this.resize();
    window.addEventListener('resize',()=>this.resize());
  },
  resize(){
    this.dpr=Math.min(window.devicePixelRatio||1,2);
    this.W=window.innerWidth; this.H=window.innerHeight;
    this.cnv.width=this.W*this.dpr; this.cnv.height=this.H*this.dpr;
    this.cnv.style.width=this.W+'px'; this.cnv.style.height=this.H+'px';
    this.ctx.setTransform(this.dpr,0,0,this.dpr,0,0);
  },

  sx(wx){ return (wx-Camera.x)*Camera.zoom + this.W/2; },
  sy(wy){ return (wy-Camera.y)*Camera.zoom + this.H/2; },
  worldX(px){ return (px-this.W/2)/Camera.zoom + Camera.x; },
  worldY(py){ return (py-this.H/2)/Camera.zoom + Camera.y; },

  draw(){
    const ctx=this.ctx, W=this.W, H=this.H, z=Camera.zoom;
    const day=World.daylight();

    // base sky/void
    ctx.fillStyle='#05060a'; ctx.fillRect(0,0,W,H);

    // visible tile range
    const ts=World.ts;
    const x0=Math.max(0,((this.worldX(0))/ts|0)-1);
    const y0=Math.max(0,((this.worldY(0))/ts|0)-1);
    const x1=Math.min(World.cols-1,((this.worldX(W))/ts|0)+1);
    const y1=Math.min(World.rows-1,((this.worldY(H))/ts|0)+1);
    const sm=this.SEASON[World.season].m;
    const tilePx=ts*z+1;

    for(let r=y0;r<=y1;r++){
      for(let c=x0;c<=x1;c++){
        const tt=World.tiles[r*World.cols+c];
        const b=this.TCOL[tt];
        // elevation shading
        const e=World.elev[r*World.cols+c];
        const sh=0.7+Math.min(0.5,e*0.5);
        let rr=b[0]*sm[0]*sh, gg=b[1]*sm[1]*sh, bb=b[2]*sm[2]*sh;
        // water shimmer
        if(tt===0){ const w=Math.sin(World.dayTick*0.02+c*0.5+r*0.3)*6; rr+=w; gg+=w; bb+=w+8; }
        ctx.fillStyle='rgb('+(rr|0)+','+(gg|0)+','+(bb|0)+')';
        ctx.fillRect(this.sx(c*ts)|0, this.sy(r*ts)|0, Math.ceil(tilePx), Math.ceil(tilePx));
      }
    }

    // landscape marks
    for(const m of Marks){
      const sx=this.sx(m.x), sy=this.sy(m.y);
      if(sx<-20||sx>W+20||sy<-20||sy>H+20) continue;
      const fc=Factions[m.faction];
      ctx.globalAlpha=0.5;
      ctx.fillStyle=fc.color;
      if(m.type==='shrine'){ ctx.fillRect(sx-2*z,sy-5*z,4*z,8*z); }
      else if(m.type==='garden'){ ctx.beginPath(); ctx.arc(sx,sy,3*z,0,7); ctx.fill(); }
      else { ctx.fillRect(sx-1.5*z,sy-1.5*z,3*z,3*z); }
      ctx.globalAlpha=1;
    }

    // resource node glows
    for(const nd of World.nodes){
      const sx=this.sx(nd.x), sy=this.sy(nd.y);
      if(sx<-20||sx>W+20||sy<-20||sy>H+20) continue;
      const col=nd.type==='food'?'rgba(150,200,110,':nd.type==='water'?'rgba(90,160,210,':nd.type==='wood'?'rgba(120,90,60,':nd.type==='stone'?'rgba(150,150,160,':nd.type==='herb'?'rgba(170,120,200,':'rgba(120,170,200,';
      const a=0.18+nd.amount*0.22;
      const g=ctx.createRadialGradient(sx,sy,0,sx,sy,9*z);
      g.addColorStop(0,col+a+')'); g.addColorStop(1,col+'0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,9*z,0,7); ctx.fill();
    }

    // ── MESH THREADS ──────────────────────────────────────────────────────--
    const threadRange=150, tr2=threadRange*threadRange;
    const warm=Mesh.resonance;
    ctx.lineWidth=Math.max(0.4, 0.8*z);
    for(let i=0;i<Agents.length;i++){
      const a=Agents[i];
      const asx=this.sx(a.x), asy=this.sy(a.y);
      if(asx<-60||asx>W+60||asy<-60||asy>H+60) continue;
      for(let j=i+1;j<Agents.length;j++){
        const b=Agents[j];
        const d2=dist2(a.x,a.y,b.x,b.y);
        if(d2>tr2) continue;
        const bsx=this.sx(b.x), bsy=this.sy(b.y);
        const prox=1-Math.sqrt(d2)/threadRange;
        let alpha=prox*(0.10+warm*0.22);
        const bonded=(a.bond===b.id);
        if(bonded) alpha=Math.min(0.7,alpha+0.4);
        if(alpha<0.02) continue;
        // tint = blend of faction colors, warmer with resonance
        const fa=Factions[a.faction], fb=Factions[b.faction];
        const col= warm>0.5 ? 'rgba(180,210,180,' : 'rgba(120,150,170,';
        ctx.strokeStyle=col+alpha+')';
        ctx.beginPath(); ctx.moveTo(asx,asy); ctx.lineTo(bsx,bsy); ctx.stroke();
        // pulse a dot along the thread if a signal is near the midpoint
        if(bonded || (warm>0.6 && Math.random()<0.02)){
          const mx=(asx+bsx)/2, my=(asy+bsy)/2;
          ctx.fillStyle='rgba(220,240,210,'+Math.min(0.8,alpha+0.3)+')';
          ctx.beginPath(); ctx.arc(mx,my,1.4*z,0,7); ctx.fill();
        }
      }
    }

    // ── SIGNALS (ripples) ─────────────────────────────────────────────────--
    for(const s of Mesh.signals){
      const sx=this.sx(s.x), sy=this.sy(s.y);
      const rad=(8+s.age*0.9)*z;
      if(sx<-rad-20||sx>W+rad+20||sy<-rad-20||sy>H+rad+20) continue;
      const a=s.strength*(1-s.age/s.maxAge)*0.6;
      ctx.strokeStyle=this.hexA(s.color,a);
      ctx.lineWidth=Math.max(0.5,1.4*z);
      ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.stroke();
    }

    // sound waves
    for(const s of Sounds){
      const sx=this.sx(s.x), sy=this.sy(s.y);
      ctx.strokeStyle='rgba(220,210,170,'+(s.life*0.4)+')';
      ctx.lineWidth=Math.max(0.4,1*z);
      ctx.beginPath(); ctx.arc(sx,sy,s.r*z,0,7); ctx.stroke();
    }

    // exchange particles
    for(const e of Exchanges){
      const ex=this.sx(e.x+(e.tx-e.x)*(1-e.life)), ey=this.sy(e.y+(e.ty-e.y)*(1-e.life));
      ctx.fillStyle='rgba(240,230,180,'+e.life+')';
      ctx.beginPath(); ctx.arc(ex,ey,2*z,0,7); ctx.fill();
    }

    // ── AGENTS ────────────────────────────────────────────────────────────--
    const showGlyph=z>1.15;
    for(const a of Agents){
      const sx=this.sx(a.x), sy=this.sy(a.y);
      if(sx<-20||sx>W+20||sy<-30||sy>H+20) continue;
      const fc=Factions[a.faction];
      const rad=Math.max(2,2.6*z);
      // overwhelm / grief desaturate; joy brightens glow
      const glowA=0.25+a.joy*0.4 - a.overwhelmed*0.15;
      if(z>0.6){
        const g=ctx.createRadialGradient(sx,sy,0,sx,sy,rad*3);
        g.addColorStop(0, fc.glow+Math.max(0,glowA)+')'); g.addColorStop(1, fc.glow+'0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,rad*3,0,7); ctx.fill();
      }
      // body
      ctx.fillStyle=fc.color;
      if(z>0.9){
        // little figure: head + body
        ctx.beginPath(); ctx.arc(sx,sy-rad*0.8,rad*0.7,0,7); ctx.fill();
        ctx.fillRect(sx-rad*0.5, sy-rad*0.1, rad, rad*1.6);
      } else {
        ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.fill();
      }
      // grieving marker
      if(a.grieving>0.4 && z>1){ ctx.fillStyle='rgba(184,155,217,0.8)'; ctx.beginPath(); ctx.arc(sx,sy-rad*2.4,1.2*z,0,7); ctx.fill(); }
      // action glyph
      if(showGlyph && a.task && a.task.glyph){
        ctx.fillStyle='rgba(220,235,228,0.82)';
        ctx.font=(9*Math.min(z,2))+'px "Exo 2",sans-serif';
        ctx.textAlign='center';
        ctx.fillText(a.task.glyph, sx, sy-rad*2.6);
      }
    }
    ctx.textAlign='left';

    // ── TIME-OF-DAY LIGHTING ──────────────────────────────────────────────--
    // overlay color & alpha from phase
    let ov, oa;
    if(day<0.18){ ov=[10,16,40]; oa=0.62; }       // night
    else if(World.dayT<0.22){ ov=[230,150,70]; oa=0.18; } // dawn amber
    else if(World.dayT>0.62 && World.dayT<0.78){ ov=[220,120,60]; oa=0.2; } // dusk
    else if(World.dayT>=0.78){ ov=[10,16,40]; oa=0.5; }   // into night
    else { ov=[255,250,220]; oa=0.04; }            // midday slight warm
    ctx.fillStyle='rgba('+ov[0]+','+ov[1]+','+ov[2]+','+oa+')';
    ctx.fillRect(0,0,W,H);

    // firelight at night around fires
    if(World.isNight()){
      for(const f of World.fires){
        const sx=this.sx(f.x), sy=this.sy(f.y);
        const rad=70*z*(0.9+Math.sin(World.dayTick*0.1)*0.06);
        const g=ctx.createRadialGradient(sx,sy,0,sx,sy,rad);
        g.addColorStop(0,'rgba(255,170,80,0.28)'); g.addColorStop(1,'rgba(255,150,60,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.fill();
      }
    }

    // ── RESONANCE WARMTH WASH ─────────────────────────────────────────────--
    const res=Mesh.resonance;
    if(res>0.55){ ctx.fillStyle='rgba(255,200,140,'+((res-0.55)*0.18)+')'; ctx.fillRect(0,0,W,H); }
    else if(res<0.45){ ctx.fillStyle='rgba(80,110,150,'+((0.45-res)*0.22)+')'; ctx.fillRect(0,0,W,H); }
    // dissonance flicker
    if(Mesh.dissonance>0.4 && Math.random()<Mesh.dissonance*0.3){ ctx.fillStyle='rgba(150,120,160,0.05)'; ctx.fillRect(0,0,W,H); }

    // gentle vignette
    const vg=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.4,W/2,H/2,Math.max(W,H)*0.75);
    vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.4)');
    ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
  },

  hexA(hex,a){
    const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    return 'rgba('+r+','+g+','+b+','+a+')';
  }
};
