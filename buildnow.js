/* --------------------------------------------------------------
   buildnow.js   –  single‑file prototype (server + client)

   What you need:
   • Node.js (v14+)
   • npm packages:  express  socket.io
   --------------------------------------------------------------
   Install & run:
   1️⃣ npm install express socket.io
   2️⃣ node buildnow.js
   3️⃣ Open http://localhost:3000 in one or more browsers
   --------------------------------------------------------------*/

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // the default path "/socket.io" works for the client script
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// ---------- WORLD STATE ----------
const world = {
  players : {},   // socket.id → {x,y,z,rotationY,health}
  builds  : []    // {id,type,x,y,z,rotY}
};
let nextBuildId = 1;
const ARENA_LIMIT = 50;   // ±50 units on each axis

function clamp(v) { return Math.max(-ARENA_LIMIT, Math.min(ARENA_LIMIT, v)); }

// ---------- SERVER LOGIC ----------
io.on('connection', socket => {
  console.log(`⚡ ${socket.id} connected`);

  // ----- spawn player -----
  const spawn = {
    x: (Math.random() - 0.5) * 30,
    y: 1,
    z: (Math.random() - 0.5) * 30,
    rotationY: 0,
    health: 100
  };
  world.players[socket.id] = spawn;

  // ----- send init data -----
  socket.emit('initState', {
    selfId   : socket.id,
    players   : world.players,
    builds    : world.builds
  });

  // ----- notify others -----
  socket.broadcast.emit('playerJoined', { id: socket.id, ...spawn });

  // ----- movement -----
  socket.on('move', data => {
    const p = world.players[socket.id];
    if (!p) return;
    p.x = clamp(data.x);
    p.y = clamp(data.y);
    p.z = clamp(data.z);
    p.rotationY = data.rotationY;
  });

  // ----- shooting (hitscan) -----
  socket.on('shoot', data => {
    const shooter = world.players[socket.id];
    if (!shooter) return;

    const {origin, direction} = data;
    const ray = {
      ox: origin.x, oy: origin.y, oz: origin.z,
      dx: direction.x, dy: direction.y, dz: direction.z
    };

    // simple sphere‑hit against every other player
    let hitId = null, closest = Infinity;
    for (const [id, pl] of Object.entries(world.players)) {
      if (id === socket.id) continue;
      const cx = pl.x, cy = pl.y + 0.5, cz = pl.z;   // player centre
      const r  = 0.5;                              // hit sphere radius
      const ocx = ray.ox - cx, ocy = ray.oy - cy, ocz = ray.oz - cz;
      const a = ray.dx*ray.dx + ray.dy*ray.dy + ray.dz*ray.dz;
      const b = 2 * (ocx*ray.dx + ocy*ray.dy + ocz*ray.dz);
      const c = ocx*ocx + ocy*ocy + ocz*ocz - r*r;
      const disc = b*b - 4*a*c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2*a);
      if (t > 0 && t < closest) {
        closest = t;
        hitId = id;
      }
    }

    if (hitId) {
      const victim = world.players[hitId];
      victim.health -= 20;
      if (victim.health <= 0) {
        // respawn victim at a new random spot
        victim.x = (Math.random() - 0.5) * 30;
        victim.y = 1;
        victim.z = (Math.random() - 0.5) * 30;
        victim.health = 100;
        io.to(hitId).emit('respawn', {
          x: victim.x, y: victim.y, z: victim.z
        });
      }
      // broadcast hit for HUD / FX
      io.emit('playerHit', { victimId: hitId, newHealth: victim.health });
    }
  });

  // ----- building placement -----
  socket.on('placeBuild', data => {
    const b = {
      id: nextBuildId++,
      ownerId: socket.id,
      type: data.type,   // "wall","floor","ramp","roof"
      x: clamp(data.x),
      y: clamp(data.y),
      z: clamp(data.z),
      rotY: data.rotY || 0
    };
    world.builds.push(b);
    io.emit('buildPlaced', b);
  });

  // ----- disconnect -----
  socket.on('disconnect', () => {
    console.log(`❌ ${socket.id} left`);
    delete world.players[socket.id];
    // optionally purge their builds
    world.builds = world.builds.filter(b => b.ownerId !== socket.id);
    io.emit('playerLeft', socket.id);
  });
});

// ----- broadcast world state (20 Hz) -----
setInterval(() => {
  io.emit('worldState', {
    players: world.players,
    builds : world.builds
  });
}, 1000 / 20);

// ---------- HTTP (serves the HTML page) ----------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>BuildNow GG – single‑file prototype</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body,html{margin:0;padding:0;overflow:hidden;background:#111;font-family:sans-serif;}
  #hud{position:absolute;top:10px;left:10px;color:#fff;text-shadow:0 0 3px #000;font-size:14px;z-index:10;}
  #healthBar{width:150px;height:12px;background:#444;border:1px solid #222;margin-bottom:6px;position:relative;}
  #healthFill{height:100%;background:#e00;width:100%;}
</style>
</head>
<body>
<div id="hud">
  <div id="healthBar"><div id="healthFill"></div></div>
  Weapon: <span id="weaponName">Pistol</span><br>
  Build: <span id="buildSelected">None</span>
</div>
<script src="https://cdn.jsdelivr.net/npm/three@0.152.0/build/three.min.js"></script>
<script src="/socket.io/socket.io.js"></script>
<script>
// ------------------------------------------------------------
//  CLIENT CODE – runs in the browser
// ------------------------------------------------------------
(() => {
  const socket = io();                         // socket.io client
  const BUILD_TYPES = { Q:'wall', C:'floor', V:'ramp', Shift:'roof' };
  const BUILD_COLORS = { wall:'#888', floor:'#777', ramp:'#666', roof:'#555' };
  const PLAYER_COLOR = '#00ff00';
  const OTHER_COLOR  = '#0077ff';
  const GRID_SIZE = 1;

  // ---------- HUD ----------
  const healthFill = document.getElementById('healthFill');
  const weaponName = document.getElementById('weaponName');
  const buildSelected = document.getElementById('buildSelected');
  let myHealth = 100;
  function setHealth(v) {
    myHealth = Math.max(0, Math.min(100, v));
    healthFill.style.width = (myHealth) + '%';
  }
  setHealth(100);
  weaponName.textContent = 'Pistol';
  function setBuild(name){ buildSelected.textContent = name || 'None'; }

  // ---------- THREE ----------
  const scene    = new THREE.Scene();
  scene.background = new THREE.Color(0x202020);
  const camera   = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.1, 500);
  const renderer = new THREE.WebGLRenderer({antialias:true});
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.appendChild(renderer.domElement);

  // Lights
  const amb = new THREE.AmbientLight(0xffffff,0.3);
  scene.add(amb);
  const dir = new THREE.DirectionalLight(0xffffff,0.8);
  dir.position.set(10,20,10);
  dir.castShadow = true;
  dir.shadow.mapSize.width = 1024;
  dir.shadow.mapSize.height = 1024;
  scene.add(dir);

  // Ground
  const groundGeo = new THREE.PlaneGeometry(200,200);
  const groundMat = new THREE.MeshStandardMaterial({color:0x555555});
  const ground = new THREE.Mesh(groundGeo,groundMat);
  ground.rotation.x = -Math.PI/2;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---------- STATE ----------
  const otherPlayers = {};   // socketId -> mesh
  const builds       = {};   // buildId -> mesh
  let myId           = null;
  let myMesh         = null;
  let myYaw          = 0;                // radians
  let velocityY      = 0;
  let wantJump       = false;
  let moveForward   = false, moveBackward = false;
  let moveLeft      = false, moveRight = false;
  let selectedBuild = null;                // string like 'wall'
  let previewMesh   = null;

  // ---------- INPUT ----------
  const canvas = renderer.domElement;
  canvas.tabIndex = 0; // make it focusable

  // pointer lock (desktop)
  canvas.addEventListener('click', () => {
    canvas.requestPointerLock = canvas.requestPointerLock ||
                                 canvas.mozRequestPointerLock;
    canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === canvas;
    // you could show UI hints here
  });

  // mouse look
  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement !== canvas) return;
    const sensitivity = 0.002;
    myYaw -= e.movementX * sensitivity;
    // keep within -π..π (optional)
    if (myYaw > Math.PI) myYaw -= 2*Math.PI;
    if (myYaw < -Math.PI) myYaw += 2*Math.PI;
  });

  // WASD
  window.addEventListener('keydown', e => {
    switch(e.code){
      case 'KeyW': case 'ArrowUp':    moveForward = true; break;
      case 'KeyS': case 'ArrowDown':  moveBackward = true; break;
      case 'KeyA': case 'ArrowLeft':  moveLeft = true; break;
      case 'KeyD': case 'ArrowRight': moveRight = true; break;
      case 'Space': wantJump = true; break;
      case 'KeyQ': case 'KeyC': case 'KeyV': case 'ShiftLeft': case 'ShiftRight':
        const type = BUILD_TYPES[e.code];
        if (type) { selectedBuild = type; setBuild(type); }
        break;
    }
  });
  window.addEventListener('keyup', e => {
    switch(e.code){
      case 'KeyW': case 'ArrowUp':    moveForward = false; break;
      case 'KeyS': case 'ArrowDown':  moveBackward = false; break;
      case 'KeyA': case 'ArrowLeft':  moveLeft = false; break;
      case 'KeyD': case 'ArrowRight': moveRight = false; break;
      case 'Space': wantJump = false; break;
    }
  });

  // left click = shoot, right click = place (if build selected)
  canvas.addEventListener('mousedown', e => {
    if (e.button === 0) { // left
      // ----- shoot -----
      const origin = new THREE.Vector3();
      const dir    = new THREE.Vector3();
      camera.getWorldPosition(origin);
      camera.getWorldDirection(dir);
      socket.emit('shoot', {
        origin: {x:origin.x, y:origin.y, z:origin.z},
        direction: {x:dir.x, y:dir.y, z:dir.z}
      });
    } else if (e.button === 2) { // right
      if (!selectedBuild) return;
      // cast to world to find placement point
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0,0), camera);
      const intersectObjs = [ground];
      // include already‑placed builds for snapping against them
      for (const b of Object.values(builds)) intersectObjs.push(b);
      const hits = ray.intersectObjects(intersectObjs, true);
      if (hits.length === 0) return;
      const pt = hits[0].point.clone();
      pt.x = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
      pt.y = Math.round(pt.y / GRID_SIZE) * GRID_SIZE;
      pt.z = Math.round(pt.z / GRID_SIZE) * GRID_SIZE;
      const rotY = Math.round(myYaw / (Math.PI/2)) * (Math.PI/2);
      socket.emit('placeBuild',{
        type: selectedBuild,
        x: pt.x, y: pt.y, z: pt.z,
        rotY
      });
    }
  });
  // suppress context menu on right‑click
  canvas.addEventListener('contextmenu', e=>e.preventDefault());

  // ---------- BUILD PREVIEW ----------
  function createPreview() {
    const geom = new THREE.BoxGeometry(1.8,1.8,1.8);
    const mat  = new THREE.MeshBasicMaterial({
      color:0xffffff,
      opacity:0.4,
      transparent:true,
      depthWrite:false
    });
    previewMesh = new THREE.Mesh(geom, mat);
    previewMesh.visible = false;
    scene.add(previewMesh);
  }
  createPreview();

  function updatePreview() {
    if (!selectedBuild) {
      previewMesh.visible = false;
      return;
    }
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0,0), camera);
    const intersectObjs = [ground];
    for (const b of Object.values(builds)) intersectObjs.push(b);
    const hits = ray.intersectObjects(intersectObjs, true);
    if (hits.length === 0) {
      previewMesh.visible = false;
      return;
    }
    const pt = hits[0].point.clone();
    pt.x = Math.round(pt.x / GRID_SIZE) * GRID_SIZE;
    pt.y = Math.round(pt.y / GRID_SIZE) * GRID_SIZE;
    pt.z = Math.round(pt.z / GRID_SIZE) * GRID_SIZE;
    previewMesh.position.copy(pt);
    previewMesh.visible = true;
  }

  // ---------- PLAYER & BUILD HANDLING ----------
  function addRemotePlayer(id, data){
    const geo = new THREE.BoxGeometry(1,2,1);
    const mat = new THREE.MeshStandardMaterial({color: OTHER_COLOR});
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(data.x, data.y, data.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    otherPlayers[id] = mesh;
  }

  function addMyPlayer(id, data){
    const geo = new THREE.BoxGeometry(1,2,1);
    const mat = new THREE.MeshStandardMaterial({color: PLAYER_COLOR});
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(data.x, data.y, data.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    myMesh = mesh;
    myId = id;
    setHealth(data.health);
  }

  function addBuild(build){
    if (builds[build.id]) return; // already created
    const size = 1.8;
    const geom = new THREE.BoxGeometry(size,size,size);
    const col = BUILD_COLORS[build.type] || '#777';
    const mat = new THREE.MeshStandardMaterial({color: col});
    const mesh = new THREE.Mesh(geom,mat);
    mesh.position.set(build.x, build.y, build.z);
    mesh.rotation.y = build.rotY || 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    builds[build.id] = mesh;
  }

  // ---------- SOCKET.IO LISTENERS ----------
  socket.on('initState', data => {
    myId = data.selfId;
    // create all players (including self)
    for (const [id, p] of Object.entries(data.players)){
      if (id === myId) addMyPlayer(id, p);
      else addRemotePlayer(id, p);
    }
    // create builds
    data.builds.forEach(addBuild);
  });

  socket.on('playerJoined', data => {
    if (data.id === myId) return;
    addRemotePlayer(data.id, data);
  });

  socket.on('playerLeft', id => {
    const m = otherPlayers[id];
    if (m){ scene.remove(m); delete otherPlayers[id]; }
  });

  socket.on('worldState', state => {
    // update positions of remote players
    for (const [id, p] of Object.entries(state.players)){
      if (id === myId) continue;
      if (!otherPlayers[id]){ addRemotePlayer(id, p); continue; }
      const mesh = otherPlayers[id];
      // simple lerp for smoothness
      mesh.position.lerp(new THREE.Vector3(p.x,p.y,p.z),0.2);
      mesh.rotation.y = THREE.MathUtils.lerpAngle(mesh.rotation.y, p.rotationY, 0.2);
    }

    // add any new builds
    state.builds.forEach(addBuild);
  });

  socket.on('playerHit', ({victimId, newHealth}) => {
    if (victimId === myId){
      setHealth(newHealth);
    }
  });

  socket.on('respawn', ({x,y,z}) => {
    if (myMesh){
      myMesh.position.set(x,y,z);
    }
  });

  socket.on('buildPlaced', build => {
    addBuild(build);
  });

  // ---------- ANIMATION LOOP ----------
  const clock = new THREE.Clock();

  function animate(){
    requestAnimationFrame(animate);
    const dt = clock.getDelta();

    // ----- movement (local player) -----
    if (myMesh){
      const speed = 8; // units/s
      const dir = new THREE.Vector3();
      if (moveForward)  dir.z -= 1;
      if (moveBackward) dir.z += 1;
      if (moveLeft)     dir.x -= 1;
      if (moveRight)    dir.x += 1;

      if (dir.lengthSq() > 0){
        dir.normalize();
        // rotate by current yaw
        const sin = Math.sin(myYaw), cos = Math.cos(myYaw);
        const dx = dir.x * cos - dir.z * sin;
        const dz = dir.x * sin + dir.z * cos;
        myMesh.position.x += dx * speed * dt;
        myMesh.position.z += dz * speed * dt;
      }

      // ----- jump + simple gravity -----
      if (wantJump && Math.abs(myMesh.position.y - 1) < 0.01){
        velocityY = 5;
      }
      velocityY -= 9.8 * dt; // gravity
      myMesh.position.y += velocityY * dt;
      if (myMesh.position.y < 1){
        myMesh.position.y = 1;
        velocityY = 0;
      }

      // ----- send movement to server -----
      socket.emit('move',{
        x: myMesh.position.x,
        y: myMesh.position.y,
        z: myMesh.position.z,
        rotationY: myYaw
      });

      // ----- camera follows -----
      const offset = new THREE.Vector3(0,5,-8);
      const quat = new THREE.Quaternion();
      quat.setFromEuler(new THREE.Euler(0, myYaw, 0));
      offset.applyQuaternion(quat);
      camera.position.copy(myMesh.position).add(offset);
      camera.lookAt(myMesh.position);
    }

    // ----- update preview mesh -----
    updatePreview();

    // ----- render -----
    renderer.render(scene, camera);
  }
  animate();

  // ---------- window resize ----------
  window.addEventListener('resize', () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w,h);
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
  });
})(); // end client IIFE
</script>
</body>
</html>`);
});

// ---------- START ----------
server.listen(PORT, () => console.log(`🚀 Server listening at http://localhost:${PORT}`));
