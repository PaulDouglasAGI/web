/* ui.js — ambient UI, camera input (pan/zoom only), agent inspector */
'use strict';

const UI={
  el:{}, focus:null, hintFaded:false, _t:0,

  init(){
    this.el.season=document.getElementById('season');
    this.el.tod=document.getElementById('timeofday');
    this.el.res=document.getElementById('resonance-glyph');
    this.el.pop=document.getElementById('pop');
    this.el.insp=document.getElementById('inspector');
    this.el.iname=document.getElementById('insp-name');
    this.el.ifac=document.getElementById('insp-faction');
    this.el.iact=document.getElementById('insp-action');
    this.el.hint=document.getElementById('hint');
    this.bindCamera();
  },

  bindCamera(){
    const cnv=Renderer.cnv;
    let dragging=false, lx=0, ly=0, moved=0;
    const start=(x,y)=>{ dragging=true; lx=x; ly=y; moved=0; cnv.classList.add('dragging'); this.fadeHint(); };
    const move=(x,y)=>{ if(!dragging) return; const dx=(x-lx)/Camera.zoom, dy=(y-ly)/Camera.zoom; Camera.x-=dx; Camera.y-=dy; moved+=Math.abs(dx)+Math.abs(dy); lx=x; ly=y; this.clampCam(); };
    const end=()=>{ dragging=false; cnv.classList.remove('dragging'); };

    cnv.addEventListener('mousedown',e=>start(e.clientX,e.clientY));
    window.addEventListener('mousemove',e=>move(e.clientX,e.clientY));
    window.addEventListener('mouseup',end);
    cnv.addEventListener('wheel',e=>{ e.preventDefault(); this.zoomAt(e.clientX,e.clientY, e.deltaY<0?1.12:0.89); this.fadeHint(); },{passive:false});

    // touch
    let pinchD=0;
    cnv.addEventListener('touchstart',e=>{ if(e.touches.length===1) start(e.touches[0].clientX,e.touches[0].clientY); else if(e.touches.length===2) pinchD=this.touchDist(e); },{passive:false});
    cnv.addEventListener('touchmove',e=>{ e.preventDefault();
      if(e.touches.length===1) move(e.touches[0].clientX,e.touches[0].clientY);
      else if(e.touches.length===2){ const d=this.touchDist(e); if(pinchD>0){ const cx=(e.touches[0].clientX+e.touches[1].clientX)/2, cy=(e.touches[0].clientY+e.touches[1].clientY)/2; this.zoomAt(cx,cy,d/pinchD); } pinchD=d; }
    },{passive:false});
    cnv.addEventListener('touchend',e=>{ if(e.touches.length===0) end(); pinchD=0; });
  },
  touchDist(e){ const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY; return Math.hypot(dx,dy); },

  zoomAt(px,py,factor){
    const wx=Renderer.worldX(px), wy=Renderer.worldY(py);
    Camera.zoom=Math.max(Camera.minZoom,Math.min(Camera.maxZoom,Camera.zoom*factor));
    // keep point under cursor stable
    Camera.x=wx-(px-Renderer.W/2)/Camera.zoom;
    Camera.y=wy-(py-Renderer.H/2)/Camera.zoom;
    this.clampCam();
  },
  clampCam(){
    Camera.x=Math.max(0,Math.min(World.w,Camera.x));
    Camera.y=Math.max(0,Math.min(World.h,Camera.y));
  },
  fadeHint(){ if(!this.hintFaded){ this.hintFaded=true; this.el.hint.classList.add('fade'); } },

  update(){
    this._t++;
    if(this._t%15===0){
      this.el.season.textContent=World.seasonName();
      this.el.tod.textContent=World.phaseName();
      this.el.pop.textContent=Agents.length+' souls';
      // resonance glyph warmth
      const r=Mesh.resonance;
      const warm=Math.round(120+r*135), cool=Math.round(120+(1-r)*60);
      this.el.res.style.background='radial-gradient(circle at 50% 50%,rgba('+warm+','+(warm-30)+','+cool+',0.92),rgba('+warm+','+(warm-50)+','+cool+',0.12) 60%,transparent 75%)';
      this.el.res.style.boxShadow='0 0 '+(14+r*30)+'px rgba('+warm+','+(warm-40)+','+cool+','+(0.3+r*0.4)+')';
    }

    // inspector: focus nearest agent to screen center when zoomed in
    if(Camera.zoom>1.15){
      const cwx=Renderer.worldX(Renderer.W/2), cwy=Renderer.worldY(Renderer.H/2);
      let best=null,bd=Infinity;
      for(const a of Agents){ const d=dist2(a.x,a.y,cwx,cwy); if(d<bd){bd=d;best=a;} }
      if(best && bd< (140/Camera.zoom)**2 *Camera.zoom){
        this.focus=best;
        const sx=Renderer.sx(best.x), sy=Renderer.sy(best.y);
        this.el.insp.style.left=sx+'px'; this.el.insp.style.top=sy+'px';
        this.el.insp.classList.add('show');
        this.el.iname.textContent=best.name+'  ·  '+Math.floor(best.age);
        const fc=Factions[best.faction];
        this.el.ifac.textContent=fc.name; this.el.ifac.style.color=fc.color;
        this.el.iact.textContent=best.task?best.task.label:'…';
      } else { this.el.insp.classList.remove('show'); this.focus=null; }
    } else { this.el.insp.classList.remove('show'); this.focus=null; }
  }
};
