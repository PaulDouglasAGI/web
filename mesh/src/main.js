/* main.js — boot, tick engine, render loop. The world runs itself forever. */
'use strict';

const Sim={ running:true, speed:1.05 };

function boot(){
  World.init();
  Underground.init();
  Mesh.reset();
  FX.reset();
  Renderer.init();
  UI.init();
  Events.schedule();

  // start camera centered on a gathering spot
  const g=World.gathers[0]||{x:World.w/2,y:World.h/2};
  Camera.x=g.x; Camera.y=g.y; Camera.zoom=1.1;

  Agents.length=0;
  spawnAgents(80);

  requestAnimationFrame(loop);
}

let tickAcc=0;
function loop(){
  requestAnimationFrame(loop);

  // fixed-step simulation (decoupled from render) — fractional speed via accumulator
  tickAcc+=Sim.speed;
  while(tickAcc>=1){
    World.update();
    Underground.update();
    Mesh.update();
    updateAgents();
    Events.update();
    tickAcc-=1;
  }

  // presence layer runs at render rate so particles/audio stay smooth even
  // when the sim is paused or between fixed steps at high speed
  FX.update();
  MeshAudio.update();
  Renderer.draw();
  UI.update();
}

window.addEventListener('DOMContentLoaded',boot);
