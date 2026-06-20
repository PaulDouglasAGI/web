/* underground.js — the mine's second map: a real, separate cave grid agents
   physically descend into and resurface from. Reuses World's makeRNG and the
   same tile-size convention, but its own coordinate space — Underground.w/h
   never overlaps with World.w/h, and agent.x/y are reinterpreted as
   Underground coords while agent.underground is true. */
'use strict';

const UTILE={ ROCK:0, FLOOR:1, ORE:2 };

const Underground={
  cols:60, rows:40, ts:20,
  w:0, h:0,
  tiles:null,
  oreNodes:[],
  entrances:[],   // {x,y,site} — one per built mine, carved on first level-up
  rng:null,

  init(seed){
    this.rng=makeRNG((seed||((Math.random()*1e9)|0))^0x9e3779b9);
    this.w=this.cols*this.ts; this.h=this.rows*this.ts;
    const n=this.cols*this.rows;
    this.tiles=new Uint8Array(n); // ROCK=0 default; carved to FLOOR below
    for(let i=0;i<n;i++) this.tiles[i]=UTILE.FLOOR;

    // sparse rock clusters give the cave its shape without ever sealing it off —
    // there's no real pathfinding here (same simplification World's agents use),
    // so the cave stays mostly open and rarely needs a path around an obstacle
    const clumps=14+((this.rng()*10)|0);
    for(let k=0;k<clumps;k++){
      const cx=(this.rng()*this.cols)|0, cy=(this.rng()*this.rows)|0, rad=1+((this.rng()*3)|0);
      for(let dy=-rad;dy<=rad;dy++)for(let dx=-rad;dx<=rad;dx++){
        const x=cx+dx, y=cy+dy;
        if(x<1||y<1||x>=this.cols-1||y>=this.rows-1) continue;
        if(dx*dx+dy*dy>rad*rad) continue;
        if(this.rng()<0.5) this.tiles[y*this.cols+x]=UTILE.ROCK;
      }
    }

    this.oreNodes=[];
    const veins=12+((this.rng()*8)|0);
    for(let k=0;k<veins;k++){
      for(let tries=0;tries<30;tries++){
        const c=(this.rng()*this.cols)|0, r=(this.rng()*this.rows)|0, i=r*this.cols+c;
        if(this.tiles[i]!==UTILE.FLOOR) continue;
        this.tiles[i]=UTILE.ORE;
        this.oreNodes.push({ x:(c+0.5)*this.ts, y:(r+0.5)*this.ts, amount:1, max:1, regen:0.00003+this.rng()*0.00004 });
        break;
      }
    }

    this.entrances=[];
  },

  tileAt(wx,wy){
    const c=(wx/this.ts)|0, r=(wy/this.ts)|0;
    if(c<0||r<0||c>=this.cols||r>=this.rows) return UTILE.ROCK;
    return this.tiles[r*this.cols+c];
  },
  walkable(wx,wy){ return this.tileAt(wx,wy)!==UTILE.ROCK; },

  // carve an entrance chamber for a newly built mine, kept spaced from existing ones
  addEntrance(mineSite){
    let spot=null;
    for(let tries=0;tries<40;tries++){
      const c=2+((this.rng()*(this.cols-4))|0), r=2+((this.rng()*(this.rows-4))|0);
      const x=(c+0.5)*this.ts, y=(r+0.5)*this.ts;
      let tooClose=false;
      for(const e of this.entrances){ if((e.x-x)**2+(e.y-y)**2<160*160){ tooClose=true; break; } }
      if(tooClose) continue;
      spot={c,r}; break;
    }
    if(!spot) spot={ c:(this.rng()*this.cols)|0, r:(this.rng()*this.rows)|0 };
    // clear a small open chamber so the entrance is never sealed in rock
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
      const x=spot.c+dx, y=spot.r+dy;
      if(x<0||y<0||x>=this.cols||y>=this.rows) continue;
      this.tiles[y*this.cols+x]=UTILE.FLOOR;
    }
    const anchor={ x:(spot.c+0.5)*this.ts, y:(spot.r+0.5)*this.ts, site:mineSite };
    this.entrances.push(anchor);
    return anchor;
  },

  nearestOre(x,y){
    let best=null, bd=Infinity;
    for(const nd of this.oreNodes){
      if(nd.amount<0.2) continue;
      const d=(nd.x-x)**2+(nd.y-y)**2;
      if(d<bd){ bd=d; best=nd; }
    }
    return best;
  },

  update(){
    for(const nd of this.oreNodes){ if(nd.amount<nd.max) nd.amount=Math.min(nd.max,nd.amount+nd.regen*16); }
  },

  // send an agent down through a built mine's entrance into the cave
  descend(ag,mineSite){
    if(!mineSite.undergroundAnchor) return;
    ag.underground=true;
    ag.x=mineSite.undergroundAnchor.x; ag.y=mineSite.undergroundAnchor.y;
    ag.mineJob={ site:mineSite, stage:'toOre', entrance:mineSite.undergroundAnchor, oreTarget:null, t:0 };
    ag.task=null;
    ag.remember('descended into the mine');
  },
  // bring an agent back up at the surface mine they went down from
  ascend(ag){
    const mineSite=ag.mineJob&&ag.mineJob.site;
    ag.underground=false;
    if(mineSite){ ag.x=mineSite.x+(Math.random()-0.5)*20; ag.y=mineSite.y+(Math.random()-0.5)*20; }
    ag.mineJob=null;
    ag.task=null;
    ag.remember('returned to the surface with ore');
  }
};
