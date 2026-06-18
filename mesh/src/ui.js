/* ui.js — ambient UI, camera input (pan/zoom/tap), sim speed, deep agent inspector */
'use strict';

function setBar(el,frac){ el.style.width=Math.round(Math.max(0,Math.min(1,frac))*100)+'%'; }

const UI={
  el:{}, selected:null, hintFaded:false, _t:0,

  init(){
    this.el.season=document.getElementById('season');
    this.el.tod=document.getElementById('timeofday');
    this.el.res=document.getElementById('resonance-glyph');
    this.el.pop=document.getElementById('pop');
    this.el.hint=document.getElementById('hint');

    this.el.panel=document.getElementById('agent-panel');
    this.el.panelClose=document.getElementById('panel-close');
    this.el.pName=document.getElementById('panel-name');
    this.el.pFaction=document.getElementById('panel-faction');
    this.el.pAge=document.getElementById('panel-age');
    this.el.pAction=document.getElementById('panel-action');
    this.el.pBondRow=document.getElementById('panel-bond-row');
    this.el.pBond=document.getElementById('panel-bond');
    this.el.pInv=document.getElementById('panel-inv');
    this.el.pMemLabel=document.getElementById('panel-mem-label');
    this.el.pMem=document.getElementById('panel-mem');
    this.el.barEnergy=document.getElementById('bar-energy');
    this.el.barHunger=document.getElementById('bar-hunger');
    this.el.barSocial=document.getElementById('bar-social');
    this.el.barJoy=document.getElementById('bar-joy');
    this.el.statLabel1=document.getElementById('stat-label-1');
    this.el.statLabel2=document.getElementById('stat-label-2');
    this.el.statLabel3=document.getElementById('stat-label-3');
    this.el.statLabel4=document.getElementById('stat-label-4');
    this.el.panelClose.addEventListener('click',e=>{ e.stopPropagation(); this.deselect(); });

    this.el.speedBtns=Array.from(document.querySelectorAll('#speed-ctl button'));
    for(const b of this.el.speedBtns){
      b.addEventListener('click',()=>{
        Sim.speed=parseFloat(b.dataset.spd);
        for(const o of this.el.speedBtns) o.classList.remove('active');
        b.classList.add('active');
      });
    }

    this.bindCamera();
  },

  bindCamera(){
    const cnv=Renderer.cnv;
    let dragging=false, lx=0, ly=0, moved=0, downX=0, downY=0;
    const start=(x,y)=>{ dragging=true; lx=x; ly=y; downX=x; downY=y; moved=0; cnv.classList.add('dragging'); this.fadeHint(); };
    const move=(x,y)=>{ if(!dragging) return; const dx=(x-lx)/Camera.zoom, dy=(y-ly)/Camera.zoom; Camera.x-=dx; Camera.y-=dy; moved+=Math.abs(dx)+Math.abs(dy); lx=x; ly=y; this.clampCam(); };
    const end=()=>{ dragging=false; cnv.classList.remove('dragging'); if(moved<6) this.handleTap(downX,downY); };

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

  handleTap(px,py){
    const wx=Renderer.worldX(px), wy=Renderer.worldY(py);
    const tol=26/Camera.zoom;
    let best=null,bd=Infinity,kind=null;
    for(const a of Agents){ const d=dist2(a.x,a.y,wx,wy); if(d<bd){ bd=d; best=a; kind='agent'; } }
    for(const s of World.sites){ const d=dist2(s.x,s.y,wx,wy); if(d<bd){ bd=d; best=s; kind='site'; } }
    for(const nd of World.nodes){ const d=dist2(nd.x,nd.y,wx,wy); if(d<bd){ bd=d; best=nd; kind='node'; } }
    for(const an of World.animals){ if(!an.alive) continue; const d=dist2(an.x,an.y,wx,wy); if(d<bd){ bd=d; best=an; kind='animal'; } }
    for(const m of Marks){ const d=dist2(m.x,m.y,wx,wy); if(d<bd){ bd=d; best=m; kind='mark'; } }
    if(best && bd<tol*tol) this.select(best,kind);
    else this.deselect();
  },
  select(obj,kind){ this.selected=obj; this.selKind=kind||'agent'; this.el.panel.classList.add('show'); this.renderPanel(); },
  deselect(){ this.selected=null; this.selKind=null; this.el.panel.classList.remove('show'); },

  setStatLabels(l1,l2,l3,l4){
    this.el.statLabel1.textContent=l1; this.el.statLabel2.textContent=l2;
    this.el.statLabel3.textContent=l3; this.el.statLabel4.textContent=l4;
  },
  setExtras(show){
    const d=show?'':'none';
    this.el.pBondRow.style.display=d; this.el.pInv.style.display=d;
    this.el.pMemLabel.style.display=d; this.el.pMem.style.display=d;
  },

  renderPanel(){
    const o=this.selected; if(!o) return;
    if(this.selKind==='site') this.renderSitePanel(o);
    else if(this.selKind==='node') this.renderNodePanel(o);
    else if(this.selKind==='animal') this.renderAnimalPanel(o);
    else if(this.selKind==='mark') this.renderMarkPanel(o);
    else this.renderAgentPanel(o);
  },

  renderAgentPanel(a){
    this.setExtras(true);
    this.setStatLabels('energy','hunger','social','joy');
    const fc=Factions[a.faction];
    this.el.pName.textContent=a.name;
    this.el.pFaction.textContent=fc.name;
    this.el.pFaction.style.color=fc.color;
    this.el.pAge.textContent='age '+Math.floor(a.age)+(a.bond?' · bonded':'');
    this.el.pAction.textContent=a.task?(a.task.glyph+'  '+a.task.label):'…';
    setBar(this.el.barEnergy, a.energy/100);
    setBar(this.el.barHunger, a.hunger/100);
    setBar(this.el.barSocial, a.social/100);
    setBar(this.el.barJoy, a.joy);
    const partner=a.bond?agentById(a.bond):null;
    this.el.pBond.textContent=partner?partner.name:'—';
    this.el.pInv.innerHTML='';
    for(const k of RESOURCES){
      if(a.inv[k]>0){
        const chip=document.createElement('span');
        chip.className='inv-chip';
        chip.textContent=k+' '+Math.floor(a.inv[k]);
        this.el.pInv.appendChild(chip);
      }
    }
    this.el.pMem.innerHTML='';
    for(let i=a.memory.length-1;i>=0;i--){
      const line=document.createElement('div');
      line.className='mem-line';
      line.textContent=a.memory[i];
      this.el.pMem.appendChild(line);
    }
  },

  renderSitePanel(s){
    this.setExtras(false);
    const SITE_LABEL={hut:'HUT',well:'WELL',farm:'FARM',granary:'GRANARY',workshop:'WORKSHOP',market:'MARKETPLACE',shrineHall:'SHRINE HALL',loreHall:'LORE HALL',huntingLodge:'HUNTING LODGE'};
    this.el.pName.textContent=SITE_LABEL[s.type]||s.type.toUpperCase();
    if(s.faction!=null){ this.el.pFaction.textContent=Factions[s.faction].name; this.el.pFaction.style.color=Factions[s.faction].color; }
    else { this.el.pFaction.textContent='unclaimed'; this.el.pFaction.style.color='#9aa6a2'; }
    this.el.pAge.textContent= s.level>0 ? ('level '+s.level+' / '+s.maxLevel) : 'not yet built';
    if(s.level>=s.maxLevel) this.el.pAction.textContent='fully raised';
    else if(s.matsWood>=s.needWood && s.matsStone>=s.needStone) this.el.pAction.textContent='ready to build — awaiting hands';
    else this.el.pAction.textContent='gathering materials';
    this.setStatLabels('wood','stone','build','—');
    setBar(this.el.barEnergy, s.needWood? s.matsWood/s.needWood : 1);
    setBar(this.el.barHunger, s.needStone? s.matsStone/s.needStone : 1);
    setBar(this.el.barSocial, s.level>=s.maxLevel?1:(s.progress||0));
    setBar(this.el.barJoy, 0);
  },

  renderNodePanel(nd){
    this.setExtras(false);
    const NODE_LABEL={berry:'BERRY BUSH',wood:'TIMBER STAND',stone:'STONE OUTCROP',water:'FRESH WATER SPRING',fish:'FISHING SPOT',herb:'WILD HERBS'};
    this.el.pName.textContent=NODE_LABEL[nd.sub]||nd.type.toUpperCase();
    this.el.pFaction.textContent='resource · '+nd.type;
    this.el.pFaction.style.color='#9fc9b8';
    this.el.pAge.textContent= nd.amount>=nd.max*0.99 ? 'plentiful' : (nd.amount<0.25 ? 'depleted — regrowing' : 'recovering');
    this.el.pAction.textContent='stock '+Math.round(nd.amount*100/nd.max)+'%';
    this.setStatLabels('stock','—','—','—');
    setBar(this.el.barEnergy, nd.max? nd.amount/nd.max : 0);
    setBar(this.el.barHunger,0); setBar(this.el.barSocial,0); setBar(this.el.barJoy,0);
  },

  renderMarkPanel(m){
    this.setExtras(false);
    const MARK_LABEL={shrine:'SHRINE',garden:'GARDEN PLOT',mark:'LEFT MARK'};
    this.el.pName.textContent=MARK_LABEL[m.type]||m.type.toUpperCase();
    const fc=Factions[m.faction];
    this.el.pFaction.textContent=fc.name;
    this.el.pFaction.style.color=fc.color;
    this.el.pAge.textContent='age '+Math.floor(m.age/World.dayLen)+' days';
    this.el.pAction.textContent='a trace left behind';
    this.setStatLabels('—','—','—','—');
    setBar(this.el.barEnergy,0); setBar(this.el.barHunger,0); setBar(this.el.barSocial,0); setBar(this.el.barJoy,0);
  },

  renderAnimalPanel(an){
    this.setExtras(false);
    this.el.pName.textContent=an.kind.toUpperCase();
    this.el.pFaction.textContent='wildlife';
    this.el.pFaction.style.color='#c2b08a';
    this.el.pAge.textContent=an.alive?'roaming free':'resting, will return';
    this.el.pAction.textContent=an.alive?'alive':'hidden';
    this.setStatLabels('—','—','—','—');
    setBar(this.el.barEnergy,0); setBar(this.el.barHunger,0); setBar(this.el.barSocial,0); setBar(this.el.barJoy,0);
  },

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

    if(this.selected){
      if(this.selKind==='agent' && this.selected.dead) this.deselect();
      else this.renderPanel();
    }
  }
};
