/* world.js — terrain, map, time of day, seasons, resource nodes */
'use strict';

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function makeRNG(seed){
  let s=seed>>>0;
  return ()=>{ s=(s+0x6D2B79F5)>>>0; let t=Math.imul(s^(s>>>15),1|s); t=(t+Math.imul(t^(t>>>7),61|t))^t; return ((t^(t>>>14))>>>0)/4294967296; };
}

// ── Tile types ───────────────────────────────────────────────────────────────
const TILE={ WATER:0, SHORE:1, PLAIN:2, FOREST:3, HILL:4, RUIN:5, FIRE:6, GATHER:7 };

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
          this.gathers.push({x:(c+0.5)*this.ts,y:(r+0.5)*this.ts});
          // a fire at each gathering spot
          this.fires.push({x:(c+0.5)*this.ts,y:(r+0.5)*this.ts,lit:true});
          break;
        }
      }
    }

    // Buildable plots — empty shelter sites agents can haul materials to and raise
    this.sites=[];
    const trySite=(cx,cy,rmin,rmax)=>{
      for(let tries=0;tries<20;tries++){
        const ang=rng()*Math.PI*2, r=rmin+rng()*(rmax-rmin);
        const x=cx+Math.cos(ang)*r, y=cy+Math.sin(ang)*r;
        if(x<20||y<20||x>this.w-20||y>this.h-20) continue;
        if(this.tileAt(x,y)!==TILE.PLAIN) continue;
        let tooClose=false;
        for(const s of this.sites){ if((s.x-x)**2+(s.y-y)**2<80*80){ tooClose=true; break; } }
        if(tooClose) continue;
        this.sites.push({x,y,needWood:7,needStone:4,matsWood:0,matsStone:0,progress:0,built:false,faction:null});
        return true;
      }
      return false;
    };
    for(const g of this.gathers){
      const n=1+((rng()*2)|0);
      for(let k=0;k<n;k++) trySite(g.x,g.y,55,150);
    }
    for(let k=0;k<8;k++) trySite(rng()*this.w, rng()*this.h, 0, 1);
  },

  tileAt(wx,wy){
    const c=(wx/this.ts)|0, r=(wy/this.ts)|0;
    if(c<0||r<0||c>=this.cols||r>=this.rows) return TILE.WATER;
    return this.tiles[r*this.cols+c];
  },
  walkable(wx,wy){ const t=this.tileAt(wx,wy); return t!==TILE.WATER; },

  // nearest node of a given resource type with stock
  nearestNode(x,y,type){
    let best=null,bd=Infinity;
    for(const nd of this.nodes){
      if(nd.type!==type) continue;
      if(nd.amount<0.25) continue;
      const d=(nd.x-x)**2+(nd.y-y)**2;
      if(d<bd){bd=d;best=nd;}
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
