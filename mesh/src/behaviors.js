/* behaviors.js — the full library of possible actions.
   Each behavior: { id, label, glyph, cat, weight(a), make(a) -> task }
   A task: { label, glyph, cat, target:{x,y}|null, stay, dur, arrive, onArrive(a), onTick(a) } */
'use strict';

function rnd(){ return Math.random(); }
function pick(arr){ return arr[(Math.random()*arr.length)|0]; }
function dist2(ax,ay,bx,by){ const dx=ax-bx,dy=ay-by; return dx*dx+dy*dy; }

// ── task constructors ────────────────────────────────────────────────────────
function gotoNode(a,label,glyph,cat,node,collect,pose){
  if(!node) return null;
  return { label,glyph,cat, pose:pose||'work', target:{x:node.x,y:node.y}, node, arrive:14, dur:60,
    onArrive(ag){
      if(node.amount>0.2){
        node.amount-=0.34;
        if(collect) ag.inv[collect]=(ag.inv[collect]||0)+1;
        ag.hunger=Math.max(0,ag.hunger-2);
        ag.remember('gathered '+(collect||cat));
      }
    } };
}
function gotoPoint(a,label,glyph,cat,x,y,dur,pose){
  return { label,glyph,cat, pose, target:{x,y}, arrive:12, dur:dur||40, onArrive(){} };
}
function stayPut(a,label,glyph,cat,dur,onTick,pose){
  return { label,glyph,cat, pose, target:null, stay:true, dur:dur||120, onTick };
}
function gotoAgent(a,label,glyph,cat,other,onArrive,dur,pose){
  if(!other) return null;
  return { label,glyph,cat, pose, targetAgent:other, target:{x:other.x,y:other.y}, arrive:16, dur:dur||90, onArrive };
}

// random reachable point near agent
function wanderPoint(a,radius){
  for(let i=0;i<8;i++){
    const ang=Math.random()*Math.PI*2, r=radius*(0.4+Math.random()*0.6);
    const x=a.x+Math.cos(ang)*r, y=a.y+Math.sin(ang)*r;
    if(World.walkable(x,y) && x>10 && y>10 && x<World.w-10 && y<World.h-10) return {x,y};
  }
  return {x:a.x,y:a.y};
}
// point toward unexplored edge (exploration)
function frontierPoint(a){
  const cx=World.w/2, cy=World.h/2;
  const ang=Math.atan2(a.y-cy,a.x-cx)+(Math.random()-0.5)*1.2;
  const r=200+Math.random()*340;
  let x=a.x+Math.cos(ang)*r, y=a.y+Math.sin(ang)*r;
  x=Math.max(20,Math.min(World.w-20,x)); y=Math.max(20,Math.min(World.h-20,y));
  if(!World.walkable(x,y)){ return wanderPoint(a,260); }
  return {x,y};
}

const Behaviors=[
  // ── SURVIVAL & WORK ────────────────────────────────────────────────────────
  { id:'eat', label:'eating', glyph:'❦', cat:'survival',
    weight:a=> a.inv.food>0 ? a.hunger*0.9 : 0,
    make:a=> stayPut(a,'eating','❦','survival',70,ag=>{ if(ag.task._t===1 && ag.inv.food>0){ ag.inv.food-=1; ag.hunger=Math.max(0,ag.hunger-55); ag.joy=Math.min(1,ag.joy+0.1);} },'sit') },
  { id:'drink', label:'drinking', glyph:'≈', cat:'survival',
    weight:a=> a.inv.water>0 ? (100-a.energy)*0.4 : 0,
    make:a=> stayPut(a,'drinking','≈','survival',50,ag=>{ if(ag.task._t===1 && ag.inv.water>0){ ag.inv.water-=1; ag.energy=Math.min(100,ag.energy+30);} },'sit') },
  { id:'gatherFood', label:'foraging', glyph:'✿', cat:'survival',
    weight:a=> a.hunger>30 || a.inv.food<1 ? 24+a.hunger*0.6 : 8,
    make:a=> gotoNode(a,'foraging','✿','survival',World.nearestNode(a.x,a.y,'food'),'food') },
  { id:'fetchWater', label:'fetching water', glyph:'≈', cat:'survival',
    weight:a=> a.inv.water<1 ? 18+(100-a.energy)*0.2 : 4,
    make:a=> gotoNode(a,'fetching water','≈','survival',World.nearestNode(a.x,a.y,'water'),'water') },
  { id:'fish', label:'fishing', glyph:'𝄃', cat:'survival',
    weight:a=> a.inv.food<2 ? 12 : 3,
    make:a=> gotoNode(a,'fishing','𝄃','survival',World.nearestNode(a.x,a.y,'fish'),'food') },
  { id:'chopWood', label:'chopping wood', glyph:'╪', cat:'survival',
    weight:a=> 10+(a.faction===0?6:0),
    make:a=> gotoNode(a,'chopping wood','╪','survival',World.nearestNode(a.x,a.y,'wood'),'wood') },
  { id:'mineStone', label:'mining stone', glyph:'◈', cat:'survival',
    weight:a=> 8+(a.faction===2?6:0),
    make:a=> gotoNode(a,'mining stone','◈','survival',World.nearestNode(a.x,a.y,'stone'),'stone') },
  { id:'herbs', label:'collecting herbs', glyph:'❧', cat:'survival',
    weight:a=> 7+(a.faction===3?5:0),
    make:a=> gotoNode(a,'collecting herbs','❧','survival',World.nearestNode(a.x,a.y,'herb'),'herb') },
  { id:'preserve', label:'preserving food', glyph:'⊞', cat:'survival',
    weight:a=> (World.season>=2 && a.inv.food>2) ? 26 : 0,
    make:a=> stayPut(a,'preserving food','⊞','survival',120,null,'work') },
  { id:'shelter', label:'mending shelter', glyph:'⌂', cat:'survival',
    weight:a=> (World.isNight()||World.season===3) && a.inv.wood>0 ? 14 : 5,
    make:a=> stayPut(a,'mending shelter','⌂','survival',140) },
  { id:'hunt', label:'hunting', glyph:'➳', cat:'survival',
    weight:a=> { if(!World.animals.some(an=>an.alive)) return 0; return a.inv.food<2 ? 16 : 3; },
    make:a=> {
      const an=World.nearestOf(World.animals.filter(x=>x.alive), a.x, a.y);
      if(!an) return null;
      return { label:'hunting',glyph:'➳',cat:'hunt_chase', pose:'work', target:an, animal:an, arrive:16, dur:300,
        onTick(ag){
          if(!an.alive){ ag.task=null; return; }
          const d=Math.hypot(an.x-ag.x,an.y-ag.y);
          if(d<26 && Math.random()<0.02){
            an.alive=false; an.respawnAt=900+((Math.random()*600)|0);
            ag.inv.food+=2; ag.hunger=Math.max(0,ag.hunger-30); ag.remember('made a catch'); ag.task=null;
          }
        } };
    } },
  { id:'plantSeeds', label:'planting seeds', glyph:'⊥', cat:'survival',
    weight:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='empty'); return f ? 20+(a.faction===0?10:0) : 0; },
    make:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='empty'); if(!f) return null;
      return { label:'planting seeds',glyph:'⊥',cat:'survival', pose:'kneel', target:{x:f.x,y:f.y}, arrive:12, dur:90,
        onArrive(ag){ f.stage='planted'; f.stageT=0; ag.remember('planted a farm'); } }; } },
  { id:'harvestFarm', label:'harvesting', glyph:'⊞', cat:'survival',
    weight:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='ready'); return f ? 28+(a.faction===0?12:0) : 0; },
    make:a=> { const f=World.nearestSite(a.x,a.y,s=>s.type==='farm'&&s.built&&s.stage==='ready'); if(!f) return null;
      return { label:'harvesting',glyph:'⊞',cat:'survival', pose:'kneel', target:{x:f.x,y:f.y}, arrive:12, dur:80,
        onArrive(ag){ ag.inv.food+=4; f.stage='empty'; f.stageT=0; ag.hunger=Math.max(0,ag.hunger-10); ag.remember('harvested a farm'); } }; } },

  // ── TRADE & ECONOMY ────────────────────────────────────────────────────────
  { id:'barter', label:'bartering', glyph:'⇄', cat:'trade',
    weight:a=> { const need=neededResource(a); return need? 16+(a.faction===1?10:0) : 6; },
    make:a=> gotoAgent(a,'bartering','⇄','trade', nearestAgent(a, o=> o!==a && dist2(a.x,a.y,o.x,o.y)<360*360), ag=>{
        const other=ag.task.targetAgent; if(!other) return;
        if(Economy.barter(ag,other)){ ag.emitExchange(other); raiseResonance(0.004); other.joy=Math.min(1,other.joy+0.05); }
      }) },
  { id:'toMarket', label:'to the market', glyph:'⊹', cat:'trade',
    weight:a=> invTotal(a.inv)>4 ? 10 : 2,
    make:a=> { const g=World.nearestOf(World.gathers,a.x,a.y); return g? gotoPoint(a,'to the market','⊹','trade',g.x,g.y,60):null; } },
  { id:'seekResource', label:'seeking a resource', glyph:'?', cat:'trade',
    weight:a=> { const need=neededResource(a); return need?14:0; },
    make:a=> { const need=neededResource(a); const nd=need?World.nearestNode(a.x,a.y,need==='wood'||need==='stone'||need==='food'||need==='water'?need:'food'):null; return nd?gotoNode(a,'seeking '+need,'?','trade',nd,need):null; } },

  // ── SOCIAL ─────────────────────────────────────────────────────────────────
  { id:'seekFriend', label:'seeking a friend', glyph:'♥', cat:'social',
    weight:a=> a.social*0.7,
    make:a=> gotoAgent(a,'with a friend','♥','social', a.bond? agentById(a.bond) : nearestAgent(a,o=>o!==a), ag=>{
        ag.social=Math.max(0,ag.social-50); ag.joy=Math.min(1,ag.joy+0.08);
        const o=ag.task.targetAgent; if(o){ o.social=Math.max(0,o.social-30); }
      }) },
  { id:'sitBeside', label:'sitting together', glyph:'◡', cat:'social',
    weight:a=> a.social>40?18:6,
    make:a=> gotoAgent(a,'sitting together','◡','social', nearestAgent(a,o=>o!==a), ag=>{ ag.social=Math.max(0,ag.social-30); }, 160, 'sit') },
  { id:'teach', label:'teaching', glyph:'✺', cat:'social',
    weight:a=> a.skills>2 ? 12+(a.faction===3?6:0):3,
    make:a=> gotoAgent(a,'teaching','✺','social', nearestAgent(a,o=>o!==a&&o.skills<a.skills), ag=>{ const o=ag.task.targetAgent; if(o){o.skills+=1; o.remember('learned a skill');} ag.remember('taught'); raiseResonance(0.003); }, 90, 'sit') },
  { id:'learn', label:'learning', glyph:'✺', cat:'social',
    weight:a=> a.skills<3?10:4,
    make:a=> gotoAgent(a,'learning','✺','social', nearestAgent(a,o=>o!==a&&o.skills>a.skills), ag=>{ ag.skills+=1; ag.remember('learned'); }, 90, 'sit') },
  { id:'help', label:'offering help', glyph:'✛', cat:'social',
    weight:a=> a.joy>0.5 ? 12+(a.faction===3?8:0):5,
    make:a=> gotoAgent(a,'offering help','✛','social', nearestAgent(a,o=>o!==a&&(o.hunger>55||o.energy<30)), ag=>{ const o=ag.task.targetAgent; if(o){ if(ag.inv.food>0&&o.hunger>55){ag.inv.food-=1;o.inv.food+=1;} o.joy=Math.min(1,o.joy+0.12);} raiseResonance(0.006); }) },
  { id:'celebrate', label:'celebrating', glyph:'✦', cat:'social',
    weight:a=> Mesh.resonance>0.66 ? 20:4,
    make:a=> { const g=World.nearestOf(World.gathers,a.x,a.y); return g?gotoPoint(a,'celebrating','✦','social',g.x,g.y,120,'sit'):null; } },
  { id:'story', label:'telling a story', glyph:'❝', cat:'social',
    weight:a=> World.isNight()? 16:5,
    make:a=> { const f=World.nearestOf(World.fires,a.x,a.y); return f?gotoPoint(a,'telling a story','❝','social',f.x,f.y,170,'sit'):null; } },
  { id:'disagree', label:'disagreeing', glyph:'≠', cat:'social',
    weight:a=> Mesh.dissonance>0.4 ? 12:3,
    make:a=> gotoAgent(a,'disagreeing','≠','social', nearestAgent(a,o=>o!==a&&o.faction!==a.faction), ag=>{ lowerResonance(0.003); }) },
  { id:'reconcile', label:'reconciling', glyph:'∞', cat:'social',
    weight:a=> Mesh.dissonance>0.5 && a.faction===3 ? 18:4,
    make:a=> gotoAgent(a,'reconciling','∞','social', nearestAgent(a,o=>o!==a), ag=>{ raiseResonance(0.005); Mesh.dissonance=Math.max(0,Mesh.dissonance-0.05); }) },
  { id:'comfort', label:'comforting', glyph:'♡', cat:'social',
    weight:a=> Mesh.grief>0.2 ? (a.faction===3?30:14):0,
    make:a=> gotoAgent(a,'comforting','♡','social', nearestAgent(a,o=>o!==a&&o.grieving>0), ag=>{ const o=ag.task.targetAgent; if(o){o.grieving=Math.max(0,o.grieving-0.5); o.joy=Math.min(1,o.joy+0.1);} raiseResonance(0.005); }) },

  // ── INNER LIFE ───────────────────────────────────────────────────────────--
  { id:'rest', label:'resting', glyph:'·', cat:'inner',
    weight:a=> (100-a.energy)*0.7 + (World.isNight()?20:0),
    make:a=> stayPut(a,'resting','·','inner',160,ag=>{ ag.energy=Math.min(100,ag.energy+0.5); },'sit') },
  { id:'sleep', label:'sleeping', glyph:'z', cat:'inner',
    weight:a=> World.isNight()? (100-a.energy)*0.9+40 : 0,
    make:a=> stayPut(a,'sleeping','z','inner',300,ag=>{ ag.energy=Math.min(100,ag.energy+0.7); ag.social=Math.min(100,ag.social+0.05); },'lie') },
  { id:'wander', label:'wandering', glyph:'~', cat:'inner',
    weight:a=> 10,
    make:a=> gotoPoint(a,'wandering','~','inner', wanderPoint(a,220).x, wanderPoint(a,220).y, 80) },
  { id:'meditate', label:'meditating', glyph:'☉', cat:'inner',
    weight:a=> Mesh.noise>0.6 ? 18:7,
    make:a=> { const w=World.nearestNode(a.x,a.y,'water'); const p=w?{x:w.x,y:w.y}:wanderPoint(a,160); return gotoPoint(a,'meditating','☉','inner',p.x,p.y,200,'sit'); } },
  { id:'withdraw', label:'withdrawing', glyph:'◍', cat:'inner',
    weight:a=> a.overwhelmed>0.5 ? 30:0,
    make:a=> { const p=wanderPoint(a,300); return { label:'withdrawing',glyph:'◍',cat:'inner',target:p,arrive:12,dur:220,onArrive(ag){ag.meshMuted=200;},onTick(ag){ag.overwhelmed=Math.max(0,ag.overwhelmed-0.004);} }; } },
  { id:'grieve', label:'grieving', glyph:'❀', cat:'inner',
    weight:a=> a.grieving>0 ? 40:0,
    make:a=> stayPut(a,'grieving','❀','inner',200,ag=>{ ag.grieving=Math.max(0,ag.grieving-0.004); }) },
  { id:'joyExpr', label:'expressing joy', glyph:'✲', cat:'inner',
    weight:a=> a.joy>0.7 ? 16:3,
    make:a=> stayPut(a,'expressing joy','✲','inner',90,ag=>{ if(ag.task._t===1){ Mesh.broadcast(ag.x,ag.y,'joy',0.5,Factions[ag.faction].color); } }) },
  { id:'realize', label:'a realization', glyph:'✴', cat:'inner',
    weight:a=> Math.random()<0.04 ? 14:0,
    make:a=> stayPut(a,'a realization','✴','inner',60,ag=>{ if(ag.task._t===1 && Math.random()<0.4) ag.driftFaction(); }) },

  // ── EXPLORATION ──────────────────────────────────────────────────────────--
  { id:'explore', label:'exploring', glyph:'➤', cat:'explore',
    weight:a=> 8+(a.faction===1?18:0),
    make:a=> { const p=frontierPoint(a); return { label:'exploring',glyph:'➤',cat:'explore',target:p,arrive:14,dur:120,onArrive(ag){ if(Math.random()<0.25){ Mesh.broadcast(ag.x,ag.y,'discovery',0.7,'#e6b455'); ag.remember('discovered something'); raiseResonance(0.006);} } }; } },
  { id:'scout', label:'scouting', glyph:'◎', cat:'explore',
    weight:a=> 6+(a.faction===1?8:0),
    make:a=> { const p=frontierPoint(a); return gotoPoint(a,'scouting','◎','explore',p.x,p.y,90); } },
  { id:'mapPath', label:'mapping a path', glyph:'⋯', cat:'explore',
    weight:a=> a.faction===1?12:3,
    make:a=> { const g=pick(World.gathers); return g?gotoPoint(a,'mapping a path','⋯','explore',g.x,g.y,80):null; } },
  { id:'observe', label:'observing wildlife', glyph:'❉', cat:'explore',
    weight:a=> 5,
    make:a=> { const p=wanderPoint(a,180); return gotoPoint(a,'observing wildlife','❉','explore',p.x,p.y,120); } },

  // ── CREATIVE & EXPRESSIVE ──────────────────────────────────────────────────
  { id:'deliverMaterials', label:'hauling materials', glyph:'▦', cat:'creative',
    weight:a=> { if(a.inv.wood<=0 && a.inv.stone<=0) return 0;
      const st=World.nearestSite(a.x,a.y, s=>!s.built && (s.matsWood<s.needWood||s.matsStone<s.needStone));
      return st ? 18+(a.faction===2?10:0) : 0; },
    make:a=> { const st=World.nearestSite(a.x,a.y, s=>!s.built && (s.matsWood<s.needWood||s.matsStone<s.needStone));
      if(!st) return null;
      return { label:'hauling materials',glyph:'▦',cat:'creative', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:50,
        onArrive(ag){
          if(ag.inv.wood>0 && st.matsWood<st.needWood){ const n=Math.min(ag.inv.wood,st.needWood-st.matsWood); ag.inv.wood-=n; st.matsWood+=n; ag.remember('delivered wood to a build site'); }
          if(ag.inv.stone>0 && st.matsStone<st.needStone){ const n=Math.min(ag.inv.stone,st.needStone-st.matsStone); ag.inv.stone-=n; st.matsStone+=n; ag.remember('delivered stone to a build site'); }
        } }; } },
  { id:'construct', label:'raising a structure', glyph:'⌗', cat:'creative',
    weight:a=> { const st=World.nearestSite(a.x,a.y, s=>!s.built && s.matsWood>=s.needWood && s.matsStone>=s.needStone);
      if(!st) return 0;
      // nudge (not force) toward whichever incomplete type a settlement most needs next
      const nudge=(st.type==='well'||st.type==='granary') ? 1.25 : (st.type==='farm' ? 1.1 : 1);
      return (24+(a.faction===2?16:0))*nudge; },
    make:a=> { const st=World.nearestSite(a.x,a.y, s=>!s.built && s.matsWood>=s.needWood && s.matsStone>=s.needStone);
      if(!st) return null;
      return { label:'raising a '+st.type,glyph:'⌗',cat:'creative', pose:'work', target:{x:st.x,y:st.y}, arrive:14, dur:200,
        onTick(ag){
          if(st.built) return;
          st.progress=Math.min(1,st.progress+1/st.buildDur);
          if(st.progress>=1){
            st.built=true; st.faction=ag.faction;
            if(st.type==='hut'){ ag.inv.beauty+=2; }
            else if(st.type==='well'){ st.max=40; st.amount=40; st.regen=0.00012; ag.inv.beauty+=1; }
            else if(st.type==='farm'){ st.stage='empty'; st.stageT=0; }
            else if(st.type==='granary'){ ag.inv.beauty+=4; raiseResonance(0.02); }
            ag.remember('completed a '+st.type);
            Mesh.broadcast(st.x,st.y,'discovery',0.7,Factions[ag.faction].color); raiseResonance(0.02);
          }
        } }; } },
  { id:'craftTools', label:'forging tools', glyph:'⚒', cat:'creative',
    weight:a=> (a.inv.wood>0&&a.inv.stone>0) ? (a.faction===2?26:10):0,
    make:a=> stayPut(a,'forging tools','⚒','creative',150,ag=>{ if(ag.task._t===1&&ag.inv.wood>0&&ag.inv.stone>0){ ag.inv.wood-=1; ag.inv.stone-=1; ag.inv.tools+=1; ag.remember('forged a tool'); } },'work') },
  { id:'music', label:'making music', glyph:'♪', cat:'creative',
    weight:a=> World.isNight()||Mesh.resonance>0.6 ? 14:5,
    make:a=> { const f=World.nearestOf(World.fires,a.x,a.y)||{x:a.x,y:a.y}; return { label:'making music',glyph:'♪',cat:'creative', pose:'sit', target:{x:f.x,y:f.y},arrive:16,dur:200,onTick(ag){ if(ag.task._t%30===0) ag.emitSound(); } }; } },
  { id:'shrine', label:'making a shrine', glyph:'⩏', cat:'creative',
    weight:a=> Mesh.grief>0.3 ? 16:3,
    make:a=> stayPut(a,'making a shrine','⩏','creative',200,ag=>{ if(ag.task._t===1) ag.leaveMark('shrine'); },'kneel') },
  { id:'garden', label:'planting beauty', glyph:'❁', cat:'creative',
    weight:a=> a.faction===0?12:4,
    make:a=> { const p=wanderPoint(a,140); return { label:'planting beauty',glyph:'❁',cat:'creative', pose:'kneel', target:p,arrive:12,dur:150,onArrive(ag){ ag.leaveMark('garden'); ag.inv.beauty+=1; } }; } },
  { id:'mark', label:'leaving a mark', glyph:'✎', cat:'creative',
    weight:a=> 5,
    make:a=> { const p=wanderPoint(a,120); return { label:'leaving a mark',glyph:'✎',cat:'creative', pose:'kneel', target:p,arrive:12,dur:80,onArrive(ag){ ag.leaveMark('mark'); } }; } },

  // ── MESH-SPECIFIC ──────────────────────────────────────────────────────────
  { id:'broadcast', label:'broadcasting a feeling', glyph:'◉', cat:'mesh',
    weight:a=> a.joy>0.6||a.grieving>0.3 ? 14:4,
    make:a=> stayPut(a,'broadcasting','◉','mesh',70,ag=>{ if(ag.task._t===1){ const f=ag.grieving>0.3?'grief':'joy'; Mesh.broadcast(ag.x,ag.y,f,0.6,Factions[ag.faction].color); } }) },
  { id:'amplify', label:'amplifying a signal', glyph:'⟁', cat:'mesh',
    weight:a=> Mesh.signals.length>0 ? 10+(a.faction===3?6:0):0,
    make:a=> stayPut(a,'amplifying','⟁','mesh',60,ag=>{ if(ag.task._t===1&&Mesh.signals.length){ const s=Mesh.signals[(Math.random()*Mesh.signals.length)|0]; s.strength=Math.min(1,s.strength+0.25); Mesh.broadcast(ag.x,ag.y,s.type,0.4,s.color); } }) },
  { id:'meshBond', label:'forming a bond', glyph:'⧉', cat:'mesh',
    weight:a=> !a.bond ? (a.faction===3?16:8):0,
    make:a=> gotoAgent(a,'forming a bond','⧉','mesh', nearestAgent(a,o=>o!==a&&!o.bond), ag=>{ const o=ag.task.targetAgent; if(o&&!o.bond&&!ag.bond){ ag.bond=o.id; o.bond=ag.id; ag.remember('bonded with '+o.name); o.remember('bonded with '+ag.name); raiseResonance(0.01);} }) },
  { id:'travelToUrgency', label:'feeling distant urgency', glyph:'➟', cat:'mesh',
    weight:a=> { const s=Mesh.strongestSignal(a.x,a.y); return s&&s.type!=='joy'?12:0; },
    make:a=> { const s=Mesh.strongestSignal(a.x,a.y); return s?gotoPoint(a,'answering a call','➟','mesh',s.x,s.y,120):null; } },
  { id:'shareVision', label:'sharing a vision', glyph:'✧', cat:'mesh',
    weight:a=> Math.random()<0.03?12:0,
    make:a=> stayPut(a,'sharing a vision','✧','mesh',90,ag=>{ if(ag.task._t===1) Mesh.broadcast(ag.x,ag.y,'vision',0.7,'#bfe8ff'); }) }
];

const BehaviorById={}; for(const b of Behaviors) BehaviorById[b.id]=b;
