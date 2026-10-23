const $=id=>document.getElementById(id);
const PHONE='<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>';
const TABLET='<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M11 18h2"/></svg>';
const LAPTOP='<svg viewBox="0 0 24 24"><rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 18.5h19"/></svg>';
const DESKTOP='<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>';
const ICONS={iphone:PHONE,android:PHONE,ipad:TABLET,mac:LAPTOP,pc:DESKTOP};
let state={devices:[],clips:[],received:[],sent:[]};
// Concentric rings fanning out from the bottom centre (SVG so lines stay crisp)
(function(){
  const svg=$('rings'),NS='http://www.w3.org/2000/svg';
  const cx=innerWidth/2,cy=innerHeight-62,far=Math.hypot(innerWidth,innerHeight);
  const mk=(r,attrs)=>{const c=document.createElementNS(NS,'circle');c.setAttribute('cx',cx);c.setAttribute('cy',cy);c.setAttribute('r',r);
    for(const k in attrs)c.setAttribute(k,attrs[k]);svg.append(c);return c};
  for(let k=1;k*170<far+170;k++){
    const c=mk(k*170,{stroke:'#fff','stroke-width':1,'stroke-opacity':.1});
    c.animate([{strokeOpacity:.07},{strokeOpacity:.22},{strokeOpacity:.07}],{duration:5000,iterations:Infinity,delay:-k*350})}
  for(let k=0;k<3;k++){
    const w=mk(10,{stroke:'#4285f4','stroke-width':1.5,'stroke-opacity':0});
    w.animate([{r:'10px',strokeOpacity:.85},{r:far+'px',strokeOpacity:0}],
      {duration:6000,iterations:Infinity,delay:-k*2000,easing:'cubic-bezier(.2,.5,.4,1)'})}
})();
function show(i){
  $('qr').src=i.qr;$('qr2').src=i.qr;$('url').textContent=i.url;$('url2').textContent=i.url;
  $('ips').textContent=i.ips.length?'or '+i.ips.join(' · '):'';
  $('dir').textContent='Saving to: '+i.saveDir;$('pcname').textContent=i.pc}
api.info().then(show);
$('open').onclick=()=>api.openFolder();
$('change').onclick=()=>api.chooseFolder().then(show);
let pinned=false;
$('pin').onclick=()=>{pinned=!pinned;api.setPinned(pinned);$('pin').textContent=pinned?'Unpin':'Pin'};
$('showConn').onclick=()=>api.info().then(i=>{show(i);$('conn').style.display='flex'});
$('closeConn').onclick=()=>$('conn').style.display='none';
$('pause').onclick=()=>api.setPaused(!state.paused);

// Thumbnails come from the OS thumbnailer in the main process; blank if not an image
function thumb(path,size,img){api.thumb(path,size).then(u=>{if(u)img.src=u;else img.classList.add('blank')})}
function row(name,right,path){const li=document.createElement('li');
  li.innerHTML='<span class="l"><img class="th blank"><span class="nm"></span></span><span></span>';
  li.querySelector('.nm').textContent=name;li.lastChild.textContent=right;
  if(path){const im=li.querySelector('.th');im.classList.remove('blank');thumb(path,68,im)}
  return li}
async function openLightbox(f){
  const u=await api.thumb(f.path,1600);if(!u){api.showFile(f.path);return}
  $('lbimg').src=u;$('lbname').textContent=f.name;$('lb').style.display='flex';
  $('lbshow').onclick=()=>api.showFile(f.path)}
$('lbclose').onclick=()=>$('lb').style.display='none';
$('lb').onclick=e=>{if(e.target.id==='lb')$('lb').style.display='none'};
addEventListener('keydown',e=>{if(e.key!=='Escape')return;
  for(const id of ['lb','settings','conn'])if($(id).style.display==='flex'){if(id!=='settings'||state.configured)$(id).style.display='none';return}
  api.hide()});
const mb=n=>n>1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
const hint=(t,warn)=>{$('hint').textContent=t;$('hint').classList.toggle('warn',!!warn)};
const sendResult=r=>{if(r&&r.error)hint(r.error,true)};

function statusChip(s){
  if(!s.configured)return['Not set up','red'];
  if(s.hubError)return[s.hubError,'red'];
  if(s.status!=='connected')return[s.status==='disconnected'?"Can't reach the hub":'Connecting…','red'];
  if(s.paused)return['Clipboard paused',''];
  return[s.via==='tailscale'?'Connected over Tailscale':s.via==='local'?'This computer is the hub':'Connected over Wi-Fi','blue'];
}

let lastReceived='';
function render(){
  const {devices,clips,received,sent}=state;
  const [label,color]=statusChip(state);$('status').textContent=label;$('status').className='chip '+color;
  if(state.device)$('pcname').textContent=state.device;
  $('empty').style.display=devices.length?'none':'block';
  if(!$('hint').classList.contains('warn'))hint(devices.length?'Drop files onto a device, or click it to choose files':'');
  const box=$('devs'),sig=devices.map(d=>d.id+d.name).join();
  if(box.dataset.sig!==sig){
    box.dataset.sig=sig;box.innerHTML='';
    for(const d of devices){
      const el=document.createElement('div');el.className='dev';el.dataset.id=d.id;
      el.innerHTML='<div class="bubble">'+(ICONS[d.kind]||PHONE)+'</div><b></b><small>Ready</small>';
      el.querySelector('b').textContent=d.name;
      el.onclick=()=>api.pickFiles(d.id).then(sendResult);
      el.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();el.classList.add('over')});
      el.addEventListener('dragleave',()=>el.classList.remove('over'));
      el.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();el.classList.remove('over');
        document.body.classList.remove('over-all');
        api.sendDropped(e.dataTransfer.files,d.id).then(sendResult)});
      box.append(el);
    }
  }
  // Clipboard: recent text and images from all your devices; click to copy again
  $('clipsWrap').hidden=!state.configured||!clips.length;
  $('pause').textContent=state.paused?'Resume':'Pause';
  const cl=$('clips');cl.innerHTML='';
  for(const c of clips){
    const text=c.kind==='image'?'🖼  Image':c.text.replace(/\s+/g,' ').trim();
    const li=row(text,c.mine?'this computer':c.from);
    li.title='Click to copy again';li.onclick=()=>api.copyClip(c.id).then(()=>hint('Copied'));
    cl.append(li);
  }
  $('sentWrap').hidden=!sent.length;
  const su=$('sent');su.innerHTML='';
  for(const f of sent)su.append(row(f.name,mb(f.size)+' → '+f.to));
  const sig2=received.map(f=>f.id).join();
  if(sig2!==lastReceived){lastReceived=sig2;
    const ul=$('list');ul.innerHTML='';
    for(const f of received){const li=row(f.name,mb(f.size)+' · '+f.from,f.path);li.onclick=()=>openLightbox(f);ul.append(li)}}
}
// Keep the device bubbles clear of the lists docked at the bottom
new ResizeObserver(()=>{$('stage').style.paddingBottom=$('dock').offsetHeight+'px'}).observe($('dock'));
api.onState(s=>{state=s;render();if(!s.configured)openSettings()});
api.state().then(s=>{state=s;render()});

// Dropping anywhere: goes to the only device, to all your devices if none are online, or hint to drop on one
addEventListener('dragover',e=>{e.preventDefault();document.body.classList.add('over-all')});
addEventListener('dragleave',e=>{if(!e.relatedTarget)document.body.classList.remove('over-all')});
addEventListener('drop',e=>{e.preventDefault();document.body.classList.remove('over-all');
  if(state.devices.length===1)api.sendDropped(e.dataTransfer.files,state.devices[0].id).then(sendResult);
  else if(!state.devices.length)api.sendDropped(e.dataTransfer.files,null).then(r=>{sendResult(r);if(r&&r.ok)hint('Sent. Your devices will get it when they connect')});
  else hint('Drop the files onto a specific device',true)});

// --- Settings ---------------------------------------------------------------
const role=()=>document.querySelector('input[name=role]:checked').value;
function showRole(){$('hubInfo').hidden=role()!=='hub';$('hubField').hidden=role()!=='join'}
for(const r of document.querySelectorAll('input[name=role]'))r.onchange=showRole;
function msg(t,kind=''){$('msg').textContent=t;$('msg').className=kind}
async function openSettings(){
  if($('settings').style.display==='flex')return;
  const s=await api.settings();
  document.querySelector(`input[name=role][value=${s.role}]`).checked=true;
  $('thisHub').textContent=s.thisHub.url;
  $('hubAway').textContent=s.thisHub.tailscale.length?`Away from home, your devices reach it through Tailscale (${s.thisHub.tailscale.join(', ')}).`:"Tailscale isn't running here, so PhoneDrop only works on your home Wi-Fi.";
  $('joinAway').textContent=s.awayAddresses.length?`Away from home: through Tailscale (${s.awayAddresses.join(', ')}).`:"After connecting at home once, PhoneDrop learns the hub's Tailscale address and keeps working when you're away.";
  $('hubAddress').value=s.hubAddress;$('device').value=s.device;
  $('passphrase').value='';$('passphrase').required=!s.hasPassphrase;
  $('passphrase').placeholder=s.hasPassphrase?'Saved. Type a new one to change it':'';
  $('closeSettings').hidden=!s.configured;msg('');showRole();
  $('settings').style.display='flex';
}
$('showSettings').onclick=openSettings;
api.onOpenSettings(openSettings);
$('closeSettings').onclick=()=>$('settings').style.display='none';
$('form').onsubmit=async e=>{
  e.preventDefault();$('save').disabled=true;msg('Saving…');
  const r=await api.saveSettings({role:role(),hubAddress:$('hubAddress').value,passphrase:$('passphrase').value,device:$('device').value});
  $('save').disabled=false;
  if(!r.ok)return msg(r.error,'error');
  if(r.hubAddress)$('hubAddress').value=r.hubAddress;
  msg('Saved','ok');$('closeSettings').hidden=false;
  api.info().then(show);
  setTimeout(()=>{$('settings').style.display='none'},600);
};
