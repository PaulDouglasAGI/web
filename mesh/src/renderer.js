/* renderer.js — terrain, mesh threads, agents, lighting, seasons, camera */
'use strict';

const Camera={ x:0, y:0, zoom:1, minZoom:0.35, maxZoom:3.2 };

const Renderer={
  cnv:null, ctx:null, W:0, H:0, dpr:1,

  // base terrain colors [r,g,b]
  TCOL:{
    0:[26,52,74],   // water
    1:[58,86,78],   // shore — wet rock/reed edge, not sand
    2:[64,92,54],   // plain
    3:[36,68,40],   // forest
    4:[76,80,90],   // hill — cool slate/granite, buildable, resists going sandy-tan under warm season tints
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
        } else {
          const fc=Factions[s.faction!=null?s.faction:0];
          const hw=10*z*lvlScale, hh=8*z*lvlScale;
          ctx.fillStyle='#3a2c1e';
          ctx.fillRect(sx-hw*0.65, sy-hh*0.15, hw*1.3, hh*1.15);
          ctx.fillStyle=fc.color;
          ctx.beginPath();
          ctx.moveTo(sx-hw*0.8, sy-hh*0.2); ctx.lineTo(sx, sy-hh*1.4); ctx.lineTo(sx+hw*0.8, sy-hh*0.2);
          ctx.closePath(); ctx.fill();
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
        if(s.stoneUpgraded){
          ctx.strokeStyle='rgba(190,190,182,0.9)';
          ctx.lineWidth=Math.max(0.8,1.2*z);
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

    // ── SETTLEMENT MARKERS + TIER LABELS ─────────────────────────────────--
    for(const g of World.gathers){
      const sx=this.sx(g.x), sy=this.sy(g.y);
      if(sx<-60||sx>W+60||sy<-40||sy>H+40) continue;
      const top=g.tier===SETTLEMENT_TIERS.length-1;
      const mr=Math.max(3,5*z);
      ctx.strokeStyle= top ? 'rgba(255,233,176,0.55)' : 'rgba(210,225,218,0.4)';
      ctx.lineWidth=Math.max(1,1.2*z);
      ctx.beginPath(); ctx.arc(sx,sy,mr,0,7); ctx.stroke();
      if(UI.selected===g){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,mr*2,0,7); ctx.stroke(); }
      if(z>0.7 && g.tier>0){
        ctx.fillStyle= top ? 'rgba(255,233,176,0.95)' : 'rgba(210,225,218,0.7)';
        ctx.font=(top?11*z:8*z)+'px "Exo 2",sans-serif'; ctx.textAlign='center';
        ctx.fillText(SETTLEMENT_TIERS[g.tier].name, sx, sy-34*z);
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
        const carry = a.inv.wood>0?['╪','#c89060'] : a.inv.stone>0?['◈','#aab0bc'] : a.inv.food>0?['✿','#9fd08a'] : a.inv.water>0?['≈','#7fb8d8'] : null;
        if(carry){ ctx.fillStyle=carry[1]; ctx.font=(8*Math.min(z,2))+'px sans-serif'; ctx.textAlign='center'; ctx.fillText(carry[0], sx+rad*1.15, sy-rad*1.7); ctx.textAlign='left'; }
      }
      // grieving marker
      if(a.grieving>0.4 && z>1){ ctx.fillStyle='rgba(184,155,217,0.8)'; ctx.beginPath(); ctx.arc(sx,sy-rad*2.4,1.2*z,0,7); ctx.fill(); }
      // selection ring
      if(UI.selected===a){ ctx.strokeStyle='rgba(255,255,255,0.85)'; ctx.lineWidth=Math.max(1,1.4*z); ctx.beginPath(); ctx.arc(sx,sy,rad*2.3,0,7); ctx.stroke(); }
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
