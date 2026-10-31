import { createClient } from '@supabase/supabase-js';
import { haversineMeters, parseTelemetry, toPoint } from './geo.js';

const $ = (id) => document.getElementById(id);
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
const MAX_PLAYERS = 40, CATCH_METERS = 15, MAX_ACCURACY = 40, HEAD_START_MS = 30_000, ROUND_MS = 600_000, STALE_MS = 20_000;
const savedId = localStorage.getItem('cz-player-id') || crypto.randomUUID();
localStorage.setItem('cz-player-id', savedId);
let myId = savedId, myName = 'Player', room = '', client = null, channel = null, myRole = 'spectator';
let roster = [], positions = new Map(), roundStartAt = null, roundNo = 0, result = null, watchId = null, lastFix = null;
let gameMode = '1v1', rolePrefs = new Map(), roleAssignments = new Map(), rolesLocked = false, setupVersion = 0, countdownUntil = null, gameStarted = false;
let map = null, markers = {}, accuracyCircle = null, soundOn = true, hapticsOn = true, audioCtx = null, toastTimer = null, tickTimer = null, lastResultKey = '', lastBroadcastAt = 0;
const roleNames = { runner: 'RUNNER', hunter: 'HUNTER', spectator: 'SPECTATOR' };
const MODE_INFO = { '1v1': { label:'1v1 CLASSIC', active:2 }, '1v2': { label:'1v2 DUO HUNT', active:3 }, '1v3': { label:'1v3 SQUAD HUNT', active:4 }, custom: { label:'CUSTOM', active:null } };
function activeLimit(){ return MODE_INFO[gameMode]?.active ?? null; }
function isActivePlayer(id){ return roleAssignments.get(id)==='runner' || roleAssignments.get(id)==='hunter'; }
function roleFor(player){ return roleAssignments.get(player.id) || 'spectator'; }
function validAssignments(assignments=roleAssignments){
  const vals=[...assignments.values()];
  const runners=vals.filter(r=>r==='runner').length, hunters=vals.filter(r=>r==='hunter').length;
  if(runners!==1 || hunters<1) return false;
  const limit=activeLimit();
  if(limit!==null && runners+hunters!==limit) return false;
  return true;
}
function defaultPrefs(){ for(const p of roster) if(!rolePrefs.has(p.id)) rolePrefs.set(p.id,'hunter'); }
function buildRandomAssignments(){
  const count=activeLimit() ?? Math.max(2,roster.length);
  const pool=roster.slice(0,count).sort(()=>Math.random()-.5);
  const next=new Map(); roster.forEach(p=>next.set(p.id,'spectator'));
  if(pool.length>=2){ next.set(pool[0].id,'runner'); pool.slice(1).forEach(p=>next.set(p.id,'hunter')); }
  return next;
}
function buildPreferenceAssignments(){
  const count=activeLimit() ?? roster.length;
  const candidates=roster.slice();
  const next=new Map(); roster.forEach(p=>next.set(p.id,'spectator'));
  let runner=candidates.find(p=>rolePrefs.get(p.id)==='runner');
  if(!runner) runner=candidates[0];
  if(runner) next.set(runner.id,'runner');
  const hunters=candidates.filter(p=>p.id!==runner?.id && rolePrefs.get(p.id)==='hunter');
  const fallback=candidates.filter(p=>p.id!==runner?.id && !hunters.some(h=>h.id===p.id));
  const chosen=[...hunters,...fallback].slice(0,Math.max(1,count-1));
  chosen.forEach(p=>next.set(p.id,'hunter'));
  return next;
}
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2800); }
function notify(message) { toast(message); if (hapticsOn && navigator.vibrate) navigator.vibrate([70,40,70]); if (soundOn) beep(); }
function beep(freq=660) { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.connect(g);g.connect(audioCtx.destination);o.frequency.value=freq;g.gain.setValueAtTime(.06,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(.001,audioCtx.currentTime+.22);o.start();o.stop(audioCtx.currentTime+.23); } catch {} }
function setConnection(label, online=false) { $('connection').innerHTML = `<i></i> ${label}`; $('connection').classList.toggle('online', online); }
function initMap() { if(map || !window.L) return; map=L.map('map',{zoomControl:false}).setView([20.5937,78.9629],5); L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map); L.control.zoom({position:'bottomright'}).addTo(map); }
function setView(inGame) { $('lobby').classList.toggle('hidden',inGame); $('game').classList.toggle('hidden',!inGame); if(inGame){initMap();setTimeout(()=>map?.invalidateSize(),100);} }
function randomRoom() { return Math.random().toString(36).slice(2,8).toUpperCase(); }
function roomFromUrl() { return new URL(location.href).searchParams.get('room')?.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8) || ''; }
$('roomCode').value = roomFromUrl();
$('newRoomBtn').addEventListener('click',()=>{ $('roomCode').value=randomRoom(); });
function presenceRows() {
  if (!channel) return [];
  const state = channel.presenceState();
  return Object.values(state).flat().filter(p=>p?.id).sort((a,b)=>(a.joinedAt||0)-(b.joinedAt||0)||String(a.id).localeCompare(String(b.id))).slice(0,MAX_PLAYERS);
}
function refreshRoster() {
  roster=presenceRows();
  for(const [id] of positions) if(!roster.some(p=>p.id===id)) positions.delete(id);
  defaultPrefs();
  for(const id of [...rolePrefs.keys()]) if(!roster.some(p=>p.id===id)) rolePrefs.delete(id);
  for(const id of [...roleAssignments.keys()]) if(!roster.some(p=>p.id===id)) roleAssignments.delete(id);
  if(!rolesLocked && isHost()) broadcastSetup();
  myRole=roleFor({id:myId});
  if(myRole==='spectator' && watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;lastFix=null;$('gpsStatus').textContent='GPS: SPECTATOR';}
  else if(myRole!=='spectator' && watchId===null && rolesLocked) startGPS();
  render();
  maybeStartRound();
}
function currentPair() {
  const runner=roster.find(p=>roleFor(p)==='runner');
  const hunters=roster.filter(p=>roleFor(p)==='hunter');
  const rf=runner?positions.get(runner.id):null;
  const hunterFixes=hunters.map(h=>({hunter:h,fix:positions.get(h.id)})).filter(x=>reliableFix(x.fix));
  let nearest=null;
  if(reliableFix(rf)){
    for(const item of hunterFixes){
      const d=haversineMeters(toPoint(rf.lat,rf.lng),toPoint(item.fix.lat,item.fix.lng));
      if(!nearest || d<nearest.distanceM) nearest={...item,distanceM:d};
    }
  }
  return {runner,hunters,rf,hf:nearest?.fix||null,nearestHunter:nearest?.hunter||null};
}
function reliableFix(f) { return f && Date.now()-f.receivedAt<STALE_MS && f.accuracy<=MAX_ACCURACY; }
function proximity() {
  const {rf,hf,nearestHunter}=currentPair();
  if(!reliableFix(rf)||!reliableFix(hf)) return null;
  return {distanceM:haversineMeters(toPoint(rf.lat,rf.lng),toPoint(hf.lat,hf.lng)),reliable:true,hunterId:nearestHunter?.id||null};
}
function isHost() { return roster[0]?.id===myId; }
async function sendBroadcast(event,payload) { if(channel) await channel.send({type:'broadcast',event,payload}); }
async function maybeStartRound() {
  if(!isHost() || !rolesLocked || !validAssignments() || roundStartAt || result || countdownUntil || roster.length<2) return;
  const prox=proximity();
  if(prox?.reliable) {
    const at=Date.now()+3200;
    countdownUntil=at;
    await sendBroadcast('round',{kind:'countdown',at,roundNo,roles:Object.fromEntries(roleAssignments)});
    toast('Roles locked. Game starts in 3 seconds!');
    render();
    setTimeout(()=>{ if(countdownUntil===at && !roundStartAt && !result){ countdownUntil=null; roundStartAt=at; gameStarted=true; sendBroadcast('round',{kind:'start',at,roundNo}); render(); } },3200);
  }
}
function finishRound(winner,reason) {
  if(result || !roundStartAt) return;
  result={winner,reason};
  if(isHost()) sendBroadcast('round',{kind:'finish',winner,reason,roundNo});
  render(); showResult();
}
function evaluateRound() {
  if(!roundStartAt || result) return;
  const now=Date.now(), prox=proximity();
  if(now>=roundStartAt+HEAD_START_MS && prox?.distanceM<=CATCH_METERS) finishRound('hunter','caught');
  else if(now>=roundStartAt+ROUND_MS) finishRound('runner','time');
}
async function broadcastSetup(){
  if(!channel || !isHost()) return;
  setupVersion++;
  await sendBroadcast('setup',{version:setupVersion,mode:gameMode,locked:rolesLocked,prefs:Object.fromEntries(rolePrefs),roles:Object.fromEntries(roleAssignments)});
}
async function setMode(mode){
  if(!isHost() || rolesLocked) return;
  gameMode=MODE_INFO[mode]?mode:'1v1';
  roleAssignments=new Map();
  defaultPrefs();
  await broadcastSetup();
  render();
}
async function choosePreference(role){
  if(rolesLocked) return;
  rolePrefs.set(myId,role);
  await broadcastSetup();
  toast(`Your preference: ${roleNames[role]}`);
  render();
}
async function hostAssign(id,role){
  if(!isHost() || rolesLocked || !roster.some(p=>p.id===id)) return;
  const next=new Map(roleAssignments); next.set(id,role);
  if(role==='runner') for(const [pid,r] of next) if(pid!==id && r==='runner') next.set(pid,'spectator');
  roleAssignments=next;
  await broadcastSetup(); render();
}
async function randomRoles(){
  if(!isHost() || rolesLocked) return;
  roleAssignments=buildRandomAssignments();
  await broadcastSetup(); render();
}
async function confirmRoles(){
  if(!isHost() || rolesLocked) return;
  let next=roleAssignments;
  if(!validAssignments(next)) next=buildPreferenceAssignments();
  if(!validAssignments(next)) return toast('Need exactly 1 Runner and the required number of Hunters.');
  roleAssignments=next;
  rolesLocked=true;
  await broadcastSetup();
  myRole=roleFor({id:myId});
  if(myRole!=='spectator' && watchId===null) startGPS();
  toast('Roles locked. Waiting for accurate GPS fixes…');
  render();
}
async function startGameNow(){
  if(!isHost() || !rolesLocked) return toast('Lock the roles first.');
  if(!validAssignments()) return toast('Invalid roles. Set exactly 1 Runner and enough Hunters.');
  const active=roster.filter(p=>isActivePlayer(p.id));
  if(active.length<2) return toast('Need at least 2 active players.');
  const allReady=active.every(p=>reliableFix(positions.get(p.id)));
  if(!allReady) return toast('Waiting for fresh GPS from every Hunter/Runner.');
  maybeStartRound();
}
async function join() {
  if(!CONFIGURED) { toast('Add your Supabase URL and anon key in Vercel environment variables first.'); return; }
  myName=$('playerName').value.trim().replace(/[<>\u0000-\u001f]/g,'').slice(0,16)||'Player';
  room=($('roomCode').value.trim().toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,8)||'PUBLIC');
  $('joinBtn').disabled=true; setConnection('CONNECTING');
  try {
    client=createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{realtime:{params:{eventsPerSecond:10}}});
    channel=client.channel(`chaser-zone:${room}`,{config:{presence:{key:myId},broadcast:{self:false}}});
    channel.on('presence',{event:'sync'},refreshRoster);
    channel.on('broadcast',{event:'position'},({payload})=>{ if(payload?.id && payload.id!==myId && roster.some(p=>p.id===payload.id)) { positions.set(payload.id,{...payload,receivedAt:Date.now()}); render(); evaluateRound(); maybeStartRound(); } });
    channel.on('broadcast',{event:'setup'},({payload})=>{
      if(!payload || payload.version < setupVersion) return;
      setupVersion=payload.version;
      gameMode=payload.mode || '1v1';
      rolesLocked=Boolean(payload.locked);
      rolePrefs=new Map(Object.entries(payload.prefs||{}));
      roleAssignments=new Map(Object.entries(payload.roles||{}));
      myRole=roleFor({id:myId});
      if(rolesLocked && myRole!=='spectator' && watchId===null) startGPS();
      render();
    });
    channel.on('broadcast',{event:'round'},({payload})=>{
      if(payload?.kind==='countdown' && payload.roundNo===roundNo){
        countdownUntil=payload.at; if(payload.roles) roleAssignments=new Map(Object.entries(payload.roles));
        rolesLocked=true; myRole=roleFor({id:myId}); if(myRole!=='spectator' && watchId===null) startGPS(); toast('3… 2… 1…'); render();
      }
      if(payload?.kind==='start' && payload.roundNo===roundNo && !roundStartAt){roundStartAt=payload.at;countdownUntil=null;gameStarted=true;toast('GO! Runner has a 30-second head start.');}
      if(payload?.kind==='finish' && payload.roundNo===roundNo && !result){result={winner:payload.winner,reason:payload.reason};showResult();}
      if(payload?.kind==='rematch' && payload.roundNo>roundNo){roundNo=payload.roundNo;roundStartAt=null;countdownUntil=null;gameStarted=false;result=null;lastResultKey='';positions.clear();$('resultModal').classList.add('hidden');rolesLocked=false;roleAssignments=new Map();toast('Rematch: choose roles again.');}
      render();
    });
    channel.subscribe(async status=>{
      if(status==='SUBSCRIBED') {
        setConnection('CONNECTED',true);
        const tracked=await channel.track({id:myId,name:myName,joinedAt:Date.now()});
        if(tracked.error) throw tracked.error;
        $('activeRoom').textContent=room; $('roomCode').value=room; setView(true); initMap();
        history.replaceState({},'',`${location.pathname}?room=${room}`);
        toast('You joined room '+room+'. Active players will be asked for GPS.'); refreshRoster();
      } else if(status==='CHANNEL_ERROR'||status==='TIMED_OUT') {setConnection('CONNECTION ERROR');toast('Realtime connection failed. Check Supabase settings and try again.');$('joinBtn').disabled=false;}
    });
  } catch(err) { console.error(err); toast(err.message||'Could not join room.'); setConnection('OFFLINE'); $('joinBtn').disabled=false; }
}
function startGPS() {
  if(!('geolocation' in navigator)){ $('gpsStatus').textContent='GPS: UNSUPPORTED';$('mapNotice').textContent='This browser does not support GPS.';return; }
  if(!window.isSecureContext){$('gpsStatus').textContent='GPS: NEED HTTPS';$('mapNotice').textContent='GPS requires HTTPS. Deploy to Vercel to play.';return;}
  $('gpsStatus').textContent='GPS: REQUESTING'; $('mapNotice').textContent='Waiting for location permission…';
  if(watchId!==null)navigator.geolocation.clearWatch(watchId);
  watchId=navigator.geolocation.watchPosition(async pos=>{
    const c=pos.coords; const parsed=parseTelemetry({lat:c.latitude,lng:c.longitude,accuracy:c.accuracy,ageMs:Math.max(0,Date.now()-pos.timestamp)});
    if(!parsed)return;
    lastFix={lat:c.latitude,lng:c.longitude,accuracy:c.accuracy,receivedAt:Date.now()};
    if(myRole!=='spectator' && channel && Date.now()-lastBroadcastAt>350){lastBroadcastAt=Date.now();positions.set(myId,lastFix);await sendBroadcast('position',{id:myId,...lastFix});}
    $('gpsStatus').textContent=`GPS: ±${Math.round(c.accuracy)}M`; $('mapNotice').classList.add('hidden');
    if(map&&!markers.me)map.setView([c.latitude,c.longitude],16);
    if(map){if(!accuracyCircle)accuracyCircle=L.circle([c.latitude,c.longitude],{radius:Math.max(5,c.accuracy),color:'#c6ff4d',fillOpacity:.06,weight:1}).addTo(map);else accuracyCircle.setLatLng([c.latitude,c.longitude]).setRadius(Math.max(5,c.accuracy));}
    render(); maybeStartRound(); evaluateRound();
  },err=>{const msg=err.code===1?'Location permission denied. Enable it in browser settings.':err.code===2?'GPS position unavailable. Move outdoors and retry.':'GPS timed out. Keep location enabled.';$('gpsStatus').textContent='GPS: ERROR';$('mapNotice').textContent=msg;toast(msg);},{enableHighAccuracy:true,maximumAge:1200,timeout:15000});
}
function markerIcon(role) { return L.divIcon({className:'',html:`<div class="player-pin ${role}-pin"></div>`,iconSize:[16,16],iconAnchor:[8,8]}); }
function renderPlayers() {
  $('playerCount').textContent=`${roster.length} / ${MAX_PLAYERS}`;
  $('playersList').innerHTML=roster.length?roster.map(p=>{const role=roleFor(p);return `<div class="player-row"><div class="player-avatar ${role}">${escapeHtml((p.name||'?').slice(0,1).toUpperCase())}</div><div class="player-meta">${escapeHtml(p.name||'Player')}${p.id===myId?' (YOU)':''}<small>${roleNames[role]}</small></div><span class="player-status">● ONLINE</span></div>`;}).join(''):'<p class="empty">Waiting for players...</p>';
}
function renderMap() {
  if(!map)return;
  const live=[];
  for(const p of roster){const f=positions.get(p.id);if(!f||Date.now()-f.receivedAt>STALE_MS)continue;const ll=[f.lat,f.lng];live.push(ll);if(!markers[p.id])markers[p.id]=L.marker(ll,{icon:markerIcon(roleFor(p))}).addTo(map);else markers[p.id].setLatLng(ll).setIcon(markerIcon(roleFor(p)));markers[p.id].bindTooltip(`${escapeHtml(p.name)} · ${roleNames[roleFor(p)]}`,{direction:'top'});}
  for(const id of Object.keys(markers)){if(!positions.has(id)||!roster.some(p=>p.id===id)){map.removeLayer(markers[id]);delete markers[id];}}
  if(live.length>1)map.fitBounds(L.latLngBounds(live).pad(.35),{maxZoom:17});
}
function renderRoleSetup(){
  const panel=$('roleSetup'); if(!panel) return;
  const host=isHost(), locked=rolesLocked, limit=activeLimit();
  $('modeSelect').value=gameMode;
  $('setupStatus').textContent=locked ? 'ROLES LOCKED · GET READY' : (host ? 'HOST CONTROLS · CHOOSE ROLES' : 'CHOOSE YOUR PREFERENCE');
  $('modeSelect').disabled=!host||locked;
  $('randomRolesBtn').disabled=!host||locked;
  $('lockRolesBtn').disabled=!host||locked;
  $('startGameBtn').disabled=!host||!locked||Boolean(roundStartAt)||Boolean(result);
  $('setupModeHint').textContent=gameMode==='custom' ? 'Custom: host can assign any number of Hunters, but exactly 1 Runner.' : `${MODE_INFO[gameMode].label}: exactly 1 Runner + ${MODE_INFO[gameMode].active-1} Hunter${MODE_INFO[gameMode].active-1===1?'':'s'}. Extra players stay Spectator.`;
  const pref=rolePrefs.get(myId)||'hunter';
  document.querySelectorAll('[data-pref]').forEach(b=>b.classList.toggle('active',b.dataset.pref===pref));
  const list=$('roleSetupList');
  list.innerHTML=roster.map(p=>{
    const assigned=roleAssignments.get(p.id)||'spectator';
    const buttons=host&&!locked ? `<div class="role-assign"><button data-assign="${p.id}" data-role="runner" class="${assigned==='runner'?'selected runner':''}">RUNNER</button><button data-assign="${p.id}" data-role="hunter" class="${assigned==='hunter'?'selected hunter':''}">HUNTER</button><button data-assign="${p.id}" data-role="spectator" class="${assigned==='spectator'?'selected':''}">SPECTATE</button></div>` : `<span class="assigned-role ${assigned}">${roleNames[assigned]}</span>`;
    return `<div class="setup-player"><span><b>${escapeHtml(p.name)}</b>${p.id===myId?' · YOU':''}<small>${p.id===roster[0]?.id?'HOST':''}</small></span>${buttons}</div>`;
  }).join('') || '<p class="empty">Waiting for players…</p>';
  panel.classList.toggle('hidden', Boolean(roundStartAt)||Boolean(result));
}
function render() {
  const role=roleFor({id:myId}); myRole=role;
  $('myRole').textContent=roleNames[role];$('roleIcon').textContent=role==='runner'?'↗':role==='hunter'?'⌖':'◎';$('roleBanner').className=`role-banner ${role}`;
  $('roleHint').textContent=role==='runner'?'You have the head start. Stay mobile and avoid the Hunter.':role==='hunter'?'Track the Runner and close the distance to catch them.':'Watch the chase live. Your GPS location is never shared as a spectator.';
  $('objectiveTitle').textContent=role==='runner'?'STAY OUT OF REACH':role==='hunter'?'CATCH THE RUNNER':'WATCH THE HUNT';
  $('objectiveText').textContent=role==='runner'?'Use the head start to create distance. Keep moving in safe, public areas.':role==='hunter'?'Use the live map and distance meter to find the Runner. Catch range is '+CATCH_METERS+' metres.':'Choose a role preference in the lobby. The host locks the final Runner/Hunter lineup before the game starts.';
  renderRoleSetup(); renderPlayers();renderMap();
  const prox=proximity();
  if(prox){$('distance').innerHTML=`${Math.round(prox.distanceM)} <small>m</small>`;$('distanceHint').textContent='Live GPS estimate · catch range '+CATCH_METERS+'m';$('radar').classList.add('active');}
  else{$('distance').innerHTML='— <small>m</small>';$('distanceHint').textContent='Waiting for both players to share fresh, accurate GPS';$('radar').classList.remove('active');}
  const now=Date.now(),remaining=roundStartAt?Math.max(0,ROUND_MS-(now-roundStartAt)):ROUND_MS,sec=Math.ceil(remaining/1000);
  $('timer').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;$('timerBar').style.width=`${Math.max(0,Math.min(100,remaining/ROUND_MS*100))}%`;
  $('phaseText').textContent=result?'ROUND COMPLETE':countdownUntil?`STARTING IN ${Math.max(1,Math.ceil((countdownUntil-now)/1000))}`:!rolesLocked?'ROLE SELECTION':!roundStartAt?'WAITING FOR BOTH GPS FIXES':now<roundStartAt+HEAD_START_MS?'RUNNER HEAD START':'ROUND IN PROGRESS';
  $('rematchBtn').classList.toggle('hidden',!result||!['runner','hunter'].includes(role));
}
function showResult() {
  if(!result)return;const key=result.winner+':'+result.reason;if(key===lastResultKey)return;lastResultKey=key;
  $('resultIcon').textContent=result.winner==='runner'?'✦':'⌖';$('resultTitle').textContent=result.winner==='runner'?'RUNNER ESCAPED':'HUNTER CAUGHT THE RUNNER';$('resultText').textContent=result.reason==='caught'?'The Hunter closed the gap and made the catch.':'Time ran out. The Runner survived the round.';$('resultModal').classList.remove('hidden');if(soundOn)beep(result.winner==='runner'?880:260);
}
async function doRematch() {
  if(!result||!['runner','hunter'].includes(myRole))return toast('Only the Runner or Hunter can request a rematch.');
  const next=roundNo+1;roundNo=next;roundStartAt=null;result=null;lastResultKey='';positions.clear();$('resultModal').classList.add('hidden');
  await sendBroadcast('round',{kind:'rematch',roundNo:next});render();toast('Roles swapped. Get ready for the next round.');
}
async function leaveArena() {
  if(watchId!==null)navigator.geolocation.clearWatch(watchId);watchId=null;clearInterval(tickTimer);tickTimer=null;
  try{await channel?.untrack();await client?.removeChannel(channel);}catch{}
  channel=null;client=null;positions.clear();roster=[];roundStartAt=null;countdownUntil=null;gameStarted=false;result=null;room='';myRole='spectator';rolesLocked=false;roleAssignments=new Map();rolePrefs=new Map();setupVersion=0;localStorage.removeItem('cz-player-id');myId=crypto.randomUUID();localStorage.setItem('cz-player-id',myId);
  $('resultModal').classList.add('hidden');$('joinBtn').disabled=false;setConnection('DISCONNECTED');setView(false);history.replaceState({},'',location.pathname);
}
$('joinBtn').addEventListener('click',join);$('playerName').addEventListener('keydown',e=>{if(e.key==='Enter')join();});$('leaveBtn').addEventListener('click',leaveArena);$('rematchBtn').addEventListener('click',doRematch);$('resultRematch').addEventListener('click',doRematch);$('closeResult').addEventListener('click',()=>$('resultModal').classList.add('hidden'));
$('shareBtn').addEventListener('click',async()=>{const url=`${location.origin}${location.pathname}?room=${room}`;try{await navigator.clipboard.writeText(url);toast('Invite link copied!');}catch{toast(url);}});
$('soundToggle').addEventListener('click',()=>{soundOn=!soundOn;$('soundToggle').classList.toggle('active',soundOn);$('soundToggle').textContent=soundOn?'♫':'♪';toast(`Sound ${soundOn?'on':'off'}`);});
$('vibrateToggle').addEventListener('click',()=>{hapticsOn=!hapticsOn;$('vibrateToggle').classList.toggle('active',hapticsOn);$('vibrateToggle').textContent=hapticsOn?'▥ HAPTICS ON':'▥ HAPTICS OFF';});
$('locateBtn').addEventListener('click',()=>{if(lastFix&&map)map.setView([lastFix.lat,lastFix.lng],17);else toast('Waiting for your GPS location.');});
$('fullscreenBtn').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch{toast('Fullscreen is not supported here.');}});
$('modeSelect')?.addEventListener('change',e=>setMode(e.target.value));
document.querySelectorAll('[data-pref]').forEach(b=>b.addEventListener('click',()=>choosePreference(b.dataset.pref)));
$('randomRolesBtn')?.addEventListener('click',randomRoles);
$('lockRolesBtn')?.addEventListener('click',confirmRoles);
$('startGameBtn')?.addEventListener('click',startGameNow);
$('roleSetupList')?.addEventListener('click',e=>{const b=e.target.closest('[data-assign]');if(b)hostAssign(b.dataset.assign,b.dataset.role);});
if(CONFIGURED)$('setupNotice').classList.add('hidden');else setConnection('SETUP REQUIRED');
tickTimer=setInterval(()=>{if(countdownUntil && Date.now()>=countdownUntil){countdownUntil=null;render();} if(roundStartAt){evaluateRound();render();} else if(countdownUntil) render();},250);
if('serviceWorker' in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
