const socket = io();
const $ = id => document.getElementById(id);

let state = null;
let hand = [];
let selected = new Set();
let selectedAnimal = "🐶";
let resultTimer = null;

let selectedRank = "A";

function setRankSelection(rank, locked = false) {
  selectedRank = rank;
  $("claimRank").value = rank;
  document.querySelectorAll(".rankBtn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.rank === rank);
    btn.disabled = locked;
  });
}

document.querySelectorAll(".rankBtn").forEach(btn => {
  btn.onclick = () => {
    if (btn.disabled) return;
    setRankSelection(btn.dataset.rank, false);
  };
});


document.querySelectorAll(".animal").forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll(".animal").forEach(x=>x.classList.remove("active"));
    btn.classList.add("active");
    selectedAnimal=btn.dataset.animal;
  };
});

function nameValue(){return $("name").value.trim();}
function showGame(code){$("landing").classList.add("hidden");$("game").classList.remove("hidden");$("roomCode").textContent=code;}
function setMsg(t){$("gameMsg").textContent=t||"";}

$("createBtn").onclick=()=>socket.emit("createRoom",{name:nameValue(),animal:selectedAnimal},res=>{
  if(!res.ok)return $("landingMsg").textContent=res.message;
  showGame(res.code);
});

$("joinBtn").onclick=()=>socket.emit("joinRoom",{name:nameValue(),code:$("roomCodeInput").value,animal:selectedAnimal},res=>{
  if(!res.ok)return $("landingMsg").textContent=res.message;
  showGame(res.code);
});

$("copyBtn").onclick=async()=>{await navigator.clipboard.writeText($("roomCode").textContent);$("copyBtn").textContent="已複製";setTimeout(()=>$("copyBtn").textContent="複製房號",1000);};

$("startBtn").onclick=()=>socket.emit("startGame",{},res=>{if(res&&!res.ok)setMsg(res.message);});

$("playBtn").onclick=()=>{
  const indices=[...selected].sort((a,b)=>a-b);
  socket.emit("playCards",{indices,claimRank:$("claimRank").value},res=>{
    if(!res?.ok)return setMsg(res?.message||"出牌失敗");
    selected.clear(); setMsg("");
  });
};

$("challengeBtn").onclick=()=>{
  $("challengeBtn").disabled = true;
  socket.emit("challenge",{},res=>{
    $("challengeBtn").disabled = false;
    if(!res?.ok)setMsg(res?.message||"抓吹牛失敗");
  });
};

$("closeResultBtn").onclick=()=>$("resultOverlay").classList.add("hidden");

socket.on("yourHand",cards=>{hand=cards;selected=new Set([...selected].filter(i=>i<hand.length));renderHand();});
socket.on("roomState",next=>{state=next;renderState();});

socket.on("challengeResult", result=>{
  const overlay=$("resultOverlay");
  const card=$("resultCard");
  card.classList.toggle("fail",!result.success);
  $("resultEmoji").textContent=result.success?"🎉":"⚡";
  $("resultTitle").textContent=result.success?"抓吹牛成功！":"抓吹牛失敗…";
  $("resultText").textContent=result.success
    ? `${result.accusedName} 被抓到吹牛，收走桌面 ${result.pileCount} 張牌！`
    : `${result.challengerName} 抓錯了，收走桌面 ${result.pileCount} 張牌！`;

  $("revealCards").innerHTML=result.revealedCards.map(c=>{
    const red=c.suit==="♥"||c.suit==="♦";
    return `<div class="revealCard ${red?"red":""}">${c.suit}${c.rank}</div>`;
  }).join("");

  overlay.classList.remove("hidden");

  // V4.3：結果動畫顯示 2 秒後自動關閉
  if (resultTimer) clearTimeout(resultTimer);
  resultTimer = setTimeout(() => {
    overlay.classList.add("hidden");
  }, 2000);
});

function renderState(){
  if(!state)return;
  $("roomCode").textContent=state.code;
  $("pileCount").textContent=state.pileCount;

  const meIndex=state.players.findIndex(p=>p.id===socket.id);
  const me=meIndex>=0?state.players[meIndex]:null;
  const others=state.players.filter((_,i)=>i!==meIndex);

  const seats=[$("seat0"),$("seat1"),$("seat2"),$("seat3")];
  seats.forEach((seat,i)=>{
    seat.className=`seat ${["seat-top","seat-left","seat-right","seat-bottom"][i]} hidden`;
    seat.innerHTML="";
  });

  let assignments=[];
  if(me){
    if(others.length===0)assignments=[[3,me]];
    if(others.length===1)assignments=[[0,others[0]],[3,me]];
    if(others.length===2)assignments=[[0,others[0]],[1,others[1]],[3,me]];
    if(others.length===3)assignments=[[0,others[0]],[1,others[1]],[2,others[2]],[3,me]];
  }
  assignments.forEach(([i,p])=>{
    const seat=seats[i]; seat.classList.remove("hidden");
    if(p.isTurn)seat.classList.add("turn");
    if(p.isWinner)seat.classList.add("winner");
    seat.innerHTML=`<div class="avatar">${escapeHtml(p.animal||"🐶")}</div><div class="name">${escapeHtml(p.name)}${p.id===socket.id?"（你）":""}</div><div class="cards">${p.cardCount} 張牌</div><div class="record">勝 ${p.wins||0} ｜ 敗 ${p.losses||0}</div>`;
  });

  const myTurn=!!me?.isTurn;
  const rankedPlayers=[...state.players].sort((a,b)=>(b.wins||0)-(a.wins||0)||(a.losses||0)-(b.losses||0));
  const medals=["🥇","🥈","🥉","4️⃣"];
  $("leaderboard").innerHTML=rankedPlayers.map((p,i)=>`<div class="leaderRow ${p.id===socket.id?"me":""}"><span>${medals[i]||i+1}</span><span class="leaderName">${escapeHtml(p.animal||"🐶")} ${escapeHtml(p.name)}</span><strong>${p.wins||0}勝</strong><span>${p.losses||0}敗</span></div>`).join("");

  const tableRankBadge = $("tableRoundRankBadge");
  if (state.roundRank) {
    tableRankBadge.classList.remove("waiting");
    tableRankBadge.querySelector("strong").textContent = state.roundRank;
  } else {
    tableRankBadge.classList.add("waiting");
    tableRankBadge.querySelector("strong").textContent = "等待選擇";
  }

  if(state.winnerId){
    const w=state.players.find(p=>p.id===state.winnerId);
    $("status").textContent=`遊戲結束：${w?.animal||""} ${w?.name||"玩家"} 獲勝`;

    $("matchEndTitle").textContent = `🏆 ${w?.name || "玩家"} 獲勝！`;
    $("matchEndText").textContent = "要繼續下一場，還是結束這次遊戲？";
    $("matchStats").innerHTML = state.players.map(p =>
      `<div class="statRow"><span>${escapeHtml(p.animal||"🐶")} ${escapeHtml(p.name)}</span><strong>勝 ${p.wins||0} ｜ 敗 ${p.losses||0}</strong></div>`
    ).join("");
    $("matchEndOverlay").classList.remove("hidden");
  }else if(!state.started){
    $("status").textContent=`等待開始，目前 ${state.players.length} 人`;
  }else{
    const t=state.players[state.turnIndex];
    $("status").textContent=`輪到：${t?.animal||""} ${t?.name||""}`;
  }

  $("startBtn").classList.toggle("hidden",state.started);
  $("playBtn").disabled=!myTurn||!state.started;

  if(state.roundRank){
    setRankSelection(state.roundRank, true);
    $("suitHint").textContent=`本輪已鎖定點數 ${state.roundRank}，直到有人抓吹牛。`;
  }else{
    setRankSelection(selectedRank || "A", false);
    $("suitHint").textContent="新一輪第一位玩家可以自由決定點數。";
  }

  if(state.lastPlay){
    $("lastPlay").textContent=`${state.lastPlay.playerName} 宣稱出了 ${state.lastPlay.count} 張 ${state.lastPlay.claimRank}`;
  }else{
    $("lastPlay").textContent="目前還沒有人出牌";
  }

  $("tableCards").innerHTML=(state.tableCards||[]).map(()=>`<div class="tableCardBack"></div>`).join("");

  // V4.4：由伺服器指定誰可以抓，避免前端回合判斷不同步
  const canChallenge =
    state.started &&
    state.lastPlay &&
    state.challengePlayerId === socket.id &&
    state.lastPlay.playerId !== socket.id;

  $("challengeBtn").classList.toggle("hidden", !canChallenge);
  $("challengeArea").classList.toggle("hidden", !canChallenge);

  $("log").innerHTML=state.log.map(x=>`<div>${escapeHtml(x)}</div>`).join("");
  $("log").scrollTop=$("log").scrollHeight;

  renderHand();
}

function renderHand(){
  $("handCount").textContent=`（${hand.length} 張）`;
  $("hand").innerHTML="";
  hand.forEach((card,index)=>{
    const el=document.createElement("button");
    el.type="button";
    const red=card.suit==="♥"||card.suit==="♦";
    el.className="card"+(red?" red":"")+(selected.has(index)?" selected":"");
    el.textContent=`${card.suit}${card.rank}`;
    el.onclick=()=>{selected.has(index)?selected.delete(index):selected.add(index);renderHand();};
    $("hand").appendChild(el);
  });
}


$("exitGameBtn").onclick=()=>{
  if(!window.confirm("確定要退出目前遊戲嗎？")) return;
  socket.emit("leaveRoom",{},res=>{
    if(!res?.ok){ setMsg(res?.message||"無法退出遊戲"); return; }
    $("matchEndOverlay").classList.add("hidden");
    $("game").classList.add("hidden");
    $("landing").classList.remove("hidden");
    $("landingMsg").textContent="你已退出遊戲，可以重新建立或加入房間。";
    hand=[]; selected.clear(); state=null;
  });
};

$("continueMatchBtn").onclick = () => {
  $("continueMatchBtn").disabled = true;
  socket.emit("continueMatch", {}, res => {
    $("continueMatchBtn").disabled = false;
    if (!res?.ok) setMsg(res?.message || "無法開始下一場");
  });
};

$("endSessionBtn").onclick = () => {
  socket.emit("endSession", {}, res => {
    if (!res?.ok) setMsg(res?.message || "無法結束遊戲");
  });
};

socket.on("matchContinued", () => {
  $("matchEndOverlay").classList.add("hidden");
});

socket.on("sessionEnded", () => {
  $("matchEndOverlay").classList.add("hidden");
  $("game").classList.add("hidden");
  $("landing").classList.remove("hidden");
  $("landingMsg").textContent = "遊戲已結束，可以重新建立或加入房間。";
  hand = [];
  selected.clear();
  state = null;
});

function escapeHtml(s){
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
