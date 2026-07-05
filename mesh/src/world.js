/* world.js — terrain, map, time of day, seasons, resource nodes */
'use strict';

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function makeRNG(seed){
  let s=seed>>>0;
  return ()=>{ s=(s+0x6D2B79F5)>>>0; let t=Math.imul(s^(s>>>15),1|s); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };
}

// ── Tile types ───────────────────────────────────────────────────────────────
const TILE={ WATER:0, SHORE:1, PLAIN:2, FOREST:3, RUIN:5, FIRE:6, GATHER:7 };

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
            ] },
  // ── second wave of functional/operational structures (post-masonry economy) ──
  smithy:{ levels:[
              {needWood:10, needStone:14, buildDur:220, cap:1, effRate:0.04},
              {needWood:13, needStone:18, buildDur:250, cap:1, effRate:0.07},
              {needWood:11, needStone:22, buildDur:190, cap:2, effRate:0.07},
              {needWood:15, needStone:26, buildDur:260, cap:2, effRate:0.12},
              {needWood:13, needStone:30, buildDur:200, cap:2, effRate:0.18}
            ] },
  barracks:{ levels:[
              {needWood:12, needStone:16, buildDur:230, cap:1, effRate:0.10},
              {needWood:15, needStone:20, buildDur:250, cap:1, effRate:0.16},
              {needWood:13, needStone:24, buildDur:190, cap:2, effRate:0.16},
              {needWood:17, needStone:28, buildDur:260, cap:2, effRate:0.24},
              {needWood:15, needStone:32, buildDur:210, cap:2, effRate:0.32}
            ] },
  harbor: { levels:[
              {needWood:14, needStone:8,  buildDur:220, cap:1, effRate:0.15},
              {needWood:17, needStone:10, buildDur:250, cap:1, effRate:0.22},
              {needWood:15, needStone:12, buildDur:190, cap:2, effRate:0.22},
              {needWood:19, needStone:14, buildDur:260, cap:2, effRate:0.32},
              {needWood:17, needStone:16, buildDur:210, cap:2, effRate:0.45}
            ] },
  temple: { levels:[
              {needWood:10, needStone:20, buildDur:240, cap:1, effRate:0.10},
              {needWood:13, needStone:24, buildDur:270, cap:1, effRate:0.16},
              {needWood:11, needStone:28, buildDur:200, cap:2, effRate:0.16},
              {needWood:15, needStone:32, buildDur:280, cap:2, effRate:0.26},
              {needWood:13, needStone:36, buildDur:220, cap:2, effRate:0.36}
            ] },
  tavern: { levels:[
              {needWood:11, needStone:9,  buildDur:210, cap:1, effRate:0.06},
              {needWood:14, needStone:11, buildDur:240, cap:1, effRate:0.10},
              {needWood:12, needStone:13, buildDur:180, cap:2, effRate:0.10},
              {needWood:16, needStone:14, buildDur:250, cap:2, effRate:0.16},
              {needWood:14, needStone:16, buildDur:190, cap:2, effRate:0.22}
            ] },
  quarry: { levels:[
              {needWood:12, needStone:6,  buildDur:220, cap:1, effRate:0.20},
              {needWood:15, needStone:8,  buildDur:250, cap:1, effRate:0.30},
              {needWood:13, needStone:10, buildDur:190, cap:2, effRate:0.30},
              {needWood:17, needStone:11, buildDur:260, cap:2, effRate:0.45},
              {needWood:15, needStone:13, buildDur:210, cap:2, effRate:0.60}
            ] },
  // the mine doesn't hold ambient workers like the other functional structures —
  // its built presence is an entrance: agents physically descend through it into
  // Underground's separate cave map, mine ore there, then resurface and carry it back
  mine: { levels:[
              {needWood:14, needStone:10, buildDur:240, cap:1},
              {needWood:18, needStone:14, buildDur:270, cap:1},
              {needWood:16, needStone:18, buildDur:200, cap:2},
              {needWood:20, needStone:22, buildDur:280, cap:2},
              {needWood:18, needStone:26, buildDur:220, cap:2}
            ] },
  // ── beauty structures (S5) — the only sinks for the beauty resource, and the
  // endgame content. A monument needs beauty alongside wood/stone and radiates a
  // coherence aura; the singular Wonder is colossal and, once raised, permanently
  // lifts its settlement (see applySiteLevel). needBeauty is delivered by the
  // offerBeauty behavior.
  monument:{ levels:[
              {needWood:12, needStone:18, needBeauty:10, buildDur:260, auraR:320},
              {needWood:14, needStone:22, needBeauty:16, buildDur:300, auraR:420},
              {needWood:16, needStone:26, needBeauty:24, buildDur:340, auraR:520}
            ] },
  wonder:{ levels:[
              {needWood:40, needStone:60, needBeauty:50, buildDur:600}
            ] },
  // ── fate-gated destiny capstones (Phase D) — each is the endgame unique to one
  // emergent fate. The Wonder above is Harmony's; these are the others, so the
  // world has MANY destinies, not one. Unlocked only after a settlement has held
  // its fate long enough (see checkStructureUnlocks / g.destinyTicks).
  citadel:{ levels:[ {needWood:22, needStone:44, buildDur:440} ] },                 // DOMINION
  sanctum:{ levels:[ {needWood:24, needStone:26, needBeauty:18, buildDur:400} ] },  // COMMUNION
  greatTemple:{ levels:[ {needWood:20, needStone:46, needBeauty:22, buildDur:460} ] }, // DEVOTION
  caravanserai:{ levels:[ {needWood:36, needStone:22, buildDur:400} ] }             // DIASPORA
};
// which capstone a fate earns (Harmony's is the Wonder, handled separately)
const FATE_CAPSTONE={ DOMINION:'citadel', COMMUNION:'sanctum', DEVOTION:'greatTemple', DIASPORA:'caravanserai' };
const DESTINY_NAME={ citadel:'THE CITADEL', sanctum:'THE SANCTUARY', greatTemple:'THE GREAT TEMPLE', caravanserai:'THE CARAVANSERAI', wonder:'THE BEACON' };
const FUNCTIONAL_TYPES=['workshop','market','shrineHall','loreHall','huntingLodge','smithy','barracks','harbor','temple','tavern','quarry'];
const FUNCTIONAL_LABEL={workshop:'WORKSHOP',market:'MARKETPLACE',shrineHall:'SHRINE HALL',loreHall:'LORE HALL',huntingLodge:'HUNTING LODGE',smithy:'SMITHY',barracks:'BARRACKS',harbor:'HARBOR',temple:'TEMPLE',tavern:'TAVERN',quarry:'QUARRY'};
// small rolling activity log on a site — visible proof of what a staffed building is actually doing
function siteLog(s,msg){ s.log=s.log||[]; s.log.push(msg); if(s.log.length>6) s.log.shift(); }
function mkSite(x,y,type,gather){
  const lvl=SITE_DEFS[type].levels[0];
  const s={x,y,type,level:0,maxLevel:SITE_DEFS[type].levels.length,
    needWood:lvl.needWood,needStone:lvl.needStone,buildDur:lvl.buildDur,
    matsWood:0,matsStone:0,progress:0,built:false,faction:null,gather,
    stoneUpgraded:false,matsStoneUpgrade:0};
  if(lvl.needBeauty!=null) Object.assign(s,{needBeauty:lvl.needBeauty,matsBeauty:0});
  if(type==='well') Object.assign(s,{amount:0,max:0,regen:0});
  if(type==='farm') Object.assign(s,{stage:'empty',stageT:0,growTicks:lvl.growTicks,yieldAmt:lvl.yieldAmt});
  if(type==='granary') Object.assign(s,{workers:[],log:[],contrib:0});
  if(FUNCTIONAL_TYPES.includes(type)) Object.assign(s,{capacity:lvl.cap, effRate:lvl.effRate, workers:[],log:[],contrib:0});
  if(type==='mine') Object.assign(s,{capacity:lvl.cap, undergroundAnchor:null, oreMined:0});
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
  else if(s.type==='mine'){ s.capacity=def.cap; ag.inv.beauty+=2*s.level; if(!s.undergroundAnchor) s.undergroundAnchor=Underground.addEntrance(s); }
  else if(s.type==='monument'){ s.auraR=def.auraR; ag.inv.beauty+=2*s.level; raiseResonance(0.03*s.level); }
  else if(s.type==='wonder'){
    // the singular capstone — raising it permanently lifts its settlement:
    // a prosperity floor high enough to keep writing coherence into the field
    // forever (see the dayTick%60 block), a global resonance surge, and a
    // housing bump (see housingCapacity). Reaching it also unlocks BEACON tier.
    const g=World.gathers[s.gather]; if(g) g.wonderProsperity=0.65;
    raiseResonance(0.25);
    Mesh.broadcast(s.x,s.y,'discovery',1,'#ffe9b0');
    Events.banner='A WONDER RISES — THE MESH REMEMBERS'; Events.active='wonder'; Events.activeT=320;
  }
  else if(s.type==='citadel'||s.type==='sanctum'||s.type==='greatTemple'||s.type==='caravanserai'){
    // a fate-gated destiny capstone — crystallizes one of the plural endgames.
    // It's non-terminal: g.destiny is cleared if the culture later drifts off
    // the fate that earned it (see the dayTick%60 block).
    const g=World.gathers[s.gather];
    if(g){
      g.destiny=DESTINY_NAME[s.type];
      g.destinyFate={citadel:'DOMINION',sanctum:'COMMUNION',greatTemple:'DEVOTION',caravanserai:'DIASPORA'}[s.type];
      g.destinyProsperity=0.6; // a lasting boon, like the Wonder's
    }
    raiseResonance(s.type==='greatTemple'?0.2:0.12);
    Mesh.broadcast(s.x,s.y,'discovery',1,'#ffe9b0');
    const BAN={citadel:'A CITADEL RISES — ORDER IS ABSOLUTE', sanctum:'A SANCTUARY RISES — NONE SHALL WANT', greatTemple:'A GREAT TEMPLE RISES — THE FIELD LISTENS', caravanserai:'A CARAVANSERAI RISES — THE ROADS ARE ONE'};
    Events.banner=BAN[s.type]; Events.active='destiny'; Events.activeT=320;
  }
  ag.remember('raised a '+s.type+' to level '+s.level);
  Mesh.broadcast(s.x,s.y,'discovery',0.7,Factions[ag.faction].color); raiseResonance(0.02);
  if(s.level<s.maxLevel){
    const next=SITE_DEFS[s.type].levels[s.level];
    s.needWood=next.needWood; s.needStone=next.needStone; s.buildDur=next.buildDur;
    s.matsWood=0; s.matsStone=0; s.progress=0;
    if(next.needBeauty!=null){ s.needBeauty=next.needBeauty; s.matsBeauty=0; }
  }
}

// ── Settlement tier ladder (per gathering spot, gated by built structures) ──-
// hut requirements above 6 were never reachable in practice — 5 gathering spots
// split the population thin enough that no single settlement's hut count was ever
// observed clearing 7 in multi-hour runs (confirmed live: max 7, plateauing well
// short of 8). Every tier here is capped at hut:6, matching the threshold
// checkStructureUnlocks() already uses to unlock masonry/granary/townHall.
const SETTLEMENT_TIERS=[
  {name:'CAMP',         req:{}},
  {name:'HAMLET',       req:{hut:3}},
  {name:'VILLAGE',      req:{hut:5, well:1}},
  {name:'TOWNSHIP',     req:{hut:6, well:2, farm:2}},
  {name:'CIVILIZATION', req:{hut:6, well:2, farm:4, granary:1}},
  {name:'STONE TOWN',   req:{hut:6, well:2, farm:4, granary:1, masonry:1}},
  {name:'GUILDHOLD',    req:{hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1}},
  {name:'BASTION',      req:{hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1, barracks:1}},
  {name:'DOMINION',     req:{hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1, barracks:1, temple:1, mine:1}},
  {name:'CONFEDERACY',  req:{hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1, barracks:1, temple:1, mine:1, harbor:1}},
  {name:'METROPOLIS',   req:{hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1, barracks:1, temple:1, mine:1, harbor:1, tavern:1, quarry:1}},
  // the true endgame — a settlement that has raised both a monument and the
  // singular Wonder. Requires the full networked economy behind it (see the
  // wonder's unlock gate in checkStructureUnlocks).
  {name:'BEACON',       req:{hut:6, well:2, farm:4, granary:1, masonry:1, townHall:1, smithy:1, barracks:1, temple:1, mine:1, harbor:1, tavern:1, quarry:1, monument:1, wonder:1}}
];

// the world's Age = the character the majority of its settlements share right
// now (derived from settlement fates every aggregation pass — it rises and falls)
const AGE_OF={ HARMONY:'AN AGE OF HARMONY', DOMINION:'AN AGE OF IRON', COMMUNION:'AN AGE OF COMMUNION', DIASPORA:'AN AGE OF WANDERING', DEVOTION:'AN AGE OF FAITH', RUIN:'AN AGE OF SILENCE', FLEDGLING:'THE FIRST DAYS' };

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
  totalBorn:0, totalDied:0, totalCrimes:0, crimesByFaction:[0,0,0,0],

  init(seed){
    this.rng=makeRNG(seed||((Math.random()*1e9)|0));
    this.w=this.cols*this.ts; this.h=this.rows*this.ts;
    this.totalBorn=0; this.totalDied=0; this.totalCrimes=0; this.crimesByFaction=[0,0,0,0];
    this.factionStock=[{},{},{},{}];
    // the Altar — a fixed landmark at the heart of the map, not built by agents
    this.altar={ x:this.w/2, y:this.h/2, sacrifices:0, worshipped:0, log:[] };
    this._pendingPulses=[]; // deferred field writes, e.g. the dissolution coherence-surge below
    this.routes=[]; // inter-settlement trade routes {a,b,mode,strength,lastTripTick} (S3)
    this.figures=[]; // named souls the world remembers — prophets, founders (Phase F)
    this.generate();
  },

  // judgment ceremony — a captured criminal, marched to the Altar by their own
  // feet (see Agent.chooseTask's captured branch), is given to the Collective.
  // This is a ceremonial dissolution, not an ordinary death: it fires an immediate
  // dissonance-spike (the letting-go) and a delayed coherence-surge (the re-integration),
  // never a grief pulse — see Agent.die()'s _dissolving branch.
  judgeCriminal(agent){
    const alt=this.altar;
    siteLog(alt, agent.name+' returned to the source, unable to hold form, after '+agent.crime);
    logJustice(agent.name+' returned to the source, unable to hold form, after '+agent.crime);
    alt.sacrifices++;
    Events.banner=agent.name.toUpperCase()+' HAS RETURNED TO THE SOURCE';
    Events.active='judgment'; Events.activeT=300;
    Mesh.broadcast(alt.x,alt.y,'judgment',1,'#ffe9b0');
    raiseResonance(0.05);
    Mesh.dissonance=Math.max(0,Mesh.dissonance-0.1);
    agent._dissolving=true;
    this._pendingPulses.push({x:alt.x,y:alt.y,dueTick:this.tick+30+((Math.random()*20)|0),channel:'coherence',amount:0.5,radius:140});
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
      else t=TILE.PLAIN;
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
        else if(sub==='stone') ok=(t===TILE.PLAIN);
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
          this.gathers.push({x:(c+0.5)*this.ts,y:(r+0.5)*this.ts,tier:0,
            // settlement-level economy: a real store (generalizes the old
            // stoneStock/oreStock scalars), an abstract coin treasury that
            // funds wages, and a slow prosperity scalar every economic
            // system reads and writes. See World.update's 60-tick block.
            stock:{food:0,wood:0,stone:0,ore:0,herb:0,goods:0,ale:0,rations:0,medicine:0},
            treasury:0, prosperity:0});
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
      if(tt!==TILE.PLAIN) continue;
      let tooClose=false;
      for(const s of this.sites){ if((s.x-x)**2+(s.y-y)**2<minSpacing*minSpacing){ tooClose=true; break; } }
      if(tooClose) continue;
      this.sites.push(mkSite(x,y,type,gather));
      return true;
    }
    return false;
  },
  // harbor-only variant of placeSite — gated to TILE.SHORE instead of PLAIN,
  // since a harbor only makes sense sitting right on the water's edge
  placeSiteOnShore(cx,cy,rmin,rmax,type,gather,minSpacing){
    for(let tries=0;tries<20;tries++){
      const ang=this.rng()*Math.PI*2, r=rmin+this.rng()*(rmax-rmin);
      const x=cx+Math.cos(ang)*r, y=cy+Math.sin(ang)*r;
      if(x<20||y<20||x>this.w-20||y>this.h-20) continue;
      if(this.tileAt(x,y)!==TILE.SHORE) continue;
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
      // (huts>=12 here was never reachable in practice — 5 gathering spots split
      // the population thin enough that no single settlement ever filled 12 hut
      // plots; 6 lines up with granary's own prerequisite, the tier just below.)
      const hasMasonrySite=this.sites.some(s=>s.type==='masonry'&&s.gather===gi);
      if(!hasMasonrySite && huts>=6 && wells>=2 && farms>=4 && granaries>=1) this.placeSite(g.x,g.y,90,170,'masonry',gi,55);
      const masonryBuilt=this.sites.filter(s=>s.type==='masonry'&&built(s)).length;
      // huts>=8 here was never reachable in practice — same crowding issue as
      // masonry's old huts>=12 gate above; 6 lines up with masonry's own bar and
      // with every tier requirement above (SETTLEMENT_TIERS), confirmed reachable
      // live (multiple settlements observed clearing 6-7 huts in long runs).
      const hasTownHallSite=this.sites.some(s=>s.type==='townHall'&&s.gather===gi);
      if(!hasTownHallSite && masonryBuilt>=1 && huts>=6) this.placeSite(g.x,g.y,60,140,'townHall',gi,60);
      const townHallBuilt=this.sites.filter(s=>s.type==='townHall'&&built(s)).length;

      // mine unlocks once a settlement has raised a town hall — the same maturity
      // bar as barracks — and gates smithy (which needs a built mine) for tiers
      // beyond GUILDHOLD; its first level-up carves a real entrance into Underground
      const hasMineSite=this.sites.some(s=>s.type==='mine'&&s.gather===gi);
      if(!hasMineSite && townHallBuilt>=1) this.placeSite(g.x,g.y,70,200,'mine',gi,50);
      const mineBuilt=this.sites.filter(s=>s.type==='mine'&&built(s)).length;
      const hasSmithySite=this.sites.some(s=>s.type==='smithy'&&s.gather===gi);
      if(!hasSmithySite && mineBuilt>=1) this.placeSite(g.x,g.y,70,170,'smithy',gi,50);

      const hasBarracksSite=this.sites.some(s=>s.type==='barracks'&&s.gather===gi);
      if(!hasBarracksSite && townHallBuilt>=1) this.placeSite(g.x,g.y,70,190,'barracks',gi,50);

      // harbor needs a shoreline, not just a thriving settlement — silently never
      // unlocks for landlocked gathers, same shape as every other emergent unlock
      const hasHarborSite=this.sites.some(s=>s.type==='harbor'&&s.gather===gi);
      if(!hasHarborSite && masonryBuilt>=1) this.placeSiteOnShore(g.x,g.y,40,220,'harbor',gi,50);

      const shrineHallBuilt=this.sites.filter(s=>s.type==='shrineHall'&&built(s)).length;
      const hasTempleSite=this.sites.some(s=>s.type==='temple'&&s.gather===gi);
      if(!hasTempleSite && shrineHallBuilt>=1 && masonryBuilt>=1) this.placeSite(g.x,g.y,70,190,'temple',gi,50);

      const marketBuilt=this.sites.filter(s=>s.type==='market'&&built(s)).length;
      const hasTavernSite=this.sites.some(s=>s.type==='tavern'&&s.gather===gi);
      if(!hasTavernSite && marketBuilt>=1 && farms>=4) this.placeSite(g.x,g.y,70,180,'tavern',gi,50);

      // quarry unlocks once a settlement is mature enough (2 wells) to staff it
      const hasQuarrySite=this.sites.some(s=>s.type==='quarry'&&s.gather===gi);
      if(!hasQuarrySite && wells>=2) this.placeSite(g.x,g.y,70,200,'quarry',gi,50);

      // monument (beauty structure) — a Stone Town that has grown modestly
      // prosperous earns the option to raise one
      const hasMonumentSite=this.sites.some(s=>s.type==='monument'&&s.gather===gi);
      if(!hasMonumentSite && g.tier>=5 && (g.prosperity||0)>0.4) this.placeSite(g.x,g.y,90,200,'monument',gi,60);
      // the Wonder — the singular capstone, gated behind a Metropolis, high
      // prosperity, AND a strong trade route: the endgame demands a networked
      // economy, not an isolated grind.
      const hasWonderSite=this.sites.some(s=>s.type==='wonder'&&s.gather===gi);
      const strongRoute=this.routes.some(r=>(r.a===gi||r.b===gi)&&r.strength>5);
      if(!hasWonderSite && g.tier>=10 && (g.prosperity||0)>0.8 && strongRoute) this.placeSite(g.x,g.y,110,220,'wonder',gi,70);

      // fate-gated destiny capstones — a settlement that has HELD its fate long
      // enough earns the endgame structure unique to that fate. The Wonder above
      // is Harmony's; these make the world's endgame genuinely plural.
      const cap=FATE_CAPSTONE[g.fate];
      if(cap && (g.destinyTicks||0)>=6 && !this.sites.some(s=>s.type===cap&&s.gather===gi)) this.placeSite(g.x,g.y,80,210,cap,gi,60);
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

    // deferred field writes (e.g. the coherence-surge that follows a dissolution's dissonance-spike)
    if(this._pendingPulses&&this._pendingPulses.length){
      for(let i=this._pendingPulses.length-1;i>=0;i--){
        const p=this._pendingPulses[i];
        if(this.tick>=p.dueTick){ Mesh.writeField(p.x,p.y,p.channel,p.amount,p.radius); this._pendingPulses.splice(i,1); }
      }
    }

    if(this.dayTick%30===0) this.checkStructureUnlocks();
    if(this.dayTick%60===0){
      // trade routes: slowly decay (unused roads are forgotten), cull the dead,
      // and pay passive income to the settlements a strong route links — this
      // feeds each gather's routeIncome, read by the prosperity formula below.
      for(const g of this.gathers) g.routeIncome=0;
      for(let ri=this.routes.length-1;ri>=0;ri--){
        const r=this.routes[ri];
        // Wayfarer-run routes (routeDecay doctrine) fade more slowly
        r.strength*=(1 - 0.003*factionEcon(r.faction!=null?r.faction:0,'routeDecay'));
        if(r.strength<0.5){ this.routes.splice(ri,1); continue; }
        if(r.strength>5){
          const inc=Math.min(0.01,(r.strength-5)*0.0006);
          const ga=this.gathers[r.a], gb=this.gathers[r.b];
          if(ga) ga.routeIncome=(ga.routeIncome||0)+inc;
          if(gb) gb.routeIncome=(gb.routeIncome||0)+inc;
        }
      }
      for(let gi=0;gi<this.gathers.length;gi++){
        const g=this.gathers[gi], nt=this.tierOf(gi);
        if(nt>g.tier){ g.tier=nt; this.onTierUp(gi,nt); }
        // food-security (granaries) & rest-bonus (huts) auras for this settlement —
        // cheap to recompute since sites are already tagged with their gather index
        let foodSec=0, restMult=1, govern=0, tavernBonus=0, hasGranary=false;
        const facCount=[0,0,0,0];
        for(const s of this.sites){
          if(s.gather!==gi || !s.built) continue;
          if(s.faction!=null) facCount[s.faction]++;
          if(s.type==='granary'){ hasGranary=true; s.contrib=(s.capacity||1)*0.4+((s.workers||[]).length>0?0.15*s.workers.length:0); if(s.stoneUpgraded) s.contrib*=1.1; foodSec+=s.contrib; }
          if(s.type==='huntingLodge'){ s.contrib=(s.workers||[]).length>0?(s.effRate||0.1)*s.workers.length:0; if(s.stoneUpgraded) s.contrib*=1.1; foodSec+=s.contrib; }
          if(s.type==='harbor'){ s.contrib=(s.workers||[]).length>0?(s.effRate||0.1)*s.workers.length:0; if(s.stoneUpgraded) s.contrib*=1.1; foodSec+=s.contrib; }
          if(s.type==='hut' && s.restMult){ const rm=s.stoneUpgraded?s.restMult*1.1:s.restMult; restMult=Math.max(restMult,rm); }
          // masonry holds no workers, so its stoneRate trickles into the settlement stockpile passively here instead
          if(s.type==='masonry' && s.stoneRate){ g.stock.stone=(g.stock.stone||0)+s.stoneRate; }
          if(s.type==='townHall') govern+=s.level;
          if(s.type==='tavern'){
            // a tavern only lifts spirits while it has ale to pour; an unsupplied
            // one goes flat. (ale is brewed from stocked food — see doJob tavern.)
            const alePour=Math.min(1,(g.stock.ale||0)*0.1);
            tavernBonus=Math.max(tavernBonus,(s.workers||[]).length>0?(s.effRate||0.1)*(0.3+0.7*alePour):0.03);
          }
        }
        // deposited food is real food security, not just the granary aura
        g.foodSec=foodSec + Math.min(1.5,(g.stock.food||0)*0.02);
        // granary preservation cycle: bank surplus food as rations through
        // autumn, then draw those rations down in winter to hold food security
        // up when the fields have gone quiet — winter finally rewards foresight.
        if(hasGranary){
          if(this.season===2 && (g.stock.food||0)>6){ const conv=Math.min(g.stock.food-6,2); g.stock.food-=conv; g.stock.rations=(g.stock.rations||0)+conv; }
          if(this.season===3 && (g.stock.rations||0)>0){ const draw=Math.min(g.stock.rations,1.5); g.stock.rations-=draw; g.foodSec+=draw*0.5; }
        }
        g.restMult=restMult; g.govern=govern; g.tavernBonus=tavernBonus;

        // settlement specialization: the dominant faction among a settlement's
        // built structures gives it a character. It's pure branding on top of
        // the linear tier ladder (the tier mechanic is untouched) — the real
        // economic tilt comes from factionEcon on the agents who work there.
        let domF=-1,domN=0; for(let f=0;f<4;f++){ if(facCount[f]>domN){ domN=facCount[f]; domF=f; } }
        g.specFaction = domN>0?domF:null;
        g.spec = domN>0 ? ['AGRARIAN','MERCANTILE','FORGEHOLD','SANCTUARY'][domF] : null;

        // prosperity — the slow-moving settlement wealth scalar every economic
        // system feeds. Income from staffed jobs, accumulated stock, and (later)
        // trade routes; it decays if the settlement stops producing, and a
        // thriving town literally warms the Mesh field (chooseTask's coherence
        // branch then lifts social/trade/creative there — a free feedback loop).
        let staffed=0, stockTotal=0, monuments=0;
        for(const s of this.sites){
          if(s.gather!==gi || !s.built) continue;
          if(s.type==='granary' || FUNCTIONAL_TYPES.includes(s.type)) staffed+=(s.workers||[]).length;
          if(s.type==='monument' || s.type==='wonder') monuments++; // beauty made permanent
        }
        for(const k in g.stock) stockTotal+=g.stock[k];
        const routeIncome=g.routeIncome||0; // filled by the caravan system (S3)
        const wonderBonus=Math.max(g.wonderProsperity||0, g.destinyProsperity||0); // a completed wonder OR destiny floors prosperity
        g.prosperity=Math.max(wonderBonus,Math.min(1,
          (g.prosperity||0)*0.995 + 0.002*staffed + 0.0004*stockTotal + 0.002*monuments + routeIncome));
        if(g.prosperity>0.6) Mesh.writeField(g.x,g.y,'coherence',(g.prosperity-0.6)*0.05,300);
      }

      // wealth inequality → local fragmentation. Bin the living to their
      // nearest gather; where the gap between the richest and the average is
      // stark, write a little dissonance there. criminality already floats on
      // local dissonance (see Agent.update) and the steal behavior scales with
      // criminality — so inequality drives crime through the mechanics that
      // already exist, with no new crime code.
      // One pass bins every living soul to its nearest gather and accumulates,
      // per settlement: wealth (for inequality) AND the sum/sum-of-squares of
      // the five ideals (for culture + tension). Same O(agents) cost as before.
      const nG=this.gathers.length;
      const wSum=new Array(nG).fill(0), wMax=new Array(nG).fill(0), wCnt=new Array(nG).fill(0);
      const wMin=new Array(nG).fill(Infinity), poorest=new Array(nG).fill(null);
      const cSum=[], cSq=[];
      for(let i=0;i<nG;i++){ cSum.push({order:0,communion:0,faith:0,material:0,freedom:0}); cSq.push({order:0,communion:0,faith:0,material:0,freedom:0}); }
      for(const a of Agents){
        if(a.dead||a.underground) continue;
        let bi=-1,bd=Infinity;
        for(let gi=0;gi<nG;gi++){ const gg=this.gathers[gi]; const d=(gg.x-a.x)**2+(gg.y-a.y)**2; if(d<bd){ bd=d; bi=gi; } }
        if(bi<0) continue;
        a._gi=bi; // which settlement this soul belongs to (for schism, Phase E)
        const w=a.wealth||0; wSum[bi]+=w; wCnt[bi]++; if(w>wMax[bi]) wMax[bi]=w;
        if(w<wMin[bi]){ wMin[bi]=w; poorest[bi]=a; }
        if(a.ideals){ for(const k of IDEAL_KEYS){ const v=a.ideals[k]; cSum[bi][k]+=v; cSq[bi][k]+=v*v; } }
      }
      const fateCount={};
      for(let gi=0;gi<nG;gi++){
        const g=this.gathers[gi], n=wCnt[gi];
        g._pop=n;
        // inequality → local fragmentation (gentle; only stark gaps bite, so
        // ordinary prosperity doesn't spiral — almsgiving + governance counter it)
        if(n>=4){
          const avg=wSum[gi]/n; g._spread=wMax[gi]-avg;
          if(g._spread>10) Mesh.writeField(g.x,g.y,'dissonance',Math.min(0.18,(g._spread-10)*0.01),220);
        } else g._spread=0;
        // culture = mean ideals of the settlement's souls; tension = how much
        // they DISAGREE (mean variance across the five axes) — high tension is
        // what rewards divergence and later drives schism, so the world never
        // collapses to one bland centroid.
        if(n>=1){
          const C={}; let tension=0;
          for(const k of IDEAL_KEYS){ const m=cSum[gi][k]/n; C[k]=m; tension+=Math.max(0,cSq[gi][k]/n - m*m); }
          g.culture=C; g.tension=Math.min(1,(tension/IDEAL_KEYS.length)*4);
          // emergent redistribution custom: a settlement that believes in
          // communion shares its treasury with its poorest — institutionalizing
          // almsgiving, which pulls the inequality that fuels crime back down
          if(n>=4 && C.communion>0.6 && (g.treasury||0)>=2 && poorest[gi]){
            poorest[gi].wealth=(poorest[gi].wealth||0)+2; g.treasury-=2; poorest[gi].driftIdeal('communion',0.02);
          }
        }
        // fate is DERIVED every pass (never latched) with a short hysteresis so
        // it drifts and reverses with the souls but doesn't flicker cosmetically
        const nf=this.deriveFate(gi);
        if(nf===g._fateCand) g._fateHold=(g._fateHold||0)+1; else { g._fateCand=nf; g._fateHold=0; }
        if(!g.fate) g.fate=nf;
        else if(g._fateHold>=2 && g.fate!==nf) g.fate=nf;
        if(g.fate && g.fate!=='FLEDGLING') fateCount[g.fate]=(fateCount[g.fate]||0)+1;

        // destiny commitment: a settlement that HOLDS a characterful fate accrues
        // destinyTicks toward its capstone; drifting off the fate resets the clock
        // and forfeits any crystallized destiny (non-terminal — nothing is forever)
        if(g.fate===g._destinyFateTracked && g.fate!=='FLEDGLING' && g.fate!=='RUIN') g.destinyTicks=(g.destinyTicks||0)+1;
        else { g._destinyFateTracked=g.fate; g.destinyTicks=0; }
        if(g.destiny && g.fate!==g.destinyFate){ g.destiny=null; g.destinyProsperity=0; }

        // sustained RUIN crumbles a settlement — its structures slowly revert to
        // the land, until the fate lifts and its people can rebuild
        if(g.fate==='RUIN'){
          g._ruinTicks=(g._ruinTicks||0)+1;
          if(g._ruinTicks>4 && g._ruinTicks%3===0){
            const built=this.sites.filter(s=>s.gather===gi && s.built && s.type!=='hut' && s.type!=='mine');
            if(built.length){ const s=built[(Math.min(built.length-1,(built.length*this.rng())|0))]; s.level=Math.max(0,s.level-1); s.progress=0; s.matsWood=0; s.matsStone=0; if(s.level===0){ s.built=false; s.stoneUpgraded=false; } }
          }
        } else g._ruinTicks=0;
        // a settlement's fate lightly colours the field beneath it, closing the
        // belief -> culture -> field -> behavior loop
        if(g.fate==='HARMONY'||g.fate==='COMMUNION'||g.fate==='DEVOTION') Mesh.writeField(g.x,g.y,'coherence',0.02,280);
        else if(g.fate==='DOMINION'||g.fate==='RUIN') Mesh.writeField(g.x,g.y,'dissonance',0.02,280);
      }
      // the world Age = the character the majority of settlements share now
      let domFate=null,dc=0; for(const f in fateCount){ if(fateCount[f]>dc){ dc=fateCount[f]; domFate=f; } }
      const newAge=(domFate && AGE_OF[domFate]) || 'THE FIRST DAYS';
      // an Age only turns once its character has HELD for a while — so an "Age"
      // is a real span of the world's life, not a half-day flicker (hysteresis)
      if(newAge===this._ageCand) this._ageHold=(this._ageHold||0)+1; else { this._ageCand=newAge; this._ageHold=0; }
      if(!this.age || this.age==='THE FIRST DAYS' || this._ageHold>=5) this.age=newAge;

      // ── inter-settlement relations (Phase E): kinship of culture + trade warms
      // peoples toward each other; difference cools them. Feuds erode the routes
      // between enemies; alliances and unions strengthen them. ────────────────
      this.relations={};
      for(let i=0;i<nG;i++){
        if((this.gathers[i]._pop||0)<3 || !this.gathers[i].culture) continue;
        for(let j=i+1;j<nG;j++){
          if((this.gathers[j]._pop||0)<3 || !this.gathers[j].culture) continue;
          const gi=this.gathers[i], gj=this.gathers[j];
          const kin=1-Math.min(1,idealDistance(gi.culture,gj.culture)/1.2);
          const route=this.routes.find(r=>(r.a===i&&r.b===j)||(r.a===j&&r.b===i));
          const trade=route?Math.min(1,route.strength/12):0;
          const warmth=kin*0.65+trade*0.35;
          let standing = warmth>0.72?'UNION' : warmth>0.55?'ALLY' : warmth>0.35?'NEUTRAL' : warmth>0.2?'RIVAL':'FEUD';
          if(standing==='UNION' && !(trade>0.3 && (gi.prosperity||0)>0.4 && (gj.prosperity||0)>0.4)) standing='ALLY';
          this.relations[i+'-'+j]={standing,warmth};
          if(standing==='FEUD' && route) route.strength*=0.9;
          else if((standing==='UNION'||standing==='ALLY') && route) route.strength=Math.min(30,route.strength+0.3);
        }
      }

      // ── schism (Phase E): a deeply divided settlement whose dissidents share a
      // different heart may break away and FOUND a new settlement — the map of
      // peoples reshaping itself from free choice. Rate-limited and capped. ────
      if(nG<9 && this.tick-(this._lastSchism||0) > this.dayLen*1.5){
        for(let gi=0;gi<nG;gi++){
          const g=this.gathers[gi];
          if((g.tension||0)<0.34 || (g._pop||0)<16) continue;
          const dissidents=[];
          for(const a of Agents){ if(a._gi===gi && !a.dead && !a.underground && a.ideals && idealDistance(a.ideals,g.culture)>0.5) dissidents.push(a); }
          if(dissidents.length>=6 && this.foundSchism(gi,dissidents)){ this._lastSchism=this.tick; break; }
        }
      }

      // per-faction resource ledger — a live snapshot of what each faction's living members currently hold
      const stock=[{},{},{},{}];
      for(const a of Agents){
        if(a.dead) continue;
        const fs=stock[a.faction]; if(!fs) continue;
        for(const k of RESOURCES) if(a.inv[k]>0) fs[k]=(fs[k]||0)+a.inv[k];
      }
      this.factionStock=stock;
    }

    this.updateAnimals();
  },

  // a completed caravan round-trip records (or strengthens) a trade route
  // between two settlements and rewards both ends with a prosperity bump
  recordRoute(a,b,mode,value,faction){
    if(a===b) return;
    let r=this.routes.find(x=>(x.a===a&&x.b===b)||(x.a===b&&x.b===a));
    if(!r){ r={a,b,mode,strength:0,lastTripTick:this.tick,faction:faction!=null?faction:0}; this.routes.push(r); }
    else if(faction!=null) r.faction=faction;
    r.strength=Math.min(30,r.strength+1); r.lastTripTick=this.tick; r.mode=mode;
    const boost=Math.min(0.06,0.02+(value||0)*0.004);
    const ga=this.gathers[a], gb=this.gathers[b];
    if(ga) ga.prosperity=Math.min(1,(ga.prosperity||0)+boost);
    if(gb) gb.prosperity=Math.min(1,(gb.prosperity||0)+boost);
  },
  // a robbery on the road badly damages the route it hit
  weakenRoute(a,b){
    const r=this.routes.find(x=>(x.a===a&&x.b===b)||(x.a===b&&x.b===a));
    if(r) r.strength=Math.max(0,r.strength*0.4);
  },

  // the world remembers the souls who shaped it — prophets, founders (Phase F)
  recordFigure(name, deed){
    this.figures=this.figures||[];
    this.figures.push({name, deed, tick:this.tick, age:this.age});
    if(this.figures.length>14) this.figures.shift();
  },

  // pure: read a settlement's culture + live metrics and name its CURRENT fate.
  // No latching, no scripting — the fate is simply what these numbers say now,
  // so it drifts and reverses as the souls do. RUIN (collapse) is the absence of
  // any cohered ideal under material failure, not a value the souls hold.
  deriveFate(gi){
    const g=this.gathers[gi], C=g.culture;
    if(!C || (g._pop||0)<4) return 'FLEDGLING';
    const coh=Mesh.coherenceAt(g.x,g.y), dis=Mesh.dissonanceAt(g.x,g.y);
    const prosp=g.prosperity||0, food=g.foodSec||0, gov=g.govern||0, spread=g._spread||0;
    if(food<0.35 && dis>0.42 && prosp<0.4) return 'RUIN';
    let dom=null,dv=-1,second=-1;
    for(const k of IDEAL_KEYS){ const v=C[k]; if(v>dv){ second=dv; dv=v; dom=k; } else if(v>second) second=v; }
    const lead=dv-second; // how clearly one ideal leads the settlement
    if(lead>0.1){
      if(dom==='order') return 'DOMINION';
      if(dom==='communion') return 'COMMUNION';
      if(dom==='faith') return 'DEVOTION';
      if(dom==='freedom') return 'DIASPORA';
      if(dom==='material') return (coh>0.55 && prosp>0.5) ? 'HARMONY' : 'FLEDGLING';
    }
    if(coh>0.58 && prosp>0.5) return 'HARMONY';
    return 'FLEDGLING';
  },

  // a breakaway minority founds a brand-new settlement (Phase E). Adds a gather
  // to the world at runtime, seeds it with starter plots, and relocates the
  // dissidents there carrying their own beliefs — so it begins with a distinct
  // culture and quickly finds its own divergent fate.
  foundSchism(fromGi, dissidents){
    let spot=null;
    for(let tries=0;tries<50;tries++){
      const c=(this.rng()*this.cols)|0, r=(this.rng()*this.rows)|0;
      if(this.tiles[r*this.cols+c]!==TILE.PLAIN) continue;
      const x=(c+0.5)*this.ts, y=(r+0.5)*this.ts;
      let ok=true; for(const g of this.gathers){ if((g.x-x)**2+(g.y-y)**2<420*420){ ok=false; break; } }
      if(ok){ spot={c,r,x,y}; break; }
    }
    if(!spot) return false;
    this.tiles[spot.r*this.cols+spot.c]=TILE.GATHER;
    const gi=this.gathers.length;
    this.gathers.push({x:spot.x,y:spot.y,tier:0,
      stock:{food:0,wood:0,stone:0,ore:0,herb:0,goods:0,ale:0,rations:0,medicine:0}, treasury:0, prosperity:0});
    this.fires.push({x:spot.x,y:spot.y,lit:true});
    this.placeSite(spot.x,spot.y,55,150,'hut',gi,80);
    this.placeSite(spot.x,spot.y,55,170,'farm',gi,70);
    for(const a of dissidents){ a.x=spot.x+(Math.random()-0.5)*90; a.y=spot.y+(Math.random()-0.5)*90; a._gi=gi; a.remember('broke away to found a new home'); a.driftIdeal('freedom',0.05); }
    const founder=dissidents[0];
    if(founder) this.recordFigure(founder.name+' '+founder.surname, 'led a people to break away and found a new home');
    Events.banner='A NEW PEOPLE BREAK AWAY'; Events.active='schism'; Events.activeT=300;
    return true;
  },

  // dynamic population ceiling driven by what's actually been built — replaces
  // the old hardcoded birth caps so growth is gated by housing, not a fixed number
  housingCapacity(){
    let cap=26; // base camp capacity, even before any hut is built
    for(const s of this.sites){
      if(!s.built) continue;
      if(s.type==='hut') cap+=s.capacity||3;
      if(s.type==='granary') cap+=(s.capacity||1)*4;
      if(s.type==='wonder') cap+=10; // a Wonder draws souls from across the world
    }
    // a prosperous settlement draws (and can feed) more souls than its huts alone
    for(const g of this.gathers) cap+=Math.floor((g.prosperity||0)*8);
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
