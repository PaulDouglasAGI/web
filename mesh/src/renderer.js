/* renderer.js — terrain, mesh threads, agents, lighting, seasons, camera */
'use strict';

const Camera={ x:0, y:0, zoom:1, minZoom:0.35, maxZoom:3.2 };

const Renderer={
  cnv:null, ctx:null, W:0, H:0, dpr:1,
  showField:false, // off by default — the field overlay is an opt-in deeper look, not the default view
  viewMode:'surface', // 'surface' | 'underground' — toggled by #mine-toggle (ui.js)

  // base terrain colors [r,g,b]
  TCOL:{
    0:[26,52,74],   // water
    1:[58,86,78],   // shore — wet rock/reed edge, not sand
    2:[64,92,54],   // plain
    3:[36,68,40],   // forest
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

  // ── the world quietly wearing its state (ambient viz) ──────────────────────
  // a settlement's fate → the colour of the soft aura it breathes
  FATE_AURA:{ HARMONY:'255,233,176', COMMUNION:'150,214,180', DOMINION:'198,120,110', DIASPORA:'230,196,130', DEVOTION:'201,184,232', RUIN:'120,104,92' },
  // a soul's dominant belief → the colour of the faint spark it carries
  BELIEF_COLOR:{ order:'143,176,208', communion:'159,214,180', faith:'201,184,232', material:'224,160,96', freedom:'232,200,140' },
  // the world's Age → a barely-there global colour grade
  AGE_TINT:{ 'AN AGE OF HARMONY':[255,233,176], 'AN AGE OF IRON':[150,150,172], 'AN AGE OF COMMUNION':[150,210,180], 'AN AGE OF WANDERING':[222,190,140], 'AN AGE OF FAITH':[192,172,222], 'AN AGE OF SILENCE':[128,118,108] },

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

  // optional, toggled view of the field underneath the living world — coherence as
  // soft gold, grief as blue-violet, dissonance as red-orange. Viewport-culled like the tile loop.
  drawFieldOverlay(){
    const ctx=this.ctx, W=this.W, H=this.H, z=Camera.zoom;
    const cw=Mesh.fieldCellW, ch=Mesh.fieldCellH;
    const c0=Math.max(0,(this.worldX(0)/cw|0)-1);
    const r0=Math.max(0,(this.worldY(0)/ch|0)-1);
    const c1=Math.min(Mesh.fieldCols-1,(this.worldX(W)/cw|0)+1);
    const r1=Math.min(Mesh.fieldRows-1,(this.worldY(H)/ch|0)+1);
    const cellPx=Math.max(cw,ch)*z+1;
    for(let row=r0;row<=r1;row++){
      for(let col=c0;col<=c1;col++){
        const i=row*Mesh.fieldCols+col;
        const px=this.sx(col*cw)|0, py=this.sy(row*ch)|0;
        const w=Math.ceil(cw*z+1), h=Math.ceil(ch*z+1);
        const coh=Mesh.coherence[i], gr=Mesh.fieldGrief[i], dis=Mesh.fieldDissonance[i];
        if(coh>0.5){ ctx.fillStyle='rgba(255,233,200,'+((coh-0.5)*0.5)+')'; ctx.fillRect(px,py,w,h); }
        if(gr>0.05){ ctx.fillStyle='rgba(90,60,140,'+Math.min(0.5,gr*0.5)+')'; ctx.fillRect(px,py,w,h); }
        if(dis>0.05){ ctx.fillStyle='rgba(220,90,50,'+Math.min(0.5,dis*0.5)+')'; ctx.fillRect(px,py,w,h); }
      }
    }
  },

  // the cave map — its own tile palette + ore-vein glows + entrance markers +
  // whichever agents are currently underground. No threads/signals/weather here;
  // the Mesh field and day/night cycle are surface-only concepts.
  drawUnderground(){
    const ctx=this.ctx, W=this.W, H=this.H, z=Camera.zoom;
    ctx.fillStyle='#0a0908'; ctx.fillRect(0,0,W,H);

    const ts=Underground.ts;
    const x0=Math.max(0,((this.worldX(0))/ts|0)-1);
    const y0=Math.max(0,((this.worldY(0))/ts|0)-1);
    const x1=Math.min(Underground.cols-1,((this.worldX(W))/ts|0)+1);
    const y1=Math.min(Underground.rows-1,((this.worldY(H))/ts|0)+1);
    const tilePx=ts*z+1;
    const UCOL={ 0:[34,28,26], 1:[54,46,38], 2:[80,60,30] }; // rock, floor, ore
    for(let r=y0;r<=y1;r++){
      for(let c=x0;c<=x1;c++){
        const tt=Underground.tiles[r*Underground.cols+c];
        const b=UCOL[tt];
        ctx.fillStyle='rgb('+b[0]+','+b[1]+','+b[2]+')';
        ctx.fillRect(this.sx(c*ts)|0, this.sy(r*ts)|0, Math.ceil(tilePx), Math.ceil(tilePx));
      }
    }

    // ore vein glows
    for(const nd of Underground.oreNodes){
      const sx=this.sx(nd.x), sy=this.sy(nd.y);
      if(sx<-20||sx>W+20||sy<-20||sy>H+20) continue;
      const a=0.18+nd.amount*0.35;
      const g=ctx.createRadialGradient(sx,sy,0,sx,sy,10*z);
      g.addColorStop(0,'rgba(220,170,90,'+a+')'); g.addColorStop(1,'rgba(220,170,90,0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,10*z,0,7); ctx.fill();
      if(UI.selected===nd){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,13*z,0,7); ctx.stroke(); }
    }

    // entrances back to the surface
    for(const e of Underground.entrances){
      const sx=this.sx(e.x), sy=this.sy(e.y);
      if(sx<-20||sx>W+20||sy<-20||sy>H+20) continue;
      ctx.strokeStyle='rgba(230,210,180,0.6)'; ctx.lineWidth=Math.max(1,1.2*z);
      ctx.beginPath(); ctx.arc(sx,sy,9*z,0,7); ctx.stroke();
      if(z>0.7){
        ctx.fillStyle='rgba(230,210,180,0.85)';
        ctx.font=(9*z)+'px "Exo 2",sans-serif'; ctx.textAlign='center';
        ctx.fillText('▲ surface', sx, sy-13*z);
        ctx.textAlign='left';
      }
    }

    // agents currently down here
    for(const a of Agents){
      if(!a.underground) continue;
      const sx=this.sx(a.x), sy=this.sy(a.y);
      if(sx<-20||sx>W+20||sy<-20||sy>H+20) continue;
      const fc=Factions[a.faction];
      const rad=Math.max(2.4,3.2*z);
      ctx.fillStyle=fc.color;
      ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.fill();
      if(a.inv && a.inv.ore>0){
        ctx.fillStyle='#e6b455'; ctx.font=(8*Math.min(z,2))+'px sans-serif'; ctx.textAlign='center';
        ctx.fillText('⛏', sx, sy-rad*2);
        ctx.textAlign='left';
      }
      if(UI.selected===a){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,rad*2.3,0,7); ctx.stroke(); }
    }

    const vg=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.35,W/2,H/2,Math.max(W,H)*0.7);
    vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.55)');
    ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);
  },

  draw(){
    if(this.viewMode==='underground'){ this.drawUnderground(); return; }
    const ctx=this.ctx, W=this.W, H=this.H, z=Camera.zoom;
    const day=World.daylight();

    // base sky/void
    ctx.fillStyle='#05060a'; ctx.fillRect(0,0,W,H);

    // screen shake — a brief world-space jolt on violent/sacred moments.
    // Only the living world is displaced; the full-screen lighting washes
    // below are drawn after ctx.restore() so they never leave an edge gap.
    const shakeMag=(typeof FX!=='undefined')?FX.shake:0;
    const shX=shakeMag?(Math.random()-0.5)*shakeMag*2:0;
    const shY=shakeMag?(Math.random()-0.5)*shakeMag*2:0;
    ctx.save(); ctx.translate(shX,shY);

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

    if(this.showField) this.drawFieldOverlay();

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
      if(UI.selected===m){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,10*z,0,7); ctx.stroke(); }
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
      if(UI.selected===nd){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,13*z,0,7); ctx.stroke(); }
    }

    // ── MESH THREADS ──────────────────────────────────────────────────────--
    const threadRange=150, tr2=threadRange*threadRange;
    const warm=Mesh.resonance;
    ctx.lineWidth=Math.max(0.4, 0.8*z);
    for(let i=0;i<Agents.length;i++){
      const a=Agents[i];
      if(a.underground) continue;
      const asx=this.sx(a.x), asy=this.sy(a.y);
      if(asx<-60||asx>W+60||asy<-60||asy>H+60) continue;
      for(let j=i+1;j<Agents.length;j++){
        const b=Agents[j];
        if(b.underground) continue;
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

    // ── BUILD SITES ──────────────────────────────────────────────────────--
    for(const s of World.sites){
      const sx=this.sx(s.x), sy=this.sy(s.y);
      if(sx<-30||sx>W+30||sy<-40||sy>H+30) continue;
      const lvlScale=1+0.16*Math.max(0,s.level-1); // level 2+ literally renders bigger
      if(s.built){
        if(s.type==='farm'){
          const stageCol={empty:'#5c4a32',planted:'#6b8c4a',growing:'#4a7a3a',ready:'#d4a73a'}[s.stage]||'#5c4a32';
          const fw=16*z*lvlScale, fh=10*z*lvlScale;
          ctx.fillStyle=stageCol;
          ctx.fillRect(sx-fw/2, sy-fh/2, fw, fh);
          ctx.strokeStyle='rgba(40,30,20,0.5)'; ctx.lineWidth=Math.max(0.5,0.8*z);
          ctx.strokeRect(sx-fw/2, sy-fh/2, fw, fh);
        } else if(s.type==='well'){
          const r=8*z*lvlScale;
          ctx.fillStyle='#6a6256';
          ctx.beginPath(); ctx.arc(sx,sy,r,0,7); ctx.fill();
          ctx.fillStyle= s.amount>0.5*s.max ? 'rgba(90,160,210,0.85)' : 'rgba(70,90,100,0.5)';
          ctx.beginPath(); ctx.arc(sx,sy,r*0.6,0,7); ctx.fill();
        } else if(s.type==='granary'){
          const fc=Factions[s.faction!=null?s.faction:0];
          const hw=14*z*lvlScale, hh=11*z*lvlScale;
          ctx.fillStyle='#4a3a28';
          ctx.fillRect(sx-hw*0.7, sy-hh*0.1, hw*1.4, hh*1.2);
          ctx.fillStyle=fc.color;
          ctx.beginPath();
          ctx.moveTo(sx-hw*0.85, sy-hh*0.15); ctx.lineTo(sx, sy-hh*1.6); ctx.lineTo(sx+hw*0.85, sy-hh*0.15);
          ctx.closePath(); ctx.fill();
        } else if(s.type==='monument' || s.type==='wonder' || s.type==='citadel' || s.type==='sanctum' || s.type==='greatTemple' || s.type==='caravanserai'){
          // a glowing spire — the Wonder & destiny capstones taller/brighter
          const big=(s.type==='wonder'||s.type==='greatTemple'||s.type==='citadel');
          const h=(big?26:16)*z*lvlScale, w=(big?9:6)*z*lvlScale;
          const gl=ctx.createRadialGradient(sx,sy,0,sx,sy,h*1.4);
          gl.addColorStop(0,'rgba(255,233,176,'+(big?0.5:0.3)+')'); gl.addColorStop(1,'rgba(255,233,176,0)');
          ctx.fillStyle=gl; ctx.beginPath(); ctx.arc(sx,sy,h*1.4,0,7); ctx.fill();
          ctx.fillStyle='#d8c9a8';
          ctx.beginPath(); ctx.moveTo(sx-w,sy); ctx.lineTo(sx,sy-h); ctx.lineTo(sx+w,sy); ctx.closePath(); ctx.fill();
          ctx.fillStyle='rgba(255,233,176,0.95)';
          ctx.beginPath(); ctx.arc(sx,sy-h,w*0.5,0,7); ctx.fill();
        } else {
          this.drawBuilding(ctx, s, sx, sy, z, lvlScale);   // recognizable per-type silhouette; material shows stone-upgrade
        }
        if(z>1.1){
          ctx.fillStyle='rgba(210,225,218,0.8)';
          ctx.font=(7*z)+'px "Exo 2",sans-serif'; ctx.textAlign='center';
          const tag=s.level<s.maxLevel ? ('Lv'+s.level+' · '+Math.round(s.matsWood)+'/'+s.needWood+'w·'+Math.round(s.matsStone)+'/'+s.needStone+'s') : ('Lv'+s.level+' MAX');
          ctx.fillText(tag, sx, sy+15*z*lvlScale);
          ctx.textAlign='left';
        }
        if(s.level<s.maxLevel && s.progress>0){
          ctx.fillStyle='rgba(230,180,100,0.65)';
          ctx.fillRect(sx-10*z*lvlScale, sy+17*z*lvlScale, 20*z*lvlScale*s.progress, 2*z);
        }
        // silhouette buildings now show stone in their own material; farm/well/granary
        // have no such palette, so keep a faint grey ring there as the "mason improved it" mark
        if(s.stoneUpgraded && (s.type==='farm'||s.type==='well'||s.type==='granary')){
          ctx.strokeStyle='rgba(190,190,182,0.7)';
          ctx.lineWidth=Math.max(0.6,1*z);
          ctx.beginPath(); ctx.arc(sx,sy,12*z*lvlScale,0,7); ctx.stroke();
        }
      } else {
        const r=9*z;
        ctx.strokeStyle='rgba(200,190,170,0.4)';
        ctx.lineWidth=Math.max(0.6,1*z);
        ctx.strokeRect(sx-r, sy-r*0.8, r*2, r*1.6);
        if(s.progress>0){
          ctx.fillStyle='rgba(230,180,100,0.45)';
          const fh=r*1.6*s.progress;
          ctx.fillRect(sx-r, sy+r*0.8-fh, r*2, fh);
        }
        if(z>1.2){
          ctx.fillStyle='rgba(200,210,200,0.75)';
          ctx.font=(7*z)+'px "Exo 2",sans-serif'; ctx.textAlign='center';
          ctx.fillText(s.type+' '+Math.round(s.matsWood)+'/'+s.needWood+'w · '+Math.round(s.matsStone)+'/'+s.needStone+'s', sx, sy+r*1.15);
          ctx.textAlign='left';
        }
      }
      if(UI.selected===s){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,18*z*lvlScale,0,7); ctx.stroke(); }
    }

    // ── ANIMALS ───────────────────────────────────────────────────────────--
    for(const an of World.animals){
      if(!an.alive) continue;
      const sx=this.sx(an.x), sy=this.sy(an.y);
      if(sx<-20||sx>W+20||sy<-20||sy>H+20) continue;
      const r=Math.max(2,4*z);
      ctx.fillStyle='#8a6a45';
      ctx.beginPath(); ctx.ellipse(sx,sy,r*1.3,r*0.8,0,0,7); ctx.fill();
      ctx.fillStyle='#6a4e34';
      ctx.beginPath(); ctx.arc(sx-r*1.1,sy-r*0.3,r*0.55,0,7); ctx.fill();
      if(UI.selected===an){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,r*2.2,0,7); ctx.stroke(); }
    }

    // ── RELATIONS (political map) — ally/union warm, feud red-dashed ───────--
    if(World.relations){
      ctx.save(); ctx.lineWidth=Math.max(0.5,1*z);
      for(const key in World.relations){
        const rel=World.relations[key]; if(rel.standing==='NEUTRAL'||rel.standing==='RIVAL') continue;
        const p=key.split('-'); const ga=World.gathers[+p[0]], gb=World.gathers[+p[1]]; if(!ga||!gb) continue;
        const col = rel.standing==='FEUD' ? '220,90,70' : rel.standing==='UNION' ? '150,235,185' : '150,210,170';
        ctx.strokeStyle='rgba('+col+',0.22)';
        ctx.setLineDash(rel.standing==='FEUD'?[3*z,5*z]:[]);
        ctx.beginPath(); ctx.moveTo(this.sx(ga.x),this.sy(ga.y)); ctx.lineTo(this.sx(gb.x),this.sy(gb.y)); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.restore();
    }

    // ── TRADE ROUTES ──────────────────────────────────────────────────────--
    // dashed threads between settlements that trade; brighter/thicker the more
    // the road is travelled. Sea lanes read cool, land roads warm.
    if(World.routes && World.routes.length){
      ctx.save();
      ctx.setLineDash([6*z,6*z]);
      for(const r of World.routes){
        const ga=World.gathers[r.a], gb=World.gathers[r.b];
        if(!ga||!gb) continue;
        const a=Math.min(0.5, 0.08+r.strength*0.03);
        ctx.strokeStyle = r.mode==='sea' ? 'rgba(130,180,210,'+a+')' : 'rgba(224,190,130,'+a+')';
        ctx.lineWidth=Math.max(0.6, Math.min(3,0.6+r.strength*0.12)*z*0.5);
        ctx.beginPath(); ctx.moveTo(this.sx(ga.x),this.sy(ga.y)); ctx.lineTo(this.sx(gb.x),this.sy(gb.y)); ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.restore();
    }

    // ── SETTLEMENT MARKERS + TIER LABELS ─────────────────────────────────--
    for(const g of World.gathers){
      const sx=this.sx(g.x), sy=this.sy(g.y);
      if(sx<-60||sx>W+60||sy<-40||sy>H+40) continue;
      // a soft breathing aura tinted by the settlement's fate — a whisper of its
      // character (RUIN's is dim and small, so a dying town reads as dying)
      const aura=g.fate&&this.FATE_AURA[g.fate];
      if(aura){
        const breath=0.5+0.5*Math.sin(World.tick*0.02+g.x*0.01);
        const rad=(g.fate==='RUIN'?24:42)*z;
        const gr=ctx.createRadialGradient(sx,sy,0,sx,sy,rad);
        gr.addColorStop(0,'rgba('+aura+','+((g.fate==='RUIN'?0.06:0.10)+breath*0.05)+')');
        gr.addColorStop(1,'rgba('+aura+',0)');
        ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.fill();
      }
      const top=g.tier===SETTLEMENT_TIERS.length-1;
      const mr=Math.max(3,5*z);
      ctx.strokeStyle= top ? 'rgba(255,233,176,0.55)' : 'rgba(210,225,218,0.4)';
      ctx.lineWidth=Math.max(1,1.2*z);
      ctx.beginPath(); ctx.arc(sx,sy,mr,0,7); ctx.stroke();
      if(UI.selected===g){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,mr*2,0,7); ctx.stroke(); }
      if(z>0.7 && g.tier>0){
        ctx.fillStyle= top ? 'rgba(255,233,176,0.95)' : 'rgba(210,225,218,0.7)';
        ctx.font=(top?11*z:8*z)+'px "Exo 2",sans-serif'; ctx.textAlign='center';
        ctx.fillText(SETTLEMENT_TIERS[g.tier].name+(g.spec?' · '+g.spec:'')+(g.fate&&g.fate!=='FLEDGLING'?' · '+g.fate:''), sx, sy-34*z);
        ctx.textAlign='left';
      }
    }

    // ── THE ALTAR ─────────────────────────────────────────────────────────--
    {
      const alt=World.altar;
      const sx=this.sx(alt.x), sy=this.sy(alt.y);
      if(!(sx<-60||sx>W+60||sy<-60||sy>H+60)){
        const ar=Math.max(6,10*z);
        const pulse=0.5+0.5*Math.sin(World.tick*0.03);
        const g=ctx.createRadialGradient(sx,sy,0,sx,sy,ar*3);
        g.addColorStop(0,'rgba(255,224,150,'+(0.35+pulse*0.25)+')');
        g.addColorStop(1,'rgba(255,224,150,0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,ar*3,0,7); ctx.fill();
        ctx.fillStyle='rgba(255,224,150,0.9)';
        ctx.beginPath();
        ctx.moveTo(sx,sy-ar); ctx.lineTo(sx+ar*0.7,sy); ctx.lineTo(sx,sy+ar); ctx.lineTo(sx-ar*0.7,sy);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle='rgba(255,233,176,0.7)'; ctx.lineWidth=Math.max(1,1.2*z);
        ctx.stroke();
        if(z>0.7){
          ctx.fillStyle='rgba(255,233,176,0.9)';
          ctx.font=10*z+'px "Exo 2",sans-serif'; ctx.textAlign='center';
          ctx.fillText('THE ALTAR', sx, sy-ar-10*z);
          ctx.textAlign='left';
        }
        if(UI.selected===alt){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,ar*2,0,7); ctx.stroke(); }
      }
    }

    // ── AGENTS ────────────────────────────────────────────────────────────--
    const showGlyph=z>1.15;
    for(const a of Agents){
      if(a.underground) continue;
      const sx=this.sx(a.x), sy=this.sy(a.y);
      if(sx<-20||sx>W+20||sy<-30||sy>H+20) continue;
      const fc=Factions[a.faction];
      const rad=Math.max(2.4,3.2*z);
      // overwhelm / grief desaturate; joy brightens glow
      const glowA=0.25+a.joy*0.4 - a.overwhelmed*0.15;
      if(z>0.6){
        const g=ctx.createRadialGradient(sx,sy,0,sx,sy,rad*3);
        g.addColorStop(0, fc.glow+Math.max(0,glowA)+')'); g.addColorStop(1, fc.glow+'0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,rad*3,0,7); ctx.fill();
      }
      // humanoid figure: legs, clothed torso, arms, head, hair — pose follows the task
      if(z>0.55){
        const pose=(a.task&&a.task.pose)||'walk';
        if(pose==='lie'){
          // sleeping — flat horizontal silhouette
          ctx.fillStyle=fc.color;
          ctx.beginPath(); ctx.ellipse(sx, sy+rad*0.55, rad*1.25, rad*0.5, 0, 0, 7); ctx.fill();
          ctx.fillStyle=a.skin;
          ctx.beginPath(); ctx.arc(sx-rad*1.05, sy+rad*0.5, rad*0.48, 0, 7); ctx.fill();
          ctx.fillStyle=a.hair;
          ctx.beginPath(); ctx.arc(sx-rad*1.2, sy+rad*0.42, rad*0.4, Math.PI*0.5, Math.PI*1.5); ctx.fill();
        } else {
          const moving=Math.hypot(a.vx,a.vy)>0.04;
          const swing= pose==='work' ? Math.sin(a.walkPhase)*rad*0.5
                     : (moving && pose==='walk') ? Math.sin(a.walkPhase)*rad*0.55 : 0;
          const drop= pose==='kneel' ? rad*0.55 : pose==='sit' ? rad*0.35 : 0;
          ctx.lineCap='round';
          ctx.strokeStyle='rgba(35,26,20,0.85)';
          ctx.lineWidth=Math.max(1,rad*0.3);
          ctx.beginPath();
          if(pose==='kneel'){
            // both legs folded under, bent at the knee
            ctx.moveTo(sx-rad*0.26, sy+rad*0.15); ctx.lineTo(sx-rad*0.5, sy+rad*1.0);
            ctx.moveTo(sx+rad*0.26, sy+rad*0.15); ctx.lineTo(sx+rad*0.5, sy+rad*1.0);
          } else if(pose==='sit'){
            // bent seated legs, knees forward
            ctx.moveTo(sx-rad*0.26, sy+rad*0.3); ctx.lineTo(sx-rad*0.6, sy+rad*0.95);
            ctx.moveTo(sx+rad*0.26, sy+rad*0.3); ctx.lineTo(sx+rad*0.6, sy+rad*0.95);
          } else {
            // fixed stance for 'work', walk-cycle swing otherwise
            ctx.moveTo(sx-rad*0.26, sy+rad*0.45); ctx.lineTo(sx-rad*0.26+(pose==='work'?0:swing*0.4), sy+rad*1.55);
            ctx.moveTo(sx+rad*0.26, sy+rad*0.45); ctx.lineTo(sx+rad*0.26-(pose==='work'?0:swing*0.4), sy+rad*1.55);
          }
          ctx.stroke();
          // torso — clothing colored by faction
          ctx.fillStyle=fc.color;
          ctx.beginPath();
          ctx.moveTo(sx-rad*0.6, sy+rad*0.5-drop);
          ctx.lineTo(sx-rad*0.68, sy-rad*0.35-drop);
          ctx.lineTo(sx+rad*0.68, sy-rad*0.35-drop);
          ctx.lineTo(sx+rad*0.6, sy+rad*0.5-drop);
          ctx.closePath(); ctx.fill();
          // arms
          ctx.strokeStyle=fc.color;
          ctx.lineWidth=Math.max(0.8,rad*0.22);
          ctx.beginPath();
          if(pose==='kneel'){
            // one arm reaching down toward the ground
            ctx.moveTo(sx-rad*0.64, sy-rad*0.1-drop); ctx.lineTo(sx-rad*0.5, sy+rad*0.4);
            ctx.moveTo(sx+rad*0.64, sy-rad*0.1-drop); ctx.lineTo(sx+rad*0.25, sy+rad*0.6);
          } else if(pose==='work'){
            // tool-swing arm driven by walkPhase, even while stationary
            ctx.moveTo(sx-rad*0.64, sy-rad*0.1); ctx.lineTo(sx-rad*0.86, sy+rad*0.4);
            ctx.moveTo(sx+rad*0.64, sy-rad*0.1); ctx.lineTo(sx+rad*0.7+swing*0.55, sy+rad*0.15+Math.abs(swing)*0.5);
          } else {
            ctx.moveTo(sx-rad*0.64, sy-rad*0.1-drop); ctx.lineTo(sx-rad*0.86-swing*0.3, sy+rad*0.4-drop);
            ctx.moveTo(sx+rad*0.64, sy-rad*0.1-drop); ctx.lineTo(sx+rad*0.86+swing*0.3, sy+rad*0.4-drop);
          }
          ctx.stroke();
          ctx.lineCap='butt';
          // head — skin tone
          ctx.fillStyle=a.skin;
          ctx.beginPath(); ctx.arc(sx, sy-rad*0.95-drop, rad*0.52, 0, 7); ctx.fill();
          // hair
          ctx.fillStyle=a.hair;
          ctx.beginPath(); ctx.arc(sx, sy-rad*1.16-drop, rad*0.55, Math.PI, 0); ctx.fill();
        }
      } else {
        ctx.fillStyle=fc.color;
        ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.fill();
      }
      // carried-resource indicator
      if(z>1 && a.inv){
        const carry = a.inv.wood>0?['╪','#c89060'] : a.inv.stone>0?['◈','#aab0bc'] : (a.inv.ore||0)>0?['⛏','#e6b455'] : a.inv.food>0?['✿','#9fd08a'] : a.inv.water>0?['≈','#7fb8d8'] : null;
        if(carry){ ctx.fillStyle=carry[1]; ctx.font=(8*Math.min(z,2))+'px sans-serif'; ctx.textAlign='center'; ctx.fillText(carry[0], sx+rad*1.15, sy-rad*1.7); ctx.textAlign='left'; }
      }
      // grieving marker
      if(a.grieving>0.4 && z>1){ ctx.fillStyle='rgba(184,155,217,0.8)'; ctx.beginPath(); ctx.arc(sx,sy-rad*2.4,1.2*z,0,7); ctx.fill(); }
      // faint belief spark — a whisper of what this soul holds dear, so a devout
      // crowd reads different from a mercantile one (only close in, kept subtle)
      if(z>1.05 && a.ideals){ const bc=this.BELIEF_COLOR[a.dominantIdeal()]; if(bc){ ctx.fillStyle='rgba('+bc+',0.5)'; ctx.beginPath(); ctx.arc(sx,sy-rad*1.85,0.9*z,0,7); ctx.fill(); } }
      // selection ring
      if(UI.selected===a){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,rad*2.3,0,7); ctx.stroke(); }
      // action glyph
      if(showGlyph && a.task && a.task.glyph){
        ctx.fillStyle='rgba(220,235,228,0.82)';
        ctx.font=(9*Math.min(z,2))+'px "Exo 2",sans-serif';
        ctx.textAlign='center';
        ctx.fillText(a.task.glyph, sx, sy-rad*2.6);
      }
      // caravan runner marker — these agents run a self-contained trip with no
      // task, so the action glyph above never fires for them
      if(a.caravan && z>0.7){
        ctx.fillStyle='rgba(235,205,140,0.92)';
        ctx.font=(9*Math.min(z,2))+'px "Exo 2",sans-serif';
        ctx.textAlign='center';
        ctx.fillText('⇶', sx, sy-rad*2.6);
      }
    }
    ctx.textAlign='left';

    // ── PRESENCE FX (particle blooms, shockwave rings, floating glyphs) ────--
    if(typeof FX!=='undefined') this.drawFX();

    ctx.restore(); // end screen-shake displacement

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

    // the world's Age as a barely-there colour grade — you notice the light has
    // changed before you notice why (an Age of Faith glows faintly violet, of
    // Iron cold, of Silence drained)
    const at=this.AGE_TINT[World.age];
    if(at){ ctx.fillStyle='rgba('+at[0]+','+at[1]+','+at[2]+',0.035)'; ctx.fillRect(0,0,W,H); }

    // gentle vignette
    const vg=ctx.createRadialGradient(W/2,H/2,Math.min(W,H)*0.4,W/2,H/2,Math.max(W,H)*0.75);
    vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.4)');
    ctx.fillStyle=vg; ctx.fillRect(0,0,W,H);

    // one-frame full-screen wash for the biggest moments (judgment, etc.)
    if(typeof FX!=='undefined' && FX.flash){
      ctx.fillStyle='rgba('+FX.flash.col+','+FX.flash.a+')';
      ctx.fillRect(0,0,W,H);
      FX.flash=null;
    }
  },

  // the presence layer, drawn in world space inside the shaken block
  drawFX(){
    const ctx=this.ctx, z=Camera.zoom, W=this.W, H=this.H;
    // shockwave rings (with optional soft glow fill)
    for(const r of FX.rings){
      const sx=this.sx(r.x), sy=this.sy(r.y), rad=r.r*z;
      if(sx<-rad-30||sx>W+rad+30||sy<-rad-30||sy>H+rad+30) continue;
      const a=Math.max(0,r.life)*0.85;
      if(r.glow){
        const g=ctx.createRadialGradient(sx,sy,rad*0.25,sx,sy,rad);
        g.addColorStop(0,'rgba('+r.col+',0)');
        g.addColorStop(0.78,'rgba('+r.col+','+(a*0.22)+')');
        g.addColorStop(1,'rgba('+r.col+',0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.fill();
      }
      ctx.strokeStyle='rgba('+r.col+','+a+')'; ctx.lineWidth=Math.max(0.5,r.width*z);
      ctx.beginPath(); ctx.arc(sx,sy,rad,0,7); ctx.stroke();
    }
    // particles
    for(const p of FX.particles){
      const sx=this.sx(p.x), sy=this.sy(p.y);
      if(sx<-24||sx>W+24||sy<-24||sy>H+24) continue;
      const a=Math.max(0,(p.fade==='out')?p.life:1), rr=Math.max(0.6,p.r*z);
      if(p.kind==='soft'){
        const g=ctx.createRadialGradient(sx,sy,0,sx,sy,rr*2.6);
        g.addColorStop(0,'rgba('+p.col+','+(a*0.9)+')'); g.addColorStop(1,'rgba('+p.col+',0)');
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx,sy,rr*2.6,0,7); ctx.fill();
      } else if(p.kind==='petal'){
        ctx.save(); ctx.translate(sx,sy); ctx.rotate(p.rot);
        ctx.fillStyle='rgba('+p.col+','+(a*0.7)+')';
        ctx.beginPath(); ctx.ellipse(0,0,rr*1.4,rr*0.6,0,0,7); ctx.fill(); ctx.restore();
      } else if(p.kind==='spark'){
        ctx.fillStyle='rgba('+p.col+','+a+')';
        ctx.fillRect(sx-rr*0.5,sy-rr*0.5,rr,rr);
      } else {
        ctx.fillStyle='rgba('+p.col+','+a+')';
        ctx.beginPath(); ctx.arc(sx,sy,rr,0,7); ctx.fill();
      }
    }
    // floating glyphs (rare, for named milestones)
    if(FX.glyphs.length){
      ctx.textAlign='center';
      for(const gl of FX.glyphs){
        const sx=this.sx(gl.x), sy=this.sy(gl.y);
        ctx.fillStyle='rgba('+gl.col+','+Math.max(0,gl.life)+')';
        ctx.font='700 '+(gl.size*Math.min(z,1.6))+'px "Exo 2",sans-serif';
        ctx.fillText(gl.text,sx,sy);
      }
      ctx.textAlign='left';
    }
  },

  hexA(hex,a){
    const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    return 'rgba('+r+','+g+','+b+','+a+')';
  },

  // ── per-building silhouettes ────────────────────────────────────────────--
  // Each functional structure gets a recognizable shape, and its MATERIAL reads
  // at a glance: timber (dark brown, faction-colored roof) until the masons
  // touch it, then STONE (grey walls, slate roof) — the "mason improved it" made
  // visible. Signature upgrades (s.up[...]) add a cheap decorator on top.
  drawBuilding(ctx, s, sx, sy, z, lvlScale){
    const u=z*lvlScale;                                   // base unit
    const fc=Factions[s.faction!=null?s.faction:0];
    const stone=s.stoneUpgraded;
    const wall  = stone ? '#6b6b63' : '#3a2c1e';
    const wallDk= stone ? '#54544d' : '#2a1f15';
    const roof  = stone ? '#7d8a90' : fc.color;           // slate when stone, faction banner when timber
    const acc   = fc.color;                               // faction accent (banners/trim) always shows allegiance
    const lvl=s.level||1;
    const up=s.up||{};                                    // signature-upgrade flags (Phase 3)
    const glow=z>0.9;                                     // gate soft radial glows behind zoom to keep perf
    const box=(x,y,w,h,c)=>{ ctx.fillStyle=c; ctx.fillRect(sx+x*u, sy+y*u, w*u, h*u); };
    const tri=(x1,y1,x2,y2,x3,y3,c)=>{ ctx.fillStyle=c; ctx.beginPath();
      ctx.moveTo(sx+x1*u,sy+y1*u); ctx.lineTo(sx+x2*u,sy+y2*u); ctx.lineTo(sx+x3*u,sy+y3*u); ctx.closePath(); ctx.fill(); };
    const dot=(x,y,r,c)=>{ ctx.fillStyle=c; ctx.beginPath(); ctx.arc(sx+x*u,sy+y*u,r*u,0,7); ctx.fill(); };
    const halo=(x,y,r,rgb)=>{ if(!glow) return; const g=ctx.createRadialGradient(sx+x*u,sy+y*u,0,sx+x*u,sy+y*u,r*u);
      g.addColorStop(0,'rgba('+rgb+',0.5)'); g.addColorStop(1,'rgba('+rgb+',0)');
      ctx.fillStyle=g; ctx.beginPath(); ctx.arc(sx+x*u,sy+y*u,r*u,0,7); ctx.fill(); };

    switch(s.type){
      case 'workshop': {          // low body + shed roof + chimney + gear
        box(-7,-4,14,8,wall);
        tri(-8,-4, -8,-8, 8,-4, roof);           // slanted shed roof
        box(4,-11,2,5,wallDk);                    // chimney
        dot(0,0,2.2,stone?'#8a8a80':'#5a4632'); dot(0,0,1,wallDk); // gear hub
        if(up.guildForge){ dot(0,0,3.2,'rgba(224,160,96,0.5)'); }
        break; }
      case 'market': {            // stall + striped awning
        box(-8,-3,16,7,wall);
        for(let i=0;i<5;i++){ box(-8+i*3.2,-7,3.2,4, i%2? acc : '#e8dcc0'); }  // candy-stripe awning
        if(up.grandBazaar){ tri(0,-14,-4,-9,4,-9,acc); dot(0,-14,1,'#ffe9b0'); } // pennant
        break; }
      case 'shrineHall': {        // walls + dome + halo
        halo(0,-9,13,'201,184,232');
        box(-6,-4,12,8,wall);
        ctx.fillStyle=roof; ctx.beginPath(); ctx.arc(sx,sy-4*u,6*u,3.14,0); ctx.fill(); // dome
        dot(0,-11,1.3,'#f0e6ff');
        if(up.reliquary){ dot(0,-11,2.6,'rgba(201,184,232,0.6)'); }
        break; }
      case 'loreHall': {          // two-story shelved hall
        box(-8,-10,16,14,wall);
        box(-8,-3,16,0.6,wallDk); box(-8,-6,16,0.6,wallDk); // floor lines
        for(let i=0;i<4;i++) box(-7+i*3.6,-9,0.7,5,acc);    // shelf spines
        tri(-9,-10, 0,-15, 9,-10, roof);
        if(up.greatLibrary){ box(-9,-16,18,1.4,acc); }      // gilt cornice
        break; }
      case 'huntingLodge': {      // A-frame + antlers
        tri(-8,4, 0,-11, 8,4, roof);
        box(-6,-1,12,5,wall);
        ctx.strokeStyle=stone?'#9a9a90':'#b9a074'; ctx.lineWidth=Math.max(0.5,0.8*u);
        ctx.beginPath();
        ctx.moveTo(sx-2*u,sy-11*u); ctx.lineTo(sx-4*u,sy-15*u); ctx.moveTo(sx-2*u,sy-12*u); ctx.lineTo(sx-5*u,sy-13*u);
        ctx.moveTo(sx+2*u,sy-11*u); ctx.lineTo(sx+4*u,sy-15*u); ctx.moveTo(sx+2*u,sy-12*u); ctx.lineTo(sx+5*u,sy-13*u);
        ctx.stroke();
        break; }
      case 'smithy': {            // forge: body + tall chimney + ember glow + anvil
        halo(5,-9,7,'255,150,60');
        box(-7,-4,14,8,wall);
        tri(-8,-4,-8,-8,8,-4,roof);
        box(4,-13,3,7,wallDk);                    // forge chimney
        dot(5,-13,1.3,'#ff9a3a');                  // ember at the stack
        box(-6,3,5,2,stone?'#3a3a36':'#20160e');   // anvil block
        if(up.armory){ box(-8,-6,3,3,acc); }        // shield on the wall
        break; }
      case 'masonry': {           // stone-block body + scaffold
        box(-7,-6,14,10, stone?'#78786e':'#5a5148');   // masonry always reads stony
        for(let i=0;i<3;i++) box(-7,-6+i*3.3,14,0.6,'#3a3a34'); // course lines
        ctx.strokeStyle='rgba(150,130,90,0.8)'; ctx.lineWidth=Math.max(0.5,0.7*u);
        ctx.beginPath(); ctx.moveTo(sx-8*u,sy-10*u); ctx.lineTo(sx-8*u,sy+4*u);
        ctx.moveTo(sx-8*u,sy-6*u); ctx.lineTo(sx+2*u,sy-11*u); ctx.stroke();  // scaffold pole + plank
        if(up.masterMasons){ tri(-8,-10,0,-14,8,-10,'#9aa0a0'); }              // capping pediment
        break; }
      case 'townHall': {          // civic hall: wide body + dome + banner
        box(-9,-5,18,9,wall);
        ctx.fillStyle=roof; ctx.beginPath(); ctx.arc(sx,sy-5*u,5*u,3.14,0); ctx.fill(); // dome
        box(0,-16,0.8,5,wallDk); tri(0.8,-16,0.8,-13,5,-14.5,acc);  // flag
        for(let i=0;i<4;i++) box(-8+i*4.5,-4,1.4,7,wallDk);         // pilasters
        if(up.highCourt){ dot(0,-16,1.4,'#ffe9b0'); }               // gilt finial
        break; }
      case 'barracks': {          // crenellated fort + tower + banner
        box(-8,-4,16,9,wall);
        for(let i=0;i<5;i++) box(-8+i*3.4,-6,1.8,2,wall);   // battlements
        box(5,-12,4,8,wallDk);                               // corner tower
        for(let i=0;i<2;i++) box(5+i*2.2,-13,1.4,1.6,wallDk);
        box(7,-18,0.8,6,'#20160e'); tri(7.8,-18,7.8,-15,11,-16.5,acc); // banner
        if(up.watchtower){ box(5,-16,4,4,wall); dot(7,-16,1,'#ffd27a'); } // raised watch light
        break; }
      case 'harbor': {            // dock + moored boat
        box(-9,2,18,2,'#4a3a28');                            // pier planks
        for(let i=0;i<4;i++) box(-8+i*5,4,1,3,wallDk);       // pilings
        ctx.fillStyle=wall; ctx.beginPath();                 // hull
        ctx.moveTo(sx-6*u,sy-2*u); ctx.lineTo(sx+6*u,sy-2*u); ctx.lineTo(sx+4*u,sy+2*u); ctx.lineTo(sx-4*u,sy+2*u); ctx.closePath(); ctx.fill();
        box(-0.4,-11,0.8,9,wallDk); tri(0.4,-11,0.4,-4,5,-7,acc); // mast + sail
        break; }
      case 'temple': {            // columned temple + pediment + halo
        halo(0,-8,14,'255,233,176');
        box(-9,-2,18,6,wall);
        for(let i=0;i<5;i++) box(-8+i*4,-2,1.6,6,stone?'#8a8a80':'#5a4a34'); // columns
        tri(-10,-2, 0,-11, 10,-2, roof);                    // pediment
        dot(0,-13,1.4,'#fff2c8');
        if(up.grandSanctuary){ dot(0,-13,3,'rgba(255,233,176,0.65)'); box(-11,-2,22,1,'#d8c9a8'); }
        break; }
      case 'tavern': {            // body + hearth glow + hanging sign
        halo(-2,0,9,'255,170,70');
        box(-7,-5,14,9,wall);
        tri(-8,-5,-8,-9,8,-5,roof);
        box(6,-6,0.7,4,wallDk); box(5,-3,3,2.4,'#6a4a2a'); dot(6.5,-1.8,0.5,acc); // swinging sign
        dot(-2,1,1.3,'rgba(255,170,70,0.9)');               // hearth
        if(up.grandHall){ box(-8,-11,16,1.4,acc); }
        break; }
      case 'quarry': {            // stepped pit + crane
        box(-8,-2,16,6,'#4a443a');
        box(-6,0,12,4,'#5a5248'); box(-4,2,8,3,'#6a6258'); // descending stone steps
        ctx.strokeStyle='#6a5a3a'; ctx.lineWidth=Math.max(0.5,0.9*u);
        ctx.beginPath(); ctx.moveTo(sx-6*u,sy+4*u); ctx.lineTo(sx-6*u,sy-9*u); ctx.lineTo(sx+3*u,sy-11*u); ctx.stroke(); // crane
        dot(3,-11,0.8,'#3a3a34');
        if(up.deepQuarry){ box(-9,-4,18,1,'#8a8a80'); }
        break; }
      case 'mine': {              // headframe over a dark shaft
        box(-4,-1,8,6,'#1a140c');                            // shaft mouth
        tri(-7,4, 0,-12, 7,4, wallDk);                       // A-frame headframe
        box(-0.5,-12,1,4,wallDk); dot(0,-12,1,acc);          // pulley wheel
        ctx.strokeStyle=wallDk; ctx.lineWidth=Math.max(0.5,0.8*u);
        ctx.beginPath(); ctx.moveTo(sx,sy-12*u); ctx.lineTo(sx,sy-1*u); ctx.stroke(); // cable
        break; }
      default: {                  // hut / cottage — the common dwelling
        box(-6.5,-1,13,6,wall);
        tri(-8,-1, 0,-9, 8,-1, roof);
        box(-4,1,3,4,wallDk);                                // door
        if(lvl>=3){ box(3,-8,2,5,wallDk); dot(4,-8,0.8,'rgba(200,200,190,0.6)'); } // chimney + smoke
        if(up.hearthstone){ dot(-2.5,3,0.7,'rgba(255,170,70,0.8)'); }              // lit hearth
        break; }
    }
  }
};
