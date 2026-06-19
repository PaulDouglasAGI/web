/* factions.js — faction definitions, values, desire weighting */
'use strict';

// Each faction weights behavior CATEGORIES differently.
// Categories: survival, trade, social, inner, explore, creative, mesh, justice, worship
const Factions=[
  {
    id:0, name:'CULTIVATORS', color:'#7fc08a', glow:'rgba(127,192,138,',
    blurb:'patience · tending · growth',
    weights:{ survival:1.7, trade:0.9, social:1.0, inner:0.9, explore:0.6, creative:1.2, mesh:0.9, justice:1.0, worship:1.1 }
  },
  {
    id:1, name:'WAYFARERS', color:'#e6b455', glow:'rgba(230,180,85,',
    blurb:'movement · discovery · mapping',
    weights:{ survival:0.9, trade:1.4, social:0.9, inner:0.9, explore:1.9, creative:0.8, mesh:1.0, justice:0.7, worship:0.6 }
  },
  {
    id:2, name:'FORGERS', color:'#e08043', glow:'rgba(224,128,67,',
    blurb:'transformation · craft · refinement',
    weights:{ survival:1.1, trade:1.2, social:0.8, inner:0.9, explore:0.8, creative:1.7, mesh:0.8, justice:0.9, worship:0.8 }
  },
  {
    id:3, name:'TENDERS', color:'#b89bd9', glow:'rgba(184,155,217,',
    blurb:'relationships · care · memory',
    weights:{ survival:0.9, trade:0.9, social:1.9, inner:1.2, explore:0.7, creative:1.0, mesh:1.5, justice:1.4, worship:1.6 }
  }
];

function factionWeight(factionId, category){
  return Factions[factionId].weights[category] || 1;
}
