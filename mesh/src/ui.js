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
    this.el.alerts=document.getElementById('alerts');
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
    this.el.pop.addEventListener('click',e=>{ e.stopPropagation(); this.select(World,'world'); });

    this.el.speedBtns=Array.from(document.querySelectorAll('#speed-ctl button'));
    for(const b of this.el.speedBtns){
      b.addEventListener('click',()=>{
        Sim.speed=parseFloat(b.dataset.spd);
        for(const o of this.el.speedBtns) o.classList.remove('active');
        b.classList.add('active');
      });
    }

    this.el.fieldToggle=document.getElementById('field-toggle');
    this.el.fieldToggle.addEventListener('click',()=>{
      Renderer.showField=!Renderer.showField;
      this.el.fieldToggle.classList.toggle('active',Renderer.showField);
    });

    this.el.mineToggle=document.getElementById('mine-toggle');
    this.el.mineToggle.addEventListener('click',()=>{
      if(Renderer.viewMode==='surface'){
        Renderer._savedCam={x:Camera.x,y:Camera.y,zoom:Camera.zoom};
        Renderer.viewMode='underground';
        Camera.x=Underground.w/2; Camera.y=Underground.h/2; Camera.zoom=1.3;
      } else {
        Renderer.viewMode='surface';
        const sc=Renderer._savedCam;
        if(sc){ Camera.x=sc.x; Camera.y=sc.y; Camera.zoom=sc.zoom; }
      }
      this.el.mineToggle.classList.toggle('active',Renderer.viewMode==='underground');
      this.deselect();
    });

    this.showEcon=false;
    this.el.econToggle=document.getElementById('econ-toggle');
    this.el.econPanel=document.getElementById('econ-panel');
    this.el.econPanelClose=document.getElementById('econ-panel-close');
    this.el.econSettlements=document.getElementById('econ-settlements');
    this.el.econFactions=document.getElementById('econ-factions');
    this.el.econToggle.addEventListener('click',()=>{
      this.showEcon=!this.showEcon;
      this.el.econToggle.classList.toggle('active',this.showEcon);
      this.el.econPanel.classList.toggle('show',this.showEcon);
      if(this.showEcon) this.renderEconPanel();
    });
    this.el.econPanelClose.addEventListener('click',e=>{
      e.stopPropagation();
      this.showEcon=false;
      this.el.econToggle.classList.remove('active');
      this.el.econPanel.classList.remove('show');
    });

    // ambient sound toggle
    this.el.audioToggle=document.getElementById('audio-toggle');
    this.el.audioToggle.addEventListener('click',()=>{
      const on=MeshAudio.toggle();
      this.el.audioToggle.classList.toggle('active',on);
      this.el.audioToggle.textContent = on ? '♪ sound' : '♪ muted';
    });

    // divine touch — reach into the field and steady it
    this.touchMode=false; this._blessCd=0;
    this.el.touchToggle=document.getElementById('touch-toggle');
    this.el.touchToggle.addEventListener('click',()=>{
      this.touchMode=!this.touchMode;
      this.el.touchToggle.classList.toggle('active',this.touchMode);
      Renderer.cnv.classList.toggle('touching',this.touchMode);
    });

    // banner + chronicle
    this.el.banner=document.getElementById('banner');
    this.el.chronicle=document.getElementById('chronicle');
    this._lastBanner='';

    // intro veil — the entering gesture also satisfies the audio autoplay policy
    this.el.intro=document.getElementById('intro');
    this.el.introEnter=document.getElementById('intro-enter');
    if(this.el.introEnter){
      this.el.introEnter.addEventListener('click',()=>{
        this.el.intro.classList.add('gone');
        const on=MeshAudio.toggle();
        this.el.audioToggle.classList.toggle('active',on);
        this.el.audioToggle.textContent = on ? '♪ sound' : '♪ muted';
        this.fadeHint();
      });
    }

    this.bindCamera();
  },

  // a blessing: raise local field clarity and ease fragmentation. Rides the
  // existing signal→fx/audio path so it feels and sounds like the world's own
  // events. A short cooldown keeps it a gift rather than a firehose.
  blessAt(wx,wy){
    if(this._blessCd>0) return;
    this._blessCd=16;
    Mesh.writeField(wx,wy,'coherence',0.5,150);
    Mesh.writeField(wx,wy,'dissonance',-0.35,150);
    Mesh.broadcast(wx,wy,'vision',0.75,'#bfe8ff');
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
    cnv.addEventListener('touchstart',e=>{ if(e.touches.length===1) start(e.touches[0].clientX,e.touches[0].clientY); else if(e.touches.length===2){ dragging=false; pinchD=this.touchDist(e); } },{passive:false});
    cnv.addEventListener('touchmove',e=>{ e.preventDefault();
      if(e.touches.length===1) move(e.touches[0].clientX,e.touches[0].clientY);
      else if(e.touches.length===2){ const d=this.touchDist(e); if(pinchD>0){ const cx=(e.touches[0].clientX+e.touches[1].clientX)/2, cy=(e.touches[0].clientY+e.touches[1].clientY)/2; this.zoomAt(cx,cy,d/pinchD); } pinchD=d; }
    },{passive:false});
    cnv.addEventListener('touchend',e=>{
      if(e.touches.length===0) end();
      else { dragging=false; }
      pinchD=0;
    });
  },
  touchDist(e){ const dx=e.touches[0].clientX-e.touches[1].clientX, dy=e.touches[0].clientY-e.touches[1].clientY; return Math.hypot(dx,dy); },

  handleTap(px,py){
    const wx=Renderer.worldX(px), wy=Renderer.worldY(py);
    // divine-touch mode intercepts the tap (surface only — the field is a
    // surface-coordinate concept and has no meaning on the cave map)
    if(this.touchMode && Renderer.viewMode==='surface'){ this.blessAt(wx,wy); return; }
    const tol=26/Camera.zoom;
    let best=null,bd=Infinity,kind=null;
    const underg=Renderer.viewMode==='underground';
    for(const a of Agents){ if(!!a.underground!==underg) continue; const d=dist2(a.x,a.y,wx,wy); if(d<bd){ bd=d; best=a; kind='agent'; } }
    if(underg){
      for(const nd of Underground.oreNodes){ const d=dist2(nd.x,nd.y,wx,wy); if(d<bd){ bd=d; best=nd; kind='node'; } }
    } else {
      for(const s of World.sites){ const d=dist2(s.x,s.y,wx,wy); if(d<bd){ bd=d; best=s; kind='site'; } }
      for(const nd of World.nodes){ const d=dist2(nd.x,nd.y,wx,wy); if(d<bd){ bd=d; best=nd; kind='node'; } }
      for(const an of World.animals){ if(!an.alive) continue; const d=dist2(an.x,an.y,wx,wy); if(d<bd){ bd=d; best=an; kind='animal'; } }
      for(const m of Marks){ const d=dist2(m.x,m.y,wx,wy); if(d<bd){ bd=d; best=m; kind='mark'; } }
      for(const g of World.gathers){ const d=dist2(g.x,g.y,wx,wy); if(d<bd){ bd=d; best=g; kind='settlement'; } }
      { const d=dist2(World.altar.x,World.altar.y,wx,wy); if(d<bd){ bd=d; best=World.altar; kind='altar'; } }
    }
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
  },
  setMemSection(show){
    const d=show?'':'none';
    this.el.pMemLabel.style.display=d; this.el.pMem.style.display=d;
  },

  renderPanel(){
    const o=this.selected; if(!o) return;
    if(this.selKind==='site') this.renderSitePanel(o);
    else if(this.selKind==='node') this.renderNodePanel(o);
    else if(this.selKind==='animal') this.renderAnimalPanel(o);
    else if(this.selKind==='mark') this.renderMarkPanel(o);
    else if(this.selKind==='settlement') this.renderSettlementPanel(o);
    else if(this.selKind==='altar') this.renderAltarPanel(o);
    else if(this.selKind==='world') this.renderWorldPanel(o);
    else this.renderAgentPanel(o);
  },

  renderAgentPanel(a){
    this.setExtras(true);
    this.setMemSection(true);
    this.setStatLabels('energy','hunger','social','joy');
    const fc=Factions[a.faction];
    this.el.pName.textContent=a.name;
    this.el.pFaction.textContent=fc.name;
    this.el.pFaction.style.color=fc.color;
    const skillTier=a.skills>=3?'expert':(a.skills===2?'skilled':'apprentice');
    const leans=(a.ideals&&a.dominantIdeal)?' · believes in '+IDEAL_LABEL[a.dominantIdeal()]:'';
    this.el.pAge.textContent='age '+Math.floor(a.age)+(a.bond?' · bonded':'')+' · '+skillTier+leans;
    let actionTxt=a.caravan?'⇶ running a trade caravan':(a.task?(a.task.glyph+'  '+a.task.label):'…');
    if(a.captured) actionTxt='⚖ being helped to remember, at the Altar';
    else if(a.wanted) actionTxt+='  ·  ◌ FRAGMENTING ('+a.crime+')';
    actionTxt+='  ·  criminality '+(a.criminality||0).toFixed(2);
    this.el.pAction.textContent=actionTxt;
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
    const SITE_LABEL={hut:'HUT',well:'WELL',farm:'FARM',granary:'GRANARY',workshop:'WORKSHOP',market:'MARKETPLACE',shrineHall:'SHRINE HALL',loreHall:'LORE HALL',huntingLodge:'HUNTING LODGE',masonry:'MASONRY',townHall:'TOWN HALL',smithy:'SMITHY',barracks:'BARRACKS',harbor:'HARBOR',temple:'TEMPLE',tavern:'TAVERN',quarry:'QUARRY',mine:'MINE',monument:'MONUMENT',wonder:'THE WONDER'};
    this.el.pName.textContent=SITE_LABEL[s.type]||s.type.toUpperCase();
    if(s.faction!=null){ this.el.pFaction.textContent=Factions[s.faction].name; this.el.pFaction.style.color=Factions[s.faction].color; }
    else { this.el.pFaction.textContent='unclaimed'; this.el.pFaction.style.color='#9aa6a2'; }
    this.el.pAge.textContent= s.level>0 ? ('level '+s.level+' / '+s.maxLevel) : 'not yet built';

    const isJobSite = s.built && (s.type==='granary' || FUNCTIONAL_TYPES.includes(s.type));
    if(isJobSite){
      const slots=jobSlots(s), workers=(s.workers||[]).length;
      const hasLog = FUNCTIONAL_TYPES.includes(s.type) && s.type!=='huntingLodge' && s.type!=='harbor';
      let summary;
      if(s.type==='workshop') summary=workers+'/'+slots+' working · '+(s.toolsGranted||0)+' tools forged';
      else if(s.type==='market') summary=workers+'/'+slots+' working · resonance +'+(s.resonanceGiven||0).toFixed(2);
      else if(s.type==='shrineHall') summary=workers+'/'+slots+' working · grief eased '+(s.griefEased||0).toFixed(2);
      else if(s.type==='loreHall') summary=workers+'/'+slots+' working · '+(s.pupilsTaught||0)+' taught';
      else if(s.type==='smithy') summary=workers+'/'+slots+' working · '+(s.weaponsForged||0)+' weapons forged';
      else if(s.type==='barracks') summary=workers+'/'+slots+' on duty · '+(s.subdued||0)+' subdued';
      else if(s.type==='temple') summary=workers+'/'+slots+' working · grief eased '+(s.griefEased||0).toFixed(2);
      else if(s.type==='tavern') summary=workers+'/'+slots+' working · resonance +'+(s.resonanceGiven||0).toFixed(2);
      else if(s.type==='quarry') summary=workers+'/'+slots+' working · '+(s.stoneMined||0).toFixed(0)+' stone quarried';
      else summary=workers+'/'+slots+' staffed · feeding aura +'+(s.contrib||0).toFixed(2); // granary / huntingLodge / harbor
      if(s.stoneUpgraded) summary+=' · stone-reinforced';
      this.el.pAction.textContent=summary;
      this.setStatLabels('staffed','efficiency','—','—');
      setBar(this.el.barEnergy, slots? workers/slots : 0);
      setBar(this.el.barHunger, Math.min(1,(s.effRate||0)*2)); setBar(this.el.barSocial,0); setBar(this.el.barJoy,0);
      this.setMemSection(hasLog);
      if(hasLog){
        this.el.pMem.innerHTML='';
        const log=s.log||[];
        for(let i=log.length-1;i>=0;i--){
          const line=document.createElement('div');
          line.className='mem-line';
          line.textContent=log[i];
          this.el.pMem.appendChild(line);
        }
      }
      return;
    }

    this.setMemSection(false);
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
    this.setMemSection(false);
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
    this.setMemSection(false);
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
    this.setMemSection(false);
    this.el.pName.textContent=an.kind.toUpperCase();
    this.el.pFaction.textContent='wildlife';
    this.el.pFaction.style.color='#c2b08a';
    this.el.pAge.textContent=an.alive?'roaming free':'resting, will return';
    this.el.pAction.textContent=an.alive?'alive':'hidden';
    this.setStatLabels('—','—','—','—');
    setBar(this.el.barEnergy,0); setBar(this.el.barHunger,0); setBar(this.el.barSocial,0); setBar(this.el.barJoy,0);
  },

  renderSettlementPanel(g){
    this.setExtras(false);
    this.setMemSection(false);
    const gi=World.gathers.indexOf(g);
    const pop=Agents.filter(a=>!a.dead && !a.underground && World.nearestOf(World.gathers,a.x,a.y)===g).length;
    const sites=World.sites.filter(s=>s.gather===gi);
    const built=sites.filter(s=>s.built);
    const counts={}; for(const s of built) counts[s.type]=(counts[s.type]||0)+1;

    let housing=26; for(const s of built) if(s.type==='hut') housing+=s.capacity||3;

    let jobsFilled=0, jobsTotal=0;
    for(const s of built){
      if(s.type==='granary' || FUNCTIONAL_TYPES.includes(s.type)){
        jobsTotal+=jobSlots(s);
        jobsFilled+=(s.workers||[]).length;
      }
    }

    this.el.pName.textContent=SETTLEMENT_TIERS[g.tier].name+(g.spec?' · '+g.spec:'');
    this.el.pFaction.textContent='settlement · '+pop+' souls';
    this.el.pFaction.style.color='#9fc9b8';
    const builtSummary=Object.keys(counts).map(t=>counts[t]+' '+t).join(', ')||'nothing built yet';
    this.el.pAge.textContent=builtSummary;
    this.el.pAction.textContent='jobs '+jobsFilled+'/'+jobsTotal+' filled · prosperity '+((g.prosperity||0)*100).toFixed(0)+'% · treasury '+(g.treasury||0).toFixed(0)
      +' · food sec '+(g.foodSec||0).toFixed(2)+' · govern '+(g.govern||0)+' · tavern '+(g.tavernBonus||0).toFixed(2)
      +' · stores: '+this.stockLine(g)
      +' · field here: clarity '+Mesh.coherenceAt(g.x,g.y).toFixed(2)+' grief '+Mesh.griefAt(g.x,g.y).toFixed(2)+' frag '+Mesh.dissonanceAt(g.x,g.y).toFixed(2);
    this.setStatLabels('housing','jobs','tier','prosperity');
    setBar(this.el.barEnergy, housing? Math.min(1,pop/housing) : 0);
    setBar(this.el.barHunger, jobsTotal? jobsFilled/jobsTotal : 0);
    setBar(this.el.barSocial, g.tier/(SETTLEMENT_TIERS.length-1));
    setBar(this.el.barJoy, g.prosperity||0);
  },

  renderAltarPanel(alt){
    this.setExtras(false);
    this.setMemSection(true);
    this.el.pName.textContent='THE ALTAR';
    this.el.pFaction.textContent='the Collective';
    this.el.pFaction.style.color='#ffe9b0';
    this.el.pAge.textContent='fixed at the center of the world';
    this.el.pAction.textContent='returned to the source: '+alt.sacrifices+' · remembered '+alt.worshipped+' times';
    this.setStatLabels('field clarity','fragmentation','grief','—');
    setBar(this.el.barEnergy, Mesh.resonance);
    setBar(this.el.barHunger, Mesh.dissonance);
    setBar(this.el.barSocial, Mesh.grief);
    setBar(this.el.barJoy, 0);
    this.el.pMem.innerHTML='';
    const log=alt.log||[];
    for(let i=log.length-1;i>=0;i--){
      const line=document.createElement('div');
      line.className='mem-line';
      line.textContent=log[i];
      this.el.pMem.appendChild(line);
    }
  },

  renderWorldPanel(){
    this.setExtras(false);
    this.setMemSection(true);
    const alive=Agents.filter(a=>!a.dead);
    const wanted=alive.filter(a=>a.wanted && !a.captured).length;
    let jobsFilled=0, jobsTotal=0;
    for(const s of World.sites){
      if(s.built && (s.type==='granary' || FUNCTIONAL_TYPES.includes(s.type))){
        jobsTotal+=jobSlots(s);
        jobsFilled+=(s.workers||[]).length;
      }
    }
    let tierSum=0; for(const g of World.gathers) tierSum+=g.tier;
    const avgTier=World.gathers.length? (tierSum/World.gathers.length).toFixed(1) : '0';

    this.el.pName.textContent='THE MESH';
    this.el.pFaction.textContent=alive.length+' souls living';
    this.el.pFaction.style.color='#9fc9b8';
    this.el.pAge.textContent='born '+(World.totalBorn||0)+' · died '+(World.totalDied||0)+' · '+World.gathers.length+' settlements (avg tier '+avgTier+')';
    const factionPop=Factions.map(fc=>fc.name+' '+alive.filter(a=>a.faction===fc.id).length).join(' · ');
    this.el.pAction.textContent='crimes '+(World.totalCrimes||0)+' · returned to the source '+(World.altar.sacrifices||0)+' · jobs '+jobsFilled+'/'+jobsTotal+' filled · '+factionPop;
    this.setStatLabels('field clarity','fragmentation','grief','unrest');
    setBar(this.el.barEnergy, Mesh.resonance);
    setBar(this.el.barHunger, Mesh.dissonance);
    setBar(this.el.barSocial, Mesh.grief);
    setBar(this.el.barJoy, alive.length? wanted/alive.length : 0);
    this.el.pMem.innerHTML='';
    for(let i=CrimeLog.length-1;i>=0;i--){
      const line=document.createElement('div');
      line.className='mem-line';
      line.textContent=CrimeLog[i];
      this.el.pMem.appendChild(line);
    }
  },

  // compact one-line summary of a settlement's store (only resources it holds)
  stockLine(g){
    if(!g.stock) return '—';
    const parts=[];
    for(const k in g.stock){ if(g.stock[k]>=1) parts.push(k+' '+Math.round(g.stock[k])); }
    return parts.length?parts.join(' · '):'empty';
  },

  renderEconPanel(){
    this.el.econSettlements.innerHTML='';
    for(let gi=0;gi<World.gathers.length;gi++){
      const g=World.gathers[gi];
      const pop=Agents.filter(a=>!a.dead && !a.underground && World.nearestOf(World.gathers,a.x,a.y)===g).length;
      const row=document.createElement('div'); row.className='econ-row';
      const title=document.createElement('div'); title.className='econ-row-title';
      title.textContent=SETTLEMENT_TIERS[g.tier].name+(g.spec?' · '+g.spec:'')+' · '+pop+' souls';
      row.appendChild(title);
      const line=document.createElement('div'); line.className='econ-row-line';
      line.textContent='prosperity '+((g.prosperity||0)*100).toFixed(0)+'% · treasury '+(g.treasury||0).toFixed(0)+' · food sec '+(g.foodSec||0).toFixed(2)+' · govern '+(g.govern||0)+' · stores: '+this.stockLine(g);
      row.appendChild(line);
      this.el.econSettlements.appendChild(row);
    }
    if(World.gathers.length===0){
      const e=document.createElement('div'); e.className='econ-row-line'; e.textContent='no settlements yet';
      this.el.econSettlements.appendChild(e);
    }
    // trade routes woven between the settlements
    if(World.routes && World.routes.length){
      const row=document.createElement('div'); row.className='econ-row';
      const title=document.createElement('div'); title.className='econ-row-title'; title.textContent='TRADE ROUTES · '+World.routes.length;
      row.appendChild(title);
      for(const r of World.routes.slice().sort((a,b)=>b.strength-a.strength).slice(0,5)){
        const ga=World.gathers[r.a], gb=World.gathers[r.b]; if(!ga||!gb) continue;
        const line=document.createElement('div'); line.className='econ-row-line';
        line.textContent=(r.mode==='sea'?'⚓ ':'⇶ ')+SETTLEMENT_TIERS[ga.tier].name+' — '+SETTLEMENT_TIERS[gb.tier].name+' · strength '+r.strength.toFixed(1);
        row.appendChild(line);
      }
      this.el.econSettlements.appendChild(row);
    }

    this.el.econFactions.innerHTML='';
    const alive=Agents.filter(a=>!a.dead);
    for(let fi=0;fi<Factions.length;fi++){
      const fc=Factions[fi];
      const pop=alive.filter(a=>a.faction===fi).length;
      const stock=(World.factionStock&&World.factionStock[fi])||{};
      const stockTxt=Object.keys(stock).filter(k=>stock[k]>0.05).map(k=>k+' '+stock[k].toFixed(0)).join(', ')||'nothing held';
      const row=document.createElement('div'); row.className='econ-row';
      const title=document.createElement('div'); title.className='econ-row-title';
      title.style.color=fc.color;
      title.textContent=fc.name+' · '+pop;
      row.appendChild(title);
      const line=document.createElement('div'); line.className='econ-row-line';
      line.textContent='holds '+stockTxt+' · crimes '+((World.crimesByFaction&&World.crimesByFaction[fi])||0);
      row.appendChild(line);
      this.el.econFactions.appendChild(row);
    }
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

  renderChronicle(){
    const el=this.el.chronicle; if(!el) return;
    el.innerHTML='';
    for(const e of Chronicle.entries){
      const d=document.createElement('div');
      d.className='chron-line '+(e.kind||'neutral');
      d.style.opacity=Math.max(0.12,Math.min(1,e.life*1.35));
      d.textContent=e.text;
      el.appendChild(d);
    }
  },

  update(){
    this._t++;
    if(this._blessCd>0) this._blessCd--;

    // cinematic banner — finally give the world's great moments a voice on screen
    const bn=(typeof Events!=='undefined')?Events.banner:'';
    if(bn && bn!==this._lastBanner){
      this._lastBanner=bn;
      this.el.banner.textContent=bn;
      this.el.banner.classList.add('show');
    } else if(!bn && this._lastBanner){
      this._lastBanner='';
      this.el.banner.classList.remove('show');
    }

    if(this._t%12===0 && typeof Chronicle!=='undefined') this.renderChronicle();

    if(this._t%15===0){
      this.el.season.textContent=World.seasonName();
      this.el.tod.textContent=World.phaseName();
      this.el.pop.textContent=Agents.length+' souls';
      const wantedCt=Agents.filter(a=>a.wanted && !a.captured).length;
      if(wantedCt>0){ this.el.alerts.textContent='◌ '+wantedCt+' FRAGMENTING'; this.el.alerts.style.display=''; }
      else this.el.alerts.style.display='none';
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

    if(this.showEcon && this._t%15===0) this.renderEconPanel();
  }
};
