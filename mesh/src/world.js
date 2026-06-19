/* world.js — terrain, map, time of day, seasons, resource nodes */
'use strict';

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function makeRNG(seed){
  let s=seed>>>0;
  return ()=>{ s=(s+0x6D2B79F5)>>>0; let t=Math.imul(s^(s>>>15),1|s); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };
}

// ── Tile types ───────────────────────────────────────────────────────────────
const TILE={ WATER:0, SHORE:1, PLAIN:2, FOREST:3, HILL:4, RUIN:5, FIRE:6, GATHER:7 };

// ── Buildable structure types — each has a ladder of levels. Level 1 is the
// initial build; level 2 makes it bigger (more capacity/yield/storage), level
// 3 makes it faster (quicker regen/growth). Re-using the same mats/progress
// fields for every level keeps deliverMaterials/construct generic. ────────--
const SITE_DEFS={
  hut:    { levels:[
              {needWood:7,  needStone:4,  buildDur:170, cap:3},
              {needWood:10, needStone:6,  buildDur:200, cap:5},
              {needWood:8,  needStone:8,  buildDur:130, cap:5, restMult:1.4},
              {needWood:12, needStone:9,  buildDur:220, cap:7, restMult:1.4},
              {needWood:10, needStone:11, buildDur:160, cap:7, restMult:1.8}
            ] },
  well:   { levels:[
              {needWood:3,  needStone:9,  buildDur:170, max:40,  regen:0.00012},
              {needWood:5,  needStone:12, buildDur:200, max:70,  regen:0.00012},
              {needWood:6,  needStone:10, buildDur:140, max:70,  regen:0.00022},
              {needWood:7,  needStone:13, buildDur:210, max:100, regen:0.00022},
              {needWood:8,  needStone:11, buildDur:150, max:100, regen:0.00034}
            ] },
  farm:   { levels:[
              {needWood:5,  needStone:1,  buildDur:120, yieldAmt:4,  growTicks:900},
              {needWood:8,  needStone:2,  buildDur:150, yieldAmt:7,  growTicks:900},
              {needWood:6,  needStone:3,  buildDur:100, yieldAmt:7,  growTicks:600},
              {needWood:9,  needStone:3,  buildDur:160, yieldAmt:10, growTicks:600},
              {needWood:7,  needStone:4,  buildDur:110, yieldAmt:10, growTicks:420}
            ] },
  granary:{ levels:[
              {needWood:10, needStone:10, buildDur:240, cap:1, auraR:260},
              {needWood:14, needStone:14, buildDur:280, cap:2, auraR:340},
              {needWood:12, needStone:12, buildDur:200, cap:2, auraR:340},
              {needWood:16, needStone:16, buildDur:260, cap:3, auraR:420},
              {needWood:14, needStone:14, buildDur:210, cap:3, auraR:420}
            ] },
  // ── functional/operational structures — agents can take a job here (see
  // workAtStructure/doJob in behaviors.js); `cap` is worker-slot count, `effRate`
  // is the per-level magnitude of whatever ambient effect that type provides.
  workshop:{ levels:[
              {needWood:8,  needStone:6,  buildDur:200, cap:1, effRate:0.05},
              {needWood:11, needStone:9,  buildDur:230, cap:1, effRate:0.09},
              {needWood:9,  needStone:11, buildDur:170, cap:2, effRate:0.09},
              {needWood:13, needStone:13, buildDur:240, cap:2, effRate:0.14},
              {needWood:11, needStone:15, buildDur:180, cap:2, effRate:0.20}
            ] },
  market: { levels:[
              {needWood:9,  needStone:5,  buildDur:200, cap:1, effRate:0.06},
              {needWood:12, needStone:7,  buildDur:230, cap:1, effRate:0.10},
              {needWood:10, needStone:9,  buildDur:170, cap:2, effRate:0.10},
              {needWood:14, needStone:10, buildDur:240, cap:2, effRate:0.16},
              {needWood:12, needStone:12, buildDur:180, cap:2, effRate:0.22}
            ] },
  shrineHall:{ levels:[
              {needWood:6,  needStone:9,  buildDur:210, cap:1, effRate:0.05},
              {needWood:8,  needStone:12, buildDur:240, cap:1, effRate:0.08},
              {needWood:7,  needStone:14, buildDur:180, cap:2, effRate:0.08},
              {needWood:10, needStone:16, buildDur:250, cap:2, effRate:0.13},
              {needWood:9,  needStone:18, buildDur:190, cap:2, effRate:0.18}
            ] },
  loreHall:{ levels:[
              {needWood:9,  needStone:7,  buildDur:210, cap:1, effRate:0.05},
              {needWood:12, needStone:9,  buildDur:240, cap:1, effRate:0.08},
              {needWood:10, needStone:11, buildDur:180, cap:2, effRate:0.08},
              {needWood:14, needStone:13, buildDur:250, cap:2, effRate:0.13},
              {needWood:12, needStone:15, buildDur:190, cap:2, effRate:0.18}
            ] },
  huntingLodge:{ levels:[
              {needWood:10, needStone:4,  buildDur:200, cap:1, effRate:0.15},
              {needWood:13, needStone:6,  buildDur:230, cap:1, effRate:0.22},
              {needWood:11, needStone:8,  buildDur:170, cap:2, effRate:0.22},
              {needWood:15, needStone:9,  buildDur:240, cap:2, effRate:0.32},
              {needWood:13, needStone:11, buildDur:180, cap:2, effRate:0.45}
            ] },
  // ── advanced/civic structures — gate later settlement tiers. masonry doesn't
  // hold workers; its mere presence unlocks the upgradeToStone behavior for every
  // other built site on the same gather. townHall is similarly passive: it just
  // counts toward a settlement's `govern` total, which suppresses nearby crime.
  masonry:{ levels:[
              {needWood:14, needStone:20, buildDur:230, stoneRate:0.10},
              {needWood:16, needStone:24, buildDur:250, stoneRate:0.14},
              {needWood:15, needStone:28, buildDur:240, stoneRate:0.18},
              {needWood:18, needStone:32, buildDur:270, stoneRate:0.24},
              {needWood:20, needStone:38, buildDur:300, stoneRate:0.32}
            ] },
  townHall:{ levels:[
              {needWood:16, needStone:18, buildDur:240, auraR:500},
              {needWood:18, needStone:22, buildDur:260, auraR:600},
              {needWood:17, needStone:26, buildDur:250, auraR:700},
              {needWood:20, needStone:30, buildDur:280, auraR:800},
              {needWood:22, needStone:34, buildDur:300, auraR:900}
            ] }
};
const FUNCTIONAL_TYPES=['workshop','market','shrineHall','loreHall','huntingLodge'];
const FUNCTIONAL_LABEL={workshop:'WORKSHOP',market:'MARKETPLACE',shrineHall:'SHRINE HALL',loreHall:'LORE HALL',huntingLodge:'HUNTING LODGE'};
// small rolling activity log on a site — visible proof of what a staffed building is actually doing
function siteLog(s,msg){ s.log=s.log||[]; s.log.push(msg); if(s.log.length>6) s.log.shift(); }
function mkSite(x,y,type,gather){
  const lvl=SITE_DEFS[type].levels[0];
  const s={x,y,type,level:0,maxLevel:SITE_DEFS[type].levels.length,
    needWood:lvl.needWood,needStone:lvl.needStone,buildDur:lvl.buildDur,
    matsWood:0,matsStone:0,progress:0,built:false,faction:null,gather,
    stoneUpgraded:false,matsStoneUpgrade:0};
  if(type==='well') Object.assign(s,{amount:0,max:0,regen:0});
  if(type==='farm') Object.assign(s,{stage:'empty',stageT:0,growTicks:lvl.growTicks,yieldAmt:lvl.yieldAmt});
  if(type==='granary') Object.assign(s,{workers:[],log:[],contrib:0});
  if(FUNCTIONAL_TYPES.includes(type)) Object.assign(s,{capacity:lvl.cap, effRate:lvl.effRate, workers:[],log:[],contrib:0});
  return s;
}
// called when a site's progress reaches 1 — applies the level just finished,
// and (if more levels remain) sets up the mats/progress needed for the next one
function applySiteLevel(s,ag){
  s.level++;
  s.built=true;
  if(s.faction==null) s.faction=ag.faction;
  const def=SITE_DEFS[s.type].levels[s.level-1];
  if(s.type==='hut'){ s.capacity=def.cap; if(def.restMult) s.restMult=def.restMult; ag.inv.beauty+=2*s.level; }
  else if(s.type==='well'){ s.max=def.max; s.amount=s.level===1?s.max:Math.min(s.max,(s.amount||0)+def.max*0.4); s.regen=def.regen; ag.inv.beauty+=1; }
  else if(s.type==='farm'){ s.growTicks=def.growTicks; s.yieldAmt=def.yieldAmt; s.stage='empty'; s.stageT=0; }
  else if(s.type==='granary'){ s.capacity=def.cap; s.auraR=def.auraR; ag.inv.beauty+=4*s.level; raiseResonance(0.02*s.level); }
  else if(FUNCTIONAL_TYPES.includes(s.type)){ s.capacity=def.cap; s.effRate=def.effRate; ag.inv.beauty+=2*s.level; }
  else if(s.type==='masonry'){ s.stoneRate=def.stoneRate; ag.inv.beauty+=3*s.level; raiseResonance(0.015*s.level); }
  else if(s.type==='townHall'){ s.auraR=def.auraR; ag.inv.beauty+=3*s.level; raiseResonance(0.015*s.level); }
  ag.remember('raised a '+s.type+' to level '+s.level);
  Mesh.broadcast(s.x,s.y,'discovery',0.7,Factions[ag.faction].color); raiseResonance(0.02);
  if(s.level<s.maxLevel){
    const next=SITE_DEFS[s.type].levels[s.level];
    s.needWood=next.needWood; s.needStone=next.needStone; s.buildDur=next.buildDur;
    s.matsWood=0; s.matsStone=0; s.progress=0;
  }
}

// ── Settlement tier ladder (per gathering spot, gated by built structures) ──-
const SETTLEMENT_TIERS=[
  {name:'CAMP',         req:{}},
  {name:'HAMLET',       req:{hut:3}},
  {name:'VILLAGE',      req:{hut:5, well:1}},
  {name:'TOWNSHIP',     req:{hut:8, well:2, farm:2}},
  {name:'CIVILIZATION', req:{hut:12, well:2, farm:4, granary:1}},
  {name:'STONE TOWN',   req:{hut:12, well:2, farm:4, granary:1, masonry:1}}
];

const World={
  cols:170, rows:118, ts:20,           // tile size in world px
  w:0, h:0,
  tiles:null, elev:null,
  nodes:[],                            // resource nodes
  fires:[],                            // fire areas (warmth/social at night)
  gathers:[],                          // gathering spots (social hubs)
  rng:null,

  tick:0,                              // monotonic tick counter, used for job-tenure timing

  // Time: dayT in [0,1). dayLen ticks per day.
  dayLen:5400, dayTick:0, dayT:0.22,
  // Season: 0 spring,1 summer,2 autumn,3 winter. seasonLen days.
  seasonLen:4, season:0, seasonProgress:0, dayCount:0,

  // cumulative metrics — not derivable from current live state, so tracked directly
  totalBorn:0, totalDied:0, totalCrimes:0,

  init(seed){
    this.rng=makeRNG(seed||((Math.random()*1e9)|0));
    this.w=this.cols*this.ts; this.h=this.rows*this.ts;
    this.totalBorn=0; this.totalDied=0; this.totalCrimes=0;
    // the Altar — a fixed landmark at the heart of the map, not built by agents
    this.altar={ x:this.w/2, y:this.h/2, sacrifices:0, worshipped:0, log:[] };
    this.generate();
  },

  // judgment ceremony — a captured criminal, marched to the Altar by their own
  // feet (see Agent.chooseTask's captured branch), is given to the Collective
  judgeCriminal(agent){
    const alt=this.altar;
    siteLog(alt, agent.name+' was given to the Collective for '+agent.crime);
    logJustice(agent.name+' was given to the Collective for '+agent.crime);
    alt.sacrifices++;
    Events.banner='THE COLLECTIVE HAS RECEIVED '+agent.name.toUpperCase();
    Events.active='judgment'; Events.activeT=300;
    Mesh.broadcast(alt.x,alt.y,'judgment',1,'#ffe9b0');
    raiseResonance(0.05);
    Mesh.dissonance=Math.max(0,Mesh.dissonance-0.1);
    agent.die();
  },

  generate(){
    const {cols,rows}=this, n=cols*rows, rng=this.rng;
    this.elev=new Float32Array(n);
    this.tiles=new Uint8Array(n);

    // Elevation via summed gaussian peaks + ripples
    const peaks=[];
    const pk=10+((rng()*6)|0);
    for(let i=0;i<pk;i++){
      peaks.push({x:rng(),y:rng(),h:0.5+rng()*0.9,sx:0.07+rng()*0.16,sy:0.07+rng()*0.16});
    }
    for(let r=0;r<rows;r++){
      for(let c=0;c<cols;c++){
        const fx=c/cols, fy=r/rows;
        let v=0;
        for(const p of peaks){
          const dx=(fx-p.x)/p.sx, dy=(fy-p.y)/p.sy;
          v+=p.h*Math.exp(-(dx*dx+dy*dy));
        }
        v+=Math.sin(fx*15.2+fy*9.4)*0.06+Math.sin(fx*6.3-fy*11.1)*0.05;
        // gentle falloff to water at edges
        const edge=Math.min(fx,fy,1-fx,1-fy);
        v*=Math.min(1,edge*4.5+0.15);
        this.elev[r*cols+c]=v;
      }
    }

    // Classify terrain by elevation + noise
    for(let i=0;i<n;i++){
      const v=this.elev[i];
      let t;
      if(v<0.16) t=TILE.WATER;
      else if(v<0.22) t=TILE.SHORE;
      else if(v<0.78) t=TILE.PLAIN;       // raised from 0.62 — most of the map should read as open grass, not hill
      else t=TILE.HILL;
      this.tiles[i]=t;
    }
    // Forest clumps on plains
    const fclumps=18+((rng()*10)|0);
    for(let k=0;k<fclumps;k++){
      const cx=(rng()*cols)|0, cy=(rng()*rows)|0, rad=3+((rng()*6)|0);
      for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){
        const x=cx+dx,y=cy+dy; if(x<0||y<0||x>=cols||y>=rows)continue;
        if(dx*dx+dy*dy>rad*rad)continue;
        const i=y*cols+x;
        if(this.tiles[i]===TILE.PLAIN && rng()<0.78) this.tiles[i]=TILE.FOREST;
      }
    }

    // Resource nodes, fires, gathering spots, ruins
    this.nodes=[]; this.fires=[]; this.gathers=[];
    const addNode=(type,sub)=>{
      for(let tries=0;tries<40;tries++){
        const c=(rng()*cols)|0, r=(rng()*rows)|0, i=r*cols+c, t=this.tiles[i];
        let ok=false;
        if(sub==='berry'||sub==='herb') ok=(t===TILE.PLAIN||t===TILE.FOREST);
        else if(sub==='wood') ok=(t===TILE.FOREST);
        else if(sub==='stone') ok=(t===TILE.HILL);
        else if(sub==='water') ok=(t===TILE.SHORE);
        else if(sub==='fish') ok=(t===TILE.SHORE);
        if(!ok) continue;
        this.nodes.push({ type, sub, x:(c+0.5)*this.ts, y:(r+0.5)*this.ts, amount:1, max:1, regen:0.00004+rng()*0.00006 });
        return;
      }
    };
    for(let i=0;i<26;i++) addNode('food','berry');
    for(let i=0;i<22;i++) addNode('wood','wood');
    for(let i=0;i<16;i++) addNode('stone','stone');
    for(let i=0;i<14;i++) addNode('water','water');
    for(let i=0;i<10;i++) addNode('fish','fish');
    for(let i=0;i<12;i++) addNode('herb','herb');

    // Ruins
    const ruinCount=4+((rng()*4)|0);
    for(let k=0;k<ruinCount;k++){
      const c=(rng()*cols)|0, r=(rng()*rows)|0;
      for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++){
        const x=c+dx,y=r+dy; if(x>=cols||y>=rows)continue;
        const i=y*cols+x; if(this.tiles[i]!==TILE.WATER) this.tiles[i]=TILE.RUIN;
      }
    }

    // Gathering spots (social hubs) on plains near center mass
    for(let k=0;k<5;k++){
      for(let tries=0;tries<30;tries++){
        const c=(rng()*cols)|0, r=(rng()*rows)|0, i=r*cols+c;
        if(this.tiles[i]===TILE.PLAIN){
          this.tiles[i]=TILE.GATHER;
          this.gathers.push({x:(c+0.5)*this.ts,y:(r+0.5)*this.ts,tier:0});
          // a fire at each gathering spot
          this.fires.push({x:(c+0.5)*this.ts,y:(r+0.5)*this.ts,lit:true});
          break;
        }
      }
    }

    // Buildable plots — empty sites agents can haul materials to and raise.
    // Wells & granaries are NOT pre-placed here — they unlock emergently via
    // checkStructureUnlocks() once a settlement has earned the option to build them.
    this.sites=[];
    for(let gi=0;gi<this.gathers.length;gi++){
      const g=this.gathers[gi];
      const n=1+((rng()*2)|0);
      for(let k=0;k<n;k++) this.placeSite(g.x,g.y,55,150,'hut',gi,80);
      const fn=2+((rng()*2)|0);
      for(let k=0;k<fn;k++) this.placeSite(g.x,g.y,55,170,'farm',gi,70);
    }
    // Animals — wild fauna agents may hunt for food. They wander near a home
    // point and respawn there (vanish/reappear, no gore) after being caught.
    this.animals=[];
    const addAnimal=()=>{
      for(let tries=0;tries<40;tries++){
        const c=(rng()*cols)|0, r=(rng()*rows)|0, i=r*cols+c, t=this.tiles[i];
        if(t!==TILE.PLAIN && t!==TILE.FOREST) continue;
        const x=(c+0.5)*this.ts, y=(r+0.5)*this.ts;
        this.animals.push({x,y,vx:0,vy:0,sp:0.5+rng()*0.5,kind:'deer',alive:true,respawnAt:0,home:{x,y}});
        return;
      }
    };
    for(let i=0;i<24;i++) addAnimal();
  },

  // try to drop a new buildable site of `type` near (cx,cy), respecting tile validity & spacing
  placeSite(cx,cy,rmin,rmax,type,gather,minSpacing){
    for(let tries=0;tries<20;tries++){
      const ang=this.rng()*Math.PI*2, r=rmin+this.rng()*(rmax-rmin);
      const x=cx+Math.cos(ang)*r, y=cy+Math.sin(ang)*r;
      if(x<20||y<20||x>this.w-20||y>this.h-20) continue;
      const tt=this.tileAt(x,y);
      if(tt!==TILE.PLAIN && tt!==TILE.HILL) continue;
      let tooClose=false;
      for(const s of this.sites){ if((s.x-x)**2+(s.y-y)**2<minSpacing*minSpacing){ tooClose=true; break; } }
      if(tooClose) continue;
      this.sites.push(mkSite(x,y,type,gather));
      return true;
    }
    return false;
  },

  tileAt(wx,wy){
    const c=(wx/this.ts)|0, r=(wy/this.ts)|0;
    if(c<0||r<0||c>=this.cols||r>=this.rows) return TILE.WATER;
    return this.tiles[r*this.cols+c];
  },
  walkable(wx,wy){ const t=this.tileAt(wx,wy); return t!==TILE.WATER; },
  // cheap straight-line sample (capped at 10 points) rejecting a target if open
  // water lies between (ax,ay) and (bx,by) — not real pathfinding (can't route
  // around a peninsula), just a proactive filter against the shoreline-stuck case.
  // Kept cheap since this runs inside nearestX scans and wander/frontier retries.
  reachable(ax,ay,bx,by){
    const d=Math.hypot(bx-ax,by-ay);
    if(d<1) return true;
    const steps=Math.max(2,Math.min(10,Math.ceil(d/(this.ts*1.5))));
    for(let i=1;i<steps;i++){
      const t=i/steps;
      if(this.tileAt(ax+(bx-ax)*t, ay+(by-ay)*t)===TILE.WATER) return false;
    }
    return true;
  },

  // nearest node of a given resource type with stock (built wells duck-type as water nodes)
  nearestNode(x,y,type){
    let best=null,bd=Infinity;
    for(const nd of this.nodes){
      if(nd.type!==type) continue;
      if(nd.amount<0.25) continue;
      if(!this.reachable(x,y,nd.x,nd.y)) continue;
      const d=(nd.x-x)**2+(nd.y-y)**2;
      if(d<bd){bd=d;best=nd;}
    }
    if(type==='water'){
      for(const s of this.sites){
        if(s.type!=='well'||!s.built||s.amount<0.25) continue;
        if(!this.reachable(x,y,s.x,s.y)) continue;
        const d=(s.x-x)**2+(s.y-y)**2;
        if(d<bd){bd=d;best=s;}
      }
    }
    return best;
  },
  nearestOf(list,x,y){
    let best=null,bd=Infinity;
    for(const o of list){ if(!this.reachable(x,y,o.x,o.y)) continue; const d=(o.x-x)**2+(o.y-y)**2; if(d<bd){bd=d;best=o;} }
    return best;
  },
  nearestSite(x,y,filter){
    let best=null,bd=Infinity;
    for(const s of this.sites){
      if(filter && !filter(s)) continue;
      if(!this.reachable(x,y,s.x,s.y)) continue;
      const d=(s.x-x)**2+(s.y-y)**2;
      if(d<bd){ bd=d; best=s; }
    }
    return best;
  },

  // count built structures of each type belonging to a gathering spot, and the highest tier they satisfy
  tierOf(gatherIndex){
    const counts={};
    for(const s of this.sites){ if(s.built && s.gather===gatherIndex) counts[s.type]=(counts[s.type]||0)+1; }
    for(let i=SETTLEMENT_TIERS.length-1;i>=0;i--){
      const req=SETTLEMENT_TIERS[i].req;
      if(Object.keys(req).every(t=>(counts[t]||0)>=req[t])) return i;
    }
    return 0;
  },
  onTierUp(gi,tier){
    const g=this.gathers[gi];
    Events.banner='A SETTLEMENT HAS BECOME A '+SETTLEMENT_TIERS[tier].name;
    Events.active='tierup'; Events.activeT=260;
    raiseResonance(0.01*tier + (tier===SETTLEMENT_TIERS.length-1?0.07:0));
    Mesh.broadcast(g.x,g.y,'discovery', tier===SETTLEMENT_TIERS.length-1?1:0.7, tier===SETTLEMENT_TIERS.length-1?'#ffe9b0':'#9fd6c8');
  },
  // emergently unlock the *option* to build more huts / a well / a granary once structural progress justifies it
  checkStructureUnlocks(){
    for(let gi=0;gi<this.gathers.length;gi++){
      const g=this.gathers[gi];
      const built=s=>s.built && s.gather===gi;
      const huts=this.sites.filter(s=>s.type==='hut'&&built(s)).length;
      const hutSites=this.sites.filter(s=>s.type==='hut'&&s.gather===gi).length;
      // once every existing hut plot is filled, a settlement that's clearly thriving
      // earns the option to expand with another — up to the civilization-tier cap
      if(hutSites>0 && huts>=hutSites && hutSites<12) this.placeSite(g.x,g.y,55,170,'hut',gi,75);

      const wellSites=this.sites.filter(s=>s.type==='well'&&s.gather===gi).length;
      const wells=this.sites.filter(s=>s.type==='well'&&built(s)).length;
      // a thriving settlement earns a second well once the first is built — caps at the
      // civilization-tier requirement of 2 so township/civilization stay reachable
      if(wellSites<2 && (wellSites===0 ? huts>=2 : wells>=wellSites)) this.placeSite(g.x,g.y,40,90,'well',gi,60);
      const farmSites=this.sites.filter(s=>s.type==='farm'&&s.gather===gi).length;
      const farms=this.sites.filter(s=>s.type==='farm'&&built(s)).length;
      // farms start at 2-3 from world-gen and never grew past that — let a settlement with
      // every existing farm built and a well add another, up to the civilization-tier cap
      if(farmSites>0 && farms>=farmSites && wells>=1 && farmSites<5) this.placeSite(g.x,g.y,55,170,'farm',gi,70);
      const hasGranarySite=this.sites.some(s=>s.type==='granary'&&s.gather===gi);
      // by the time a granary unlocks (huts>=6) the inner 40-100 ring is usually packed
      // with well/workshop/market/shrineHall/loreHall/huntingLodge — push it outward so
      // it isn't starved for space and civilization tier stays reachable
      if(!hasGranarySite && huts>=6 && wells>=1 && farms>=2) this.placeSite(g.x,g.y,90,170,'granary',gi,45);
      const granaries=this.sites.filter(s=>s.type==='granary'&&built(s)).length;

      const hasWorkshopSite=this.sites.some(s=>s.type==='workshop'&&s.gather===gi);
      if(!hasWorkshopSite && huts>=4 && wells>=1) this.placeSite(g.x,g.y,40,100,'workshop',gi,60);
      const hasMarketSite=this.sites.some(s=>s.type==='market'&&s.gather===gi);
      if(!hasMarketSite && huts>=5 && farms>=1) this.placeSite(g.x,g.y,40,100,'market',gi,60);
      const hasShrineHallSite=this.sites.some(s=>s.type==='shrineHall'&&s.gather===gi);
      if(!hasShrineHallSite && huts>=6) this.placeSite(g.x,g.y,40,100,'shrineHall',gi,60);
      const hasLoreHallSite=this.sites.some(s=>s.type==='loreHall'&&s.gather===gi);
      if(!hasLoreHallSite && huts>=7 && wells>=1) this.placeSite(g.x,g.y,40,100,'loreHall',gi,60);
      const hasHuntingLodgeSite=this.sites.some(s=>s.type==='huntingLodge'&&s.gather===gi);
      if(!hasHuntingLodgeSite && huts>=5 && farms>=2) this.placeSite(g.x,g.y,40,100,'huntingLodge',gi,60);

      // masonry unlocks once a settlement has fully met civilization's structural
      // requirements — it's the gate for the next tier (STONE TOWN) and for the
      // stone-upgrade behavior that recolors/strengthens every other built site.
      const hasMasonrySite=this.sites.some(s=>s.type==='masonry'&&s.gather===gi);
      if(!hasMasonrySite && huts>=12 && wells>=2 && farms>=4 && granaries>=1) this.placeSite(g.x,g.y,90,170,'masonry',gi,55);
      const masonryBuilt=this.sites.filter(s=>s.type==='masonry'&&built(s)).length;
      const hasTownHallSite=this.sites.some(s=>s.type==='townHall'&&s.gather===gi);
      if(!hasTownHallSite && masonryBuilt>=1 && huts>=12) this.placeSite(g.x,g.y,60,140,'townHall',gi,60);
    }
  },

  updateAnimals(){
    // only the agents actively hunting matter for fleeing — cheap O(agents) filter,
    // skips the O(animals × hunters) flee scan entirely when nobody is hunting
    const hunters=Agents.filter(a=>a.task && a.task.cat==='hunt_chase');
    for(const an of this.animals){
      if(!an.alive){ an.respawnAt--; if(an.respawnAt<=0){ an.alive=true; an.x=an.home.x+(Math.random()-0.5)*40; an.y=an.home.y+(Math.random()-0.5)*40; } continue; }
      let fleeing=false;
      for(const a of hunters){
        if((a.x-an.x)**2+(a.y-an.y)**2<140*140){
          const dx=an.x-a.x, dy=an.y-a.y, d=Math.hypot(dx,dy)||1;
          an.vx+=dx/d*0.08; an.vy+=dy/d*0.08; fleeing=true; break;
        }
      }
      if(!fleeing){ an.vx+=(Math.random()-0.5)*0.02; an.vy+=(Math.random()-0.5)*0.02; }
      an.vx*=0.9; an.vy*=0.9;
      const nx=an.x+an.vx*an.sp, ny=an.y+an.vy*an.sp;
      if(this.walkable(nx,an.y)) an.x=nx; else an.vx*=-0.5;
      if(this.walkable(an.x,ny)) an.y=ny; else an.vy*=-0.5;
    }
  },

  update(){
    this.tick++;
    // Time of day
    this.dayTick++;
    if(this.dayTick>=this.dayLen){ this.dayTick=0; this.dayCount++; this.seasonProgress++;
      if(this.seasonProgress>=this.seasonLen){ this.seasonProgress=0; this.season=(this.season+1)%4; }
    }
    this.dayT=this.dayTick/this.dayLen;

    // Node regen — scaled by season (winter slow)
    const seasonRegen=[1.0,1.1,0.8,0.35][this.season];
    for(const nd of this.nodes){
      if(nd.amount<nd.max) nd.amount=Math.min(nd.max,nd.amount+nd.regen*seasonRegen*16);
    }
    // Built wells regen the same way as wild water nodes — never "used up"
    for(const s of this.sites){
      if(s.type==='well' && s.built && s.amount<s.max) s.amount=Math.min(s.max,s.amount+s.regen*seasonRegen*16);
    }
    // Farm lifecycle — crops grow whether or not anyone is watching. Higher
    // farm levels shorten growTicks (the "faster" payoff for leveling up).
    for(const s of this.sites){
      if(s.type!=='farm' || !s.built) continue;
      const grow=s.growTicks||900;
      if(s.stage==='planted'){ s.stageT+=seasonRegen; if(s.stageT>grow){ s.stage='growing'; s.stageT=0; } }
      else if(s.stage==='growing'){ s.stageT+=seasonRegen; if(s.stageT>grow){ s.stage='ready'; s.stageT=0; } }
    }

    if(this.dayTick%30===0) this.checkStructureUnlocks();
    if(this.dayTick%60===0){
      for(let gi=0;gi<this.gathers.length;gi++){
        const g=this.gathers[gi], nt=this.tierOf(gi);
        if(nt>g.tier){ g.tier=nt; this.onTierUp(gi,nt); }
        // food-security (granaries) & rest-bonus (huts) auras for this settlement —
        // cheap to recompute since sites are already tagged with their gather index
        let foodSec=0, restMult=1, govern=0;
        for(const s of this.sites){
          if(s.gather!==gi || !s.built) continue;
          if(s.type==='granary'){ s.contrib=(s.capacity||1)*0.4+((s.workers||[]).length>0?0.15*s.workers.length:0); if(s.stoneUpgraded) s.contrib*=1.1; foodSec+=s.contrib; }
          if(s.type==='huntingLodge'){ s.contrib=(s.workers||[]).length>0?(s.effRate||0.1)*s.workers.length:0; if(s.stoneUpgraded) s.contrib*=1.1; foodSec+=s.contrib; }
          if(s.type==='hut' && s.restMult){ const rm=s.stoneUpgraded?s.restMult*1.1:s.restMult; restMult=Math.max(restMult,rm); }
          if(s.type==='townHall') govern++;
        }
        g.foodSec=foodSec; g.restMult=restMult; g.govern=govern;
      }
    }

    this.updateAnimals();
  },

  // dynamic population ceiling driven by what's actually been built — replaces
  // the old hardcoded birth caps so growth is gated by housing, not a fixed number
  housingCapacity(){
    let cap=26; // base camp capacity, even before any hut is built
    for(const s of this.sites){
      if(!s.built) continue;
      if(s.type==='hut') cap+=s.capacity||3;
      if(s.type==='granary') cap+=(s.capacity||1)*4;
    }
    return cap;
  },

  // 0=deep night .. 1=midday brightness
  daylight(){
    // smooth curve peaking at noon (dayT=0.5)
    return Math.max(0, Math.sin((this.dayT-0.0)*Math.PI*2 - Math.PI/2)*0.5+0.5);
  },
  phaseName(){
    const d=this.dayT;
    if(d<0.22) return 'DAWN';
    if(d<0.46) return 'MIDDAY';
    if(d<0.6) return 'AFTERNOON';
    if(d<0.74) return 'DUSK';
    return 'NIGHT';
  },
  isNight(){ return this.dayT<0.18 || this.dayT>0.78; },
  seasonName(){ return ['SPRING','SUMMER','AUTUMN','WINTER'][this.season]; }
};
