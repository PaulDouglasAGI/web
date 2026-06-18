/* world.js — terrain, map, time of day, seasons, resource nodes */
'use strict';

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function makeRNG(seed){
  let s=seed>>>0;
  return ()=>{ s=(s+0x6D2B79F5)>>>0; let t=Math.imul(s^(s>>>15),1|s); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };
}

// ── Tile types ───────────────────────────────────────────────────────────────
const TILE={ WATER:0, SHORE:1, PLAIN:2, FOREST:3, HILL:4, RUIN:5, FIRE:6, GATHER:7 };

// ── Buildable structure types ──────────────────────────────────────────────--
const SITE_DEFS={
  hut:    {needWood:7,  needStone:4,  buildDur:170},
  well:   {needWood:3,  needStone:9,  buildDur:170},
  farm:   {needWood:5,  needStone:1,  buildDur:120},
  granary:{needWood:10, needStone:10, buildDur:240}
};
function mkSite(x,y,type,gather){
  const def=SITE_DEFS[type];
  const s={x,y,type,needWood:def.needWood,needStone:def.needStone,buildDur:def.buildDur,
    matsWood:0,matsStone:0,progress:0,built:false,faction:null,gather};
  if(type==='well') Object.assign(s,{amount:0,max:0,regen:0});
  if(type==='farm') Object.assign(s,{stage:'empty',stageT:0});
  return s;
}

// ── Settlement tier ladder (per gathering spot, gated by built structures) ──-
const SETTLEMENT_TIERS=[
  {name:'CAMP',         req:{}},
  {name:'HAMLET',       req:{hut:3}},
  {name:'VILLAGE',      req:{hut:5, well:1}},
  {name:'TOWNSHIP',     req:{hut:8, well:2, farm:2}},
  {name:'CIVILIZATION', req:{hut:12, well:2, farm:4, granary:1}}
];

const World={
  cols:170, rows:118, ts:20,           // tile size in world px
  w:0, h:0,
  tiles:null, elev:null,
  nodes:[],                            // resource nodes
  fires:[],                            // fire areas (warmth/social at night)
  gathers:[],                          // gathering spots (social hubs)
  rng:null,

  // Time: dayT in [0,1). dayLen ticks per day.
  dayLen:5400, dayTick:0, dayT:0.22,
  // Season: 0 spring,1 summer,2 autumn,3 winter. seasonLen days.
  seasonLen:4, season:0, seasonProgress:0, dayCount:0,

  init(seed){
    this.rng=makeRNG(seed||((Math.random()*1e9)|0));
    this.w=this.cols*this.ts; this.h=this.rows*this.ts;
    this.generate();
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
      else if(v<0.62) t=TILE.PLAIN;
      else if(v<0.82) t=TILE.HILL;
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
      if(this.tileAt(x,y)!==TILE.PLAIN) continue;
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

  // nearest node of a given resource type with stock (built wells duck-type as water nodes)
  nearestNode(x,y,type){
    let best=null,bd=Infinity;
    for(const nd of this.nodes){
      if(nd.type!==type) continue;
      if(nd.amount<0.25) continue;
      const d=(nd.x-x)**2+(nd.y-y)**2;
      if(d<bd){bd=d;best=nd;}
    }
    if(type==='water'){
      for(const s of this.sites){
        if(s.type!=='well'||!s.built||s.amount<0.25) continue;
        const d=(s.x-x)**2+(s.y-y)**2;
        if(d<bd){bd=d;best=s;}
      }
    }
    return best;
  },
  nearestOf(list,x,y){
    let best=null,bd=Infinity;
    for(const o of list){ const d=(o.x-x)**2+(o.y-y)**2; if(d<bd){bd=d;best=o;} }
    return best;
  },
  nearestSite(x,y,filter){
    let best=null,bd=Infinity;
    for(const s of this.sites){
      if(filter && !filter(s)) continue;
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

      const hasWellSite=this.sites.some(s=>s.type==='well'&&s.gather===gi);
      if(!hasWellSite && huts>=2) this.placeSite(g.x,g.y,40,90,'well',gi,60);
      const wells=this.sites.filter(s=>s.type==='well'&&built(s)).length;
      const farms=this.sites.filter(s=>s.type==='farm'&&built(s)).length;
      const hasGranarySite=this.sites.some(s=>s.type==='granary'&&s.gather===gi);
      if(!hasGranarySite && huts>=6 && wells>=1 && farms>=2) this.placeSite(g.x,g.y,40,90,'granary',gi,60);
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
    // Farm lifecycle — crops grow whether or not anyone is watching
    for(const s of this.sites){
      if(s.type!=='farm' || !s.built) continue;
      if(s.stage==='planted'){ s.stageT+=seasonRegen; if(s.stageT>900){ s.stage='growing'; s.stageT=0; } }
      else if(s.stage==='growing'){ s.stageT+=seasonRegen; if(s.stageT>900){ s.stage='ready'; s.stageT=0; } }
    }

    if(this.dayTick%30===0) this.checkStructureUnlocks();
    if(this.dayTick%60===0){
      for(let gi=0;gi<this.gathers.length;gi++){
        const g=this.gathers[gi], nt=this.tierOf(gi);
        if(nt>g.tier){ g.tier=nt; this.onTierUp(gi,nt); }
      }
    }

    this.updateAnimals();
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
