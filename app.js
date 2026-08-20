/* Kick Mod - static GitHub Pages build.
   IMPORTANT: this is a public client. The Client Secret is intentionally embedded
   only because the owner requested a serverless build. Anyone can inspect it.
*/
const CONFIG = {
  clientId: 'd3d761ffd45882a6bcdb0553a37158a8eb931fe0ed8a453f7eb8890642968349',
  clientSecret: '889064296834',
  redirectUri: 'https://attiakhaled663-cloud.github.io/KickMod/',
  oauthBase: 'https://id.kick.com',
  apiBase: 'https://api.kick.com',
  scopes: 'user:read channel:read chat:write'
};

const STORE='kickmod-static-v1';
let state={accounts:[], settings:{staggerSeconds:5}, running:false, selected:{}, currentAccountId:null, currentChannelId:null};
let statusTimer=null, schedulerTimer=null;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const save=()=>localStorage.setItem(STORE,JSON.stringify(state));
const loadStore=()=>{try{const x=JSON.parse(localStorage.getItem(STORE)||'{}');state={...state,...x,accounts:Array.isArray(x.accounts)?x.accounts:[]};}catch{}};
function openModal(html){$('#sheet').innerHTML=html;$('#modal').classList.remove('hidden')}
function closeModal(){$('#modal').classList.add('hidden')}
$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')closeModal()});

function b64url(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
function randomString(n=48){const a=new Uint8Array(n);crypto.getRandomValues(a);return b64url(a)}
async function sha256(s){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))}

function oauthStart(){
  const verifier=randomString(48), stateToken=randomString(24);
  sessionStorage.setItem('kickmod_oauth',JSON.stringify({verifier,state:stateToken}));
  sha256(verifier).then(hash=>{
    const p=new URLSearchParams({response_type:'code',client_id:CONFIG.clientId,redirect_uri:CONFIG.redirectUri,scope:CONFIG.scopes,code_challenge:b64url(hash),code_challenge_method:'S256',state:stateToken});
    location.href=`${CONFIG.oauthBase}/oauth/authorize?${p}`;
  });
}

async function tokenRequest(body){
  const r=await fetch(`${CONFIG.oauthBase}/oauth/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.message||d.error||`OAuth ${r.status}`);
  return d;
}
async function kick(token,path,opt={}){
  const r=await fetch(`${CONFIG.apiBase}${path}`,{...opt,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(opt.headers||{})}});
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=new Error(d.message||`Kick API ${r.status}`);e.status=r.status;throw e}
  return d;
}
async function finishOAuth(){
  const q=new URLSearchParams(location.search), code=q.get('code'), returnedState=q.get('state');
  if(!code)return;
  const saved=JSON.parse(sessionStorage.getItem('kickmod_oauth')||'null');
  history.replaceState({},'',location.pathname);
  if(!saved||returnedState!==saved.state){alert('OAuth state غير صالح. حاول إضافة الحساب مرة أخرى.');return}
  try{
    const t=await tokenRequest({grant_type:'authorization_code',code,client_id:CONFIG.clientId,client_secret:CONFIG.clientSecret,redirect_uri:CONFIG.redirectUri,code_verifier:saved.verifier});
    const me=await kick(t.access_token,'/public/v1/users');
    const u=me.data?.[0]||me.data||me.user||{};
    const userId=String(u.user_id??u.id??'');
    const username=u.username||u.name||'Kick User';
    let a=state.accounts.find(x=>String(x.userId)===userId);
    const base={username,userId,avatar:u.profile_picture||u.profile_picture_url||'',accessToken:t.access_token,refreshToken:t.refresh_token||'',expiresAt:Date.now()+Number(t.expires_in||3600)*1000,scopes:t.scope||CONFIG.scopes,status:'متوقف',channels:[]};
    if(a)Object.assign(a,base);else state.accounts.push({id:crypto.randomUUID(),...base});
    save(); sessionStorage.removeItem('kickmod_oauth'); render();
    alert(`تم ربط الحساب: ${username}`);
  }catch(e){alert('فشل ربط حساب Kick: '+e.message)}
}

async function refreshAccount(a){
  if(!a.refreshToken)throw new Error('لا يوجد Refresh Token لهذا الحساب. أعد تسجيل الدخول.');
  const t=await tokenRequest({grant_type:'refresh_token',client_id:CONFIG.clientId,client_secret:CONFIG.clientSecret,refresh_token:a.refreshToken});
  a.accessToken=t.access_token;a.refreshToken=t.refresh_token||a.refreshToken;a.expiresAt=Date.now()+Number(t.expires_in||3600)*1000;a.status='متوقف';save();return a;
}
async function validToken(a){
  if(!a.accessToken)throw new Error('لا يوجد Access Token');
  if(a.expiresAt&&Date.now()>a.expiresAt-60000)await refreshAccount(a);
  return a.accessToken;
}
async function inspectToken(a){
  try{
    const r=await fetch(`${CONFIG.oauthBase}/oauth/token/introspect`,{method:'POST',headers:{Authorization:`Bearer ${a.accessToken}`}});
    const d=await r.json().catch(()=>({}));
    const active=d.data?.active;
    a.status=active?'صالح':'توكن منتهي';save();return active;
  }catch{return false}
}

function render(){
  const box=$('#accounts');box.innerHTML='';
  state.accounts.forEach(a=>{
    const checked=state.selected[a.id]?'checked':'';
    const expired=a.status==='توكن منتهي';
    const el=document.createElement('div');el.className='account';
    el.innerHTML=`<input type="checkbox" class="account-check" data-id="${a.id}" ${checked} onchange="pickAccount('${a.id}',this.checked)"><div class="name"><b>${esc(a.username)}</b><div class="status ${expired?'bad':''}">${esc(a.status)} · ${a.channels.length} قناة</div></div><div class="actions"><button onclick="deleteAccount('${a.id}')">✕</button><button onclick="accountSettings('${a.id}')">⚙</button><button onclick="refreshToken('${a.id}')">🔑</button></div>`;
    box.appendChild(el);
  });
  $('#power').classList.toggle('on',state.running);$('#power span').textContent=state.running?'إيقاف':'تشغيل';
}
function pickAccount(id,v){state.selected[id]=v;save()}
function selectAll(v){document.querySelectorAll('.account-check').forEach(x=>{x.checked=v;state.selected[x.dataset.id]=v});save()}

async function togglePower(){
  const ids=Object.keys(state.selected).filter(id=>state.selected[id]);
  if(!state.running&&!ids.length)return alert('حدد حسابًا واحدًا على الأقل.');
  state.running=!state.running;state.accounts.forEach(a=>{if(state.selected[a.id])a.status=state.running?'يعمل':'متوقف'});save();render();
  if(state.running){await refreshLiveStates();startScheduler()}else stopScheduler();
}
function startScheduler(){clearInterval(schedulerTimer);schedulerTimer=setInterval(runScheduler,1000);runScheduler()}
function stopScheduler(){clearInterval(schedulerTimer);schedulerTimer=null}
async function runScheduler(){
  if(!state.running)return;
  const now=Date.now();
  for(const a of state.accounts.filter(x=>state.selected[x.id])){
    for(const c of a.channels.filter(x=>x.live&&x.settings?.enabled!==false)){
      const s=c.settings||{};
      if(!s.messages?.length)continue;
      if(!c.nextSendAt)c.nextSendAt=now;
      if(now<c.nextSendAt)continue;
      try{
        const token=await validToken(a);const msg=s.randomMessages?s.messages[Math.floor(Math.random()*s.messages.length)]:s.messages[(c.messageIndex||0)%s.messages.length];
        c.messageIndex=(c.messageIndex||0)+1;
        await kick(token,'/public/v1/chat',{method:'POST',body:JSON.stringify({content:msg,type:'user',broadcaster_user_id:Number(c.broadcaster_user_id)})});
        const base=Math.max(1,Number(s.intervalSeconds||60));
        const delay=s.randomDelay?randomBetween(Number(s.randomMin||30),Number(s.randomMax||90)):base;
        c.nextSendAt=Date.now()+delay*1000;
        a.status='يعمل';
      }catch(e){a.status=e.status===401?'توكن منتهي':'خطأ في الإرسال';if(e.status===401)try{await refreshAccount(a)}catch{} }
    }
  }
  save();render();
}
function randomBetween(a,b){if(b<a)[a,b]=[b,a];return Math.floor(a+Math.random()*(b-a+1))}

async function refreshLiveStates(){
  for(const a of state.accounts.filter(x=>state.selected[x.id]||state.running)){
    try{
      const token=await validToken(a);const ids=a.channels.map(c=>c.broadcaster_user_id).filter(Boolean);if(!ids.length)continue;
      const qs=ids.map(id=>`broadcaster_user_id=${encodeURIComponent(id)}`).join('&');
      const d=await kick(token,`/public/v2/livestreams?${qs}`);const liveIds=new Set((d.data||[]).map(x=>String(x.broadcaster_user_id??x.channel_id??'')));
      a.channels.forEach(c=>{c.live=liveIds.has(String(c.broadcaster_user_id));if(!c.live)c.nextSendAt=0});
    }catch(e){if(e.status===401)a.status='توكن منتهي'}
  }
  save();render();
}

async function load(){loadStore();render();await finishOAuth();await refreshLiveStates();clearInterval(statusTimer);statusTimer=setInterval(refreshLiveStates,45000)}
async function refreshToken(id){try{await refreshAccount(state.accounts.find(a=>a.id===id));render();alert('تم تحديث التوكن بنجاح')}catch(e){alert(e.message)}}
async function deleteAccount(id){const a=state.accounts.find(x=>x.id===id);if(!confirm(`هل أنت متأكد من حذف الحساب ${a?.username||''}؟`))return;state.accounts=state.accounts.filter(x=>x.id!==id);delete state.selected[id];save();render()}
function openAccounts(){accountSettings(state.accounts[0]?.id)}
function accountSettings(id){
  const a=state.accounts.find(x=>x.id===id);
  if(!a){openModal(`<button class="close" onclick="closeModal()">×</button><h2>حسابات البوتات</h2><p>اضغط + إضافة لربط حساب Kick.</p><button class="green" onclick="oauthStart()">+ إضافة حساب</button>`);return}
  state.currentAccountId=a.id;
  openModal(`<button class="close" onclick="closeModal()">×</button><h2>إدارة: ${esc(a.username)}</h2><div class="row"><button class="green" onclick="addChannel()">+ إضافة قناة</button><button class="danger" onclick="searchChannel()">🔎 بحث</button></div><div id="channel-list">${a.channels.map(channelHtml).join('')||'<p style="color:#777">لا توجد قنوات.</p>'}</div>`)
}
function channelHtml(c){return `<div class="channel"><div class="grow"><b>${esc(c.slug)}</b><div class="${c.live?'live':'offline'}">${c.live?'● مباشر':'● غير مباشر'}</div></div><button class="danger" onclick="channelSettings('${c.broadcaster_user_id}')">⚙</button><button class="danger" onclick="removeChannel('${c.broadcaster_user_id}','${esc(c.slug)}')">✕</button></div>`}
async function findChannel(slug){const a=state.accounts.find(x=>x.id===state.currentAccountId);const token=await validToken(a);const d=await kick(token,`/public/v1/channels?slug=${encodeURIComponent(slug)}`);return (d.data||[])[0]}
async function addChannel(){const slug=prompt('اكتب اسم القناة أو الـSlug');if(!slug)return;try{const c=await findChannel(slug.replace(/^@/,''));if(!c)return alert('القناة غير موجودة');const a=state.accounts.find(x=>x.id===state.currentAccountId);if(a.channels.some(x=>String(x.broadcaster_user_id)===String(c.broadcaster_user_id)))return alert('القناة مضافة بالفعل');a.channels.push({slug:c.slug,broadcaster_user_id:String(c.broadcaster_user_id),live:!!c.stream,settings:{messages:[],intervalSeconds:60,randomMin:30,randomMax:90,randomMessages:true,randomDelay:false,enabled:true}});save();await refreshLiveStates();accountSettings(a.id)}catch(e){alert(e.message)}}
async function searchChannel(){return addChannel()}
async function removeChannel(id,name){const a=state.accounts.find(x=>x.id===state.currentAccountId);if(!confirm(`هل أنت متأكد من حذف ${name}؟`))return;a.channels=a.channels.filter(c=>String(c.broadcaster_user_id)!==String(id));save();accountSettings(a.id)}
function channelSettings(id){
  const a=state.accounts.find(x=>x.id===state.currentAccountId);const c=a.channels.find(x=>String(x.broadcaster_user_id)===String(id));state.currentChannelId=String(id);const s=c.settings||{};
  openModal(`<button class="close" onclick="accountSettings('${a.id}')">×</button><h2>${esc(c.slug)}</h2><div class="field"><label>الرسائل (كل سطر رسالة)</label><textarea id="messages">${esc((s.messages||[]).join('\n'))}</textarea></div><div class="field"><label>الفاصل الزمني بالثواني</label><input id="interval" type="number" min="1" value="${Number(s.intervalSeconds||60)}"></div><div class="field"><label>من إلى للتأخير العشوائي</label><div class="row"><input id="min" type="number" min="1" value="${Number(s.randomMin||30)}"><input id="max" type="number" min="1" value="${Number(s.randomMax||90)}"></div></div><div class="field"><label><input id="randomMessages" type="checkbox" ${s.randomMessages?'checked':''}> رسائل عشوائية</label></div><div class="field"><label><input id="randomDelay" type="checkbox" ${s.randomDelay?'checked':''}> تأخير عشوائي</label></div><div class="field"><label><input id="enabled" type="checkbox" ${s.enabled!==false?'checked':''}> تشغيل لهذا البوت</label></div><button class="green" onclick="saveChannelSettings()">حفظ</button>`)
}
function saveChannelSettings(){const a=state.accounts.find(x=>x.id===state.currentAccountId),c=a.channels.find(x=>String(x.broadcaster_user_id)===state.currentChannelId);c.settings={messages:$('#messages').value.split('\n').map(x=>x.trim()).filter(Boolean),intervalSeconds:Math.max(1,Number($('#interval').value)||60),randomMin:Math.max(1,Number($('#min').value)||30),randomMax:Math.max(1,Number($('#max').value)||90),randomMessages:$('#randomMessages').checked,randomDelay:$('#randomDelay').checked,enabled:$('#enabled').checked};c.nextSendAt=0;save();accountSettings(a.id)}
function openExpired(){
  openModal(`<button class="close" onclick="closeModal()">×</button><h2>فحص التوكنات 🕵️‍♂️</h2><p>سيتم فحص كل الحسابات عبر Kick OAuth.</p><button class="green" onclick="checkAllTokens()">فحص الآن</button><div id="token-results"></div>`)
}
async function checkAllTokens(){const out=$('#token-results');out.innerHTML='جاري الفحص...';for(const a of state.accounts)await inspectToken(a);out.innerHTML=state.accounts.map(a=>`<div class="channel"><div class="grow">${esc(a.username)}</div><span class="${a.status==='صالح'?'live':'bad'}">${esc(a.status)}</span></div>`).join('');render()}
function openMore(){openModal(`<button class="close" onclick="closeModal()">×</button><h2>المزيد ⚙️</h2><div class="field"><label>الفاصل بين بدء الحسابات (ثانية)</label><input id="stagger" type="number" min="1" value="${Number(state.settings.staggerSeconds||5)}"></div><button class="green" onclick="setStagger()">حفظ</button><hr><button class="green" onclick="openBackup()">💾 حفظ / استعادة</button>`)}
function setStagger(){state.settings.staggerSeconds=Math.max(1,Number($('#stagger').value)||5);save();alert('تم الحفظ')}

async function deriveKey(password,salt){const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:120000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
function bytesToB64(a){return btoa(String.fromCharCode(...a))}
function b64ToBytes(s){return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function makeBackup(){const p=$('#backupPass').value;if(!p)return alert('اكتب كلمة المرور');const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),key=await deriveKey(p,salt);const payload=JSON.stringify({accounts:state.accounts.map(a=>({...a})),settings:state.settings});const enc=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(payload));const code=[bytesToB64(salt),bytesToB64(iv),bytesToB64(new Uint8Array(enc))].join('.');$('#backupCode').value=code;await navigator.clipboard?.writeText(code).catch(()=>{});alert('تم إنشاء كود النسخة الاحتياطية')}
async function restoreBackup(){try{const p=$('#backupPass').value,c=$('#backupCode').value.trim();if(!p||!c)return alert('أدخل كلمة المرور والكود');const [s,i,d]=c.split('.');if(!s||!i||!d)throw new Error('الكود غير صالح');const key=await deriveKey(p,b64ToBytes(s));const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64ToBytes(i)},key,b64ToBytes(d));const x=JSON.parse(new TextDecoder().decode(dec));if(!Array.isArray(x.accounts))throw new Error('بيانات غير صالحة');state.accounts=x.accounts;state.settings=x.settings||state.settings;save();closeModal();render();await refreshLiveStates();alert('تمت الاستعادة')}catch(e){alert('فشل الاستعادة: '+e.message)}}
function openBackup(){openModal(`<button class="close" onclick="openMore()">×</button><h2>حفظ / استعادة</h2><div class="field"><label>كلمة المرور</label><input id="backupPass" type="password"></div><button class="green" onclick="makeBackup()">📋 إنشاء كود</button><div class="field"><textarea id="backupCode" placeholder="الصق كود النسخة هنا"></textarea></div><button class="green" onclick="restoreBackup()">استعادة البيانات</button>`)}
function openRestore(){openBackup()}

window.oauthStart=oauthStart;window.closeModal=closeModal;window.togglePower=togglePower;window.selectAll=selectAll;window.pickAccount=pickAccount;window.accountSettings=accountSettings;window.refreshToken=refreshToken;window.deleteAccount=deleteAccount;window.addChannel=addChannel;window.searchChannel=searchChannel;window.removeChannel=removeChannel;window.channelSettings=channelSettings;window.saveChannelSettings=saveChannelSettings;window.openExpired=openExpired;window.checkAllTokens=checkAllTokens;window.openMore=openMore;window.setStagger=setStagger;window.openBackup=openBackup;window.openRestore=openRestore;window.makeBackup=makeBackup;window.restoreBackup=restoreBackup;window.openAccounts=openAccounts;
load().catch(e=>alert('خطأ في تشغيل Kick Mod: '+e.message));
