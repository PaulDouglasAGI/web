/* main.js — boot, tick engine, render loop. The world runs itself forever. */
'use strict';

const Sim={ running:true, speed:1 };

function boot(){
  World.init();
  Mesh.reset();
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

let acc=0;
function loop(){
  requestAnimationFrame(loop);

  // fixed-step simulation (decoupled from render)
  const steps=Sim.speed;
  for(let s=0;s<steps;s++){
    World.update();
    Mesh.update();
    updateAgents();
    Events.update();
  }

  Renderer.draw();
  UI.update();
}

window.addEventListener('DOMContentLoaded',boot);
