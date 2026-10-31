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
let map = null, markers = {}, accuracyCircle = null, soundOn = true, hapticsOn = true, audioCtx = null, toastTimer = null, tickTimer = null, lastResultKey = '', lastBroadcastAt = 0;
const roleNames = { runner: 'RUNNER', hunter: 'HUNTER', spectator: 'SPECTATOR' };
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
function roleFor(player, rows=roster, n=roundNo) {
  const index=rows.findIndex(p=>p.id===player.id);
  if(index!==0 && index!==1) return 'spectator';
  const first=(n%2===0?'runner':'hunter');
  return index===0?first:(first==='runner'?'hunter':'runner');
}
function refreshRoster() {
  roster=presenceRows();
  for(const [id] of positions) if(!roster.some(p=>p.id===id)) positions.delete(id);
  myRole=roleFor({id:myId});
  if(myRole==='spectator' && watchId!==null){navigator.geolocation.clearWatch(watchId);watchId=null;lastFix=null;$('gpsStatus').textContent='GPS: SPECTATOR';}
  else if(myRole!=='spectator' && watchId===null) startGPS();
  render();
  maybeStartRound();
}
function currentPair() {
  const runner=roster.find(p=>roleFor(p)==='runner'), hunter=roster.find(p=>roleFor(p)==='hunter');
  return {runner,hunter,rf:runner?positions.get(runner.id):null,hf:hunter?positions.get(hunter.id):null};
}
function reliableFix(f) { return f && Date.now()-f.receivedAt<STALE_MS && f.accuracy<=MAX_ACCURACY; }
function proximity() {
  const {rf,hf}=currentPair();
  if(!reliableFix(rf)||!reliableFix(hf)) return null;
  return {distanceM:haversineMeters(toPoint(rf.lat,rf.lng),toPoint(hf.lat,hf.lng)),reliable:true};
}
function isHost() { return roster[0]?.id===myId; }
async function sendBroadcast(event,payload) { if(channel) await channel.send({type:'broadcast',event,payload}); }
async function maybeStartRound() {
  if(!isHost() || roundStartAt || result || roster.length<2) return;
  const prox=proximity();
  if(prox?.reliable) {
    const at=Date.now(); roundStartAt=at;
    await sendBroadcast('round',{kind:'start',at,roundNo});
    toast('Round started! Runner has a 30-second head start.'); render();
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
    channel.on('broadcast',{event:'round'},({payload})=>{
      if(payload?.kind==='start' && payload.roundNo===roundNo && !roundStartAt){roundStartAt=payload.at;toast('Round started! Runner has a 30-second head start.');}
      if(payload?.kind==='finish' && payload.roundNo===roundNo && !result){result={winner:payload.winner,reason:payload.reason};showResult();}
      if(payload?.kind==='rematch' && payload.roundNo>roundNo){roundNo=payload.roundNo;roundStartAt=null;result=null;lastResultKey='';positions.clear();$('resultModal').classList.add('hidden');toast('Rematch started. Roles swapped.');}
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
function render() {
  const role=roleFor({id:myId}); myRole=role;
  $('myRole').textContent=roleNames[role];$('roleIcon').textContent=role==='runner'?'↗':role==='hunter'?'⌖':'◎';$('roleBanner').className=`role-banner ${role}`;
  $('roleHint').textContent=role==='runner'?'You have the head start. Stay mobile and avoid the Hunter.':role==='hunter'?'Track the Runner and close the distance to catch them.':'Watch the chase live. Your GPS location is never shared as a spectator.';
  $('objectiveTitle').textContent=role==='runner'?'STAY OUT OF REACH':role==='hunter'?'CATCH THE RUNNER':'WATCH THE HUNT';
  $('objectiveText').textContent=role==='runner'?'Use the head start to create distance. Keep moving in safe, public areas.':role==='hunter'?'Use the live map and distance meter to find the Runner. Catch range is '+CATCH_METERS+' metres.':'The first two players become Runner and Hunter. Join the game to take a role.';
  renderPlayers();renderMap();
  const prox=proximity();
  if(prox){$('distance').innerHTML=`${Math.round(prox.distanceM)} <small>m</small>`;$('distanceHint').textContent='Live GPS estimate · catch range '+CATCH_METERS+'m';$('radar').classList.add('active');}
  else{$('distance').innerHTML='— <small>m</small>';$('distanceHint').textContent='Waiting for both players to share fresh, accurate GPS';$('radar').classList.remove('active');}
  const now=Date.now(),remaining=roundStartAt?Math.max(0,ROUND_MS-(now-roundStartAt)):ROUND_MS,sec=Math.ceil(remaining/1000);
  $('timer').textContent=`${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;$('timerBar').style.width=`${Math.max(0,Math.min(100,remaining/ROUND_MS*100))}%`;
  $('phaseText').textContent=result?'ROUND COMPLETE':!roundStartAt?'WAITING FOR BOTH GPS FIXES':now<roundStartAt+HEAD_START_MS?'RUNNER HEAD START':'ROUND IN PROGRESS';
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
  channel=null;client=null;positions.clear();roster=[];roundStartAt=null;result=null;room='';myRole='spectator';localStorage.removeItem('cz-player-id');myId=crypto.randomUUID();localStorage.setItem('cz-player-id',myId);
  $('resultModal').classList.add('hidden');$('joinBtn').disabled=false;setConnection('DISCONNECTED');setView(false);history.replaceState({},'',location.pathname);
}
$('joinBtn').addEventListener('click',join);$('playerName').addEventListener('keydown',e=>{if(e.key==='Enter')join();});$('leaveBtn').addEventListener('click',leaveArena);$('rematchBtn').addEventListener('click',doRematch);$('resultRematch').addEventListener('click',doRematch);$('closeResult').addEventListener('click',()=>$('resultModal').classList.add('hidden'));
$('shareBtn').addEventListener('click',async()=>{const url=`${location.origin}${location.pathname}?room=${room}`;try{await navigator.clipboard.writeText(url);toast('Invite link copied!');}catch{toast(url);}});
$('soundToggle').addEventListener('click',()=>{soundOn=!soundOn;$('soundToggle').classList.toggle('active',soundOn);$('soundToggle').textContent=soundOn?'♫':'♪';toast(`Sound ${soundOn?'on':'off'}`);});
$('vibrateToggle').addEventListener('click',()=>{hapticsOn=!hapticsOn;$('vibrateToggle').classList.toggle('active',hapticsOn);$('vibrateToggle').textContent=hapticsOn?'▥ HAPTICS ON':'▥ HAPTICS OFF';});
$('locateBtn').addEventListener('click',()=>{if(lastFix&&map)map.setView([lastFix.lat,lastFix.lng],17);else toast('Waiting for your GPS location.');});
$('fullscreenBtn').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch{toast('Fullscreen is not supported here.');}});
if(CONFIGURED)$('setupNotice').classList.add('hidden');else setConnection('SETUP REQUIRED');
tickTimer=setInterval(()=>{if(roundStartAt){evaluateRound();render();}},1000);
if('serviceWorker' in navigator && location.protocol==='https:')navigator.serviceWorker.register('/sw.js').catch(()=>{});
