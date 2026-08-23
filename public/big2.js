
const socket = io();
const $ = id => document.getElementById(id);
let selectedAnimal = "🐶";
let hand = [];
let state = null;
let selected = new Set();
let selectedType = null;
let pendingCombos = [];

document.querySelectorAll("#big2Animals button").forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll("#big2Animals button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active"); selectedAnimal=btn.dataset.animal;
  };
});
document.querySelectorAll(".typeBtn").forEach(btn=>{
  btn.onclick=()=>{
    const t=btn.dataset.type;
    selectedType = selectedType===t ? null : t;
    document.querySelectorAll(".typeBtn").forEach(b=>b.classList.toggle("active",b.dataset.type===selectedType));
  };
});

$("big2RoomCode").oninput=()=>{$("big2RoomCode").value=$("big2RoomCode").value.replace(/\D/g,"").slice(0,3)};
const nameValue=()=>$("big2Name").value.trim();
function openGame(code){$("big2Landing").classList.add("hidden");$("big2Game").classList.remove("hidden");$("big2Code").textContent=code}

$("big2Create").onclick=()=>socket.emit("createRoom",{name:nameValue(),animal:selectedAnimal,gameType:"big2"},res=>{
  if(!res?.ok)return $("big2LandingMsg").textContent=res?.message||"建立失敗";
  if(res.name)$("big2Name").value=res.name; openGame(res.code);
});
$("big2Join").onclick=()=>socket.emit("joinRoom",{name:nameValue(),animal:selectedAnimal,code:$("big2RoomCode").value},res=>{
  if(!res?.ok)return $("big2LandingMsg").textContent=res?.message||"加入失敗";
  if(res.gameType!=="big2")return $("big2LandingMsg").textContent="這個房號不是大老二房間";
  if(res.name)$("big2Name").value=res.name; openGame(res.code);
});
$("big2Copy").onclick=async()=>navigator.clipboard.writeText($("big2Code").textContent);
$("big2Start").onclick=()=>socket.emit("big2Start",{},r=>{if(!r?.ok)$("big2Msg").textContent=r?.message||"無法開始"});
$("big2Pass").onclick=()=>socket.emit("big2Pass",{},r=>{if(!r?.ok)$("big2Msg").textContent=r?.message||"不能 Pass"});
$("big2Exit").onclick=()=>socket.emit("leaveRoom",{},()=>location.href="/");

function cardText(c){return `${c.suit}${c.rank}`}
function red(c){return c.suit==="♥"||c.suit==="♦"}
function renderHand(){
  $("big2HandCount").textContent=`（${hand.length} 張）`;
  $("big2Hand").innerHTML="";
  hand.forEach((c,i)=>{
    const b=document.createElement("button");
    b.className=`big2HandCard ${red(c)?"red":""} ${selected.has(i)?"selected":""}`;
    b.textContent=cardText(c);
    b.onclick=()=>{selected.has(i)?selected.delete(i):selected.add(i);renderHand()};
    $("big2Hand").appendChild(b);
  });
}

function renderSeats(){
  const meIndex=state.players.findIndex(p=>p.id===socket.id);
  const me=state.players[meIndex];
  const others=state.players.filter((_,i)=>i!==meIndex);
  const seats=[b2Seat0,b2Seat1,b2Seat2,b2Seat3];
  seats.forEach(s=>{s.className="b2Seat hidden";s.innerHTML=""});
  let a=[];
  if(me){
    if(others.length===0)a=[[3,me]];
    if(others.length===1)a=[[0,others[0]],[3,me]];
    if(others.length===2)a=[[0,others[0]],[1,others[1]],[3,me]];
    if(others.length===3)a=[[0,others[0]],[1,others[1]],[2,others[2]],[3,me]];
  }
  const pos=["top","left","right","bottom"];
  a.forEach(([i,p])=>{
    const s=seats[i]; s.className=`b2Seat ${pos[i]} ${p.isTurn?"turn":""}`;
    s.innerHTML=`<div class="avatar">${esc(p.animal)}</div><div class="name">${esc(p.name)}${p.id===socket.id?"（你）":""}</div><div class="count">${p.cardCount} 張牌</div><div class="record">勝 ${p.wins||0}｜敗 ${p.losses||0}</div>`;
  });
}
function renderStack(){
  const plays=state.tablePlays||[];
  $("big2Stack").innerHTML=plays.slice(-4).map((p,idx,arr)=>{
    const latest=idx===arr.length-1;
    const offset=(idx-arr.length+1)*10;
    return `<div class="stackPlay ${latest?"latest":"old"}" style="transform:translate(-50%,-50%) translate(${offset}px,${offset}px)">
      ${p.cards.map(c=>`<div class="stackCard ${red(c)?"red":""}">${cardText(c)}</div>`).join("")}
    </div>`;
  }).join("");
  const lp=state.lastPlay;
  $("lastPlayLabel").textContent=lp?`上一手：${lp.playerName}｜${typeLabel(lp.type)}｜${lp.cards.map(cardText).join(" ")}`:"等待第一手";
}
function renderHistory(){
  $("big2History").innerHTML=(state.history||[]).slice().reverse().map(h=>`<div class="historyItem"><strong>${esc(h.playerName)}</strong>　${typeLabel(h.type)}<div class="historyCards">${h.cards.map(cardText).join(" ")}</div></div>`).join("");
}
function renderLeaderboard(){
  const ps=[...state.players].sort((a,b)=>(b.wins||0)-(a.wins||0)||(a.losses||0)-(b.losses||0));
  $("big2Leaderboard").innerHTML=ps.map((p,i)=>`<div class="leaderRow"><span>${["🥇","🥈","🥉","4️⃣"][i]}</span><span class="leaderName">${esc(p.animal)} ${esc(p.name)}</span><strong>${p.wins||0}勝</strong><span>${p.losses||0}敗</span></div>`).join("");
}
function renderChat(msgs=[]){
  $("big2Chat").innerHTML=msgs.map(m=>`<div class="big2ChatMsg"><strong>${esc(m.animal)} ${esc(m.name)}</strong>：${esc(m.text)}</div>`).join("");
  $("big2Chat").scrollTop=$("big2Chat").scrollHeight;
}
function render(){
  if(!state)return;
  $("big2Code").textContent=state.code;
  const cur=state.players[state.turnIndex];
  $("big2Status").textContent=state.started?`輪到：${cur?.animal||""} ${cur?.name||""}`:`等待開始，目前 ${state.players.length} 人`;
  $("big2HostBox").classList.toggle("hidden",state.started||state.hostId!==socket.id);
  renderSeats();renderStack();renderHistory();renderLeaderboard();renderChat(state.chat||[]);
}

socket.on("yourHand",cards=>{if(state?.gameType==="big2"||location.pathname.includes("big2")){hand=cards;selected=new Set([...selected].filter(i=>i<hand.length));renderHand()}});
socket.on("roomState",s=>{if(s.gameType!=="big2")return;state=s;render()});
socket.on("chatMessage",m=>{if(!state)return;state.chat=[...(state.chat||[]),m].slice(-30);renderChat(state.chat)});

$("big2ChatSend").onclick=sendChat;
$("big2ChatInput").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();sendChat()}};
function sendChat(){const text=$("big2ChatInput").value.trim();if(!text)return;socket.emit("sendChat",{message:text},r=>{if(r?.ok)$("big2ChatInput").value=""})}

$("big2Play").onclick=()=>{
  const idx=[...selected].sort((a,b)=>a-b);
  if(!idx.length)return $("big2Msg").textContent="請先選牌";
  if(idx.length===1){return submitPlay(idx,"single")}
  if(!selectedType)return $("big2Msg").textContent="多張牌請先點選牌型";
  socket.emit("big2Combos",{type:selectedType,selectedIndices:idx},res=>{
    if(!res?.ok)return $("big2Msg").textContent=res?.message||"無可用組合";
    if(res.combos.length===1)return submitPlay(res.combos[0].indices,selectedType);
    pendingCombos=res.combos;showComboPreview(res.combos,selectedType);
  });
};
function submitPlay(indices,type){
  socket.emit("big2Play",{indices,type},res=>{
    if(!res?.ok)return $("big2Msg").textContent=res?.message||"出牌失敗";
    selected.clear();selectedType=null;document.querySelectorAll(".typeBtn").forEach(b=>b.classList.remove("active"));$("big2Msg").textContent="";
  });
}
function showComboPreview(combos,type){
  $("comboOptions").innerHTML=combos.map((c,i)=>`<div class="comboOption" data-i="${i}"><strong>${typeLabel(type)} ${i+1}</strong><div class="comboPreview">${c.cards.map(x=>`<div class="miniCard ${red(x)?"red":""}">${cardText(x)}</div>`).join("")}</div></div>`).join("");
  document.querySelectorAll(".comboOption").forEach(el=>el.onclick=()=>{const c=pendingCombos[+el.dataset.i];$("comboOverlay").classList.add("hidden");submitPlay(c.indices,type)});
  $("comboOverlay").classList.remove("hidden");
}
$("comboCancel").onclick=()=>$("comboOverlay").classList.add("hidden");

function typeLabel(t){return ({single:"單張",pair:"對子",straight:"順子",fullhouse:"葫蘆",fourkind:"鐵支",straightflush:"同花順"}[t]||t)}
function esc(s){return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}
