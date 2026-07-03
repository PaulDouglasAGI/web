/* economy.js — resources, inventory, bartering, resonance currency */
'use strict';

const RESOURCES=['food','water','wood','stone','tools','herb','fish','beauty','medicine'];

function newInventory(){
  return { food:0, water:0, wood:0, stone:0, tools:0, herb:0, fish:0, beauty:0, medicine:0 };
}

function invTotal(inv){
  let s=0; for(const k of RESOURCES) s+=inv[k]; return s;
}

// What does this agent most lack / most want to acquire? Drives trade & seeking.
function neededResource(agent){
  // Cultivators want wood/stone to build; Forgers want wood+stone for tools;
  // everyone wants food/water if low. Returns resource name or null.
  if(agent.hunger>62 && agent.inv.food<1) return 'food';
  if(agent.energy<35 && agent.inv.water<1) return 'water';
  const f=agent.faction;
  if(f===2 && agent.inv.tools<2) return agent.inv.wood<1?'wood':(agent.inv.stone<1?'stone':null);
  if(f===0 && agent.inv.wood<2) return 'wood';
  return null;
}

// surplus the agent is willing to give away in barter
function surplusResource(agent){
  let best=null,bv=1.2;
  for(const k of RESOURCES){
    if(k==='beauty') continue;
    if(agent.inv[k]>bv){ bv=agent.inv[k]; best=k; }
  }
  return best;
}

// Resonance — the collective currency / mood. Lives on Mesh, mutated here.
const Economy={
  // attempt a barter between two agents; returns true if a trade happened
  barter(a,b){
    const aw=neededResource(a), bGives=aw?(b.inv[aw]>1?aw:null):surplusResource(b);
    const bw=neededResource(b), aGives=bw?(a.inv[bw]>1?bw:null):surplusResource(a);
    if(aGives && bGives && aGives!==bGives){
      a.inv[aGives]-=1; b.inv[aGives]+=1;
      b.inv[bGives]-=1; a.inv[bGives]+=1;
      a.remember('traded '+bGives+' for '+aGives);
      b.remember('traded '+aGives+' for '+bGives);
      return true;
    }
    // a one-sided transfer: if the receiver can pay coin for it, it's a sale;
    // otherwise it's a gift (which still counts as alignment)
    if(aGives){ a.inv[aGives]-=1; b.inv[aGives]+=1;
      if((b.wealth||0)>0){ b.wealth-=1; a.wealth=(a.wealth||0)+1; a.remember('sold '+aGives); b.remember('bought '+aGives); }
      else { a.remember('gave '+aGives); b.remember('received '+aGives); }
      return true; }
    return false;
  }
};
