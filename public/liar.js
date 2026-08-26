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

function forceLandingViewOnLoad(){
  const landing = $("landing");
  const game = $("game");
  if (landing) landing.classList.remove("hidden");
  if (game) game.classList.add("hidden");
}
forceLandingViewOnLoad();

function setMsg(t){$("gameMsg").textContent=t||"";}

$("roomCodeInput").addEventListener("input", () => {
  $("roomCodeInput").value = $("roomCodeInput").value.replace(/\D/g, "").slice(0, 3);
});


$("createBtn").onclick=()=>socket.emit("createRoom",{name:nameValue(),animal:selectedAnimal,gameType:"liar",roundLimit:Number($("roundLimitInput")?.value||20)},res=>{
  if(!res.ok)return $("landingMsg").textContent=res.message;
  if(res.name) $("name").value=res.name;
  showGame(res.code);
});

$("joinBtn").onclick=()=>socket.emit("joinRoom",{name:nameValue(),code:$("roomCodeInput").value,animal:selectedAnimal},res=>{
  if(!res.ok)return $("landingMsg").textContent=res.message;
  if(res.name) $("name").value=res.name;
  showGame(res.code);
});

$("copyBtn").onclick=async()=>{await navigator.clipboard.writeText($("roomCode").textContent);$("copyBtn").textContent="已複製";setTimeout(()=>$("copyBtn").textContent="複製房號",1000);};

$("startBtn").onclick=()=>socket.emit("startGame",{},res=>{if(res&&!res.ok)setMsg(res.message);});

$("playBtn").onclick=()=>{
  if(!state?.started){
    return setMsg("遊戲尚未開始");
  }

  const me=state.players?.find(p=>p.id===socket.id);
  if(!me?.isTurn){
    return setMsg("還沒輪到你");
  }

  // V5.49：直接從目前畫面中已選取牌讀取原始手牌 index，
  // 避免手牌顯示排序後出牌 index 不一致。
  const indices=[...document.querySelectorAll("#hand .card.selected")]
    .map(el=>Number(el.dataset.originalIndex))
    .filter(Number.isInteger)
    .sort((a,b)=>a-b);

  if(!indices.length){
    return setMsg("至少要選 1 張牌");
  }

  $("playBtn").disabled=true;

  socket.emit("playCards",{indices,claimRank:$("claimRank").value},res=>{
    if(!res?.ok){
      $("playBtn").disabled=false;
      return setMsg(res?.message||"出牌失敗");
    }

    selected.clear();
    setMsg("");
  });
};

$("challengeBtn").onclick=()=>{
  if (!state?.started || !state?.lastPlay) {
    return setMsg("目前沒有可以抓的上一手");
  }

  if (state.lastPlay.playerId === socket.id) {
    return setMsg("不能抓自己剛出的牌");
  }

  $("challengeBtn").disabled = true;

  socket.emit("challenge", {}, res => {
    if (!res?.ok) {
      setMsg(res?.message || "抓吹牛失敗");

      const stillCan =
        !!state?.started &&
        !!state?.lastPlay &&
        state.lastPlay.playerId !== socket.id;

      $("challengeBtn").disabled = !stillCan;
      return;
    }

    setMsg("");
  });
};

$("closeResultBtn").onclick=()=>$("resultOverlay").classList.add("hidden");

socket.on("yourHand",cards=>{hand=cards;selected.clear();renderHand();});
socket.on("roomState", next => {
  state = next;
  renderState();
});


socket.on("liarAutoDiscard", payload => {
  const overlay = $("autoDiscardOverlay");
  const cardsBox = $("autoDiscardCards");
  const title = $("autoDiscardTitle");
  const text = $("autoDiscardText");

  if (!overlay || !cardsBox || !title || !text) return;

  title.textContent = `四張 ${payload.rank} 自動丟棄！`;
  text.textContent =
    `你手上湊齊四張 ${payload.rank}，系統已自動丟棄。現在剩下 ${payload.remaining} 張牌。`;

  cardsBox.innerHTML = (payload.cards || []).map(card => {
    const red = card.suit === "♥" || card.suit === "♦";
    return `<div class="discardAnimCard ${red ? "red" : ""}">${card.suit}${card.rank}</div>`;
  }).join("");

  overlay.classList.remove("hidden");

  requestAnimationFrame(() => {
    overlay.classList.add("show");
  });

  window.setTimeout(() => {
    overlay.classList.remove("show");

    window.setTimeout(() => {
      overlay.classList.add("hidden");
    }, 250);
  }, 1900);
});


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


function renderChat(messages = []) {
  const box = $("chatMessages");
  if (!box) return;

  box.innerHTML = messages.map(m => {
    return `<div class="chatMessage ${m.playerId===socket.id?"mine":""}">
      <div class="chatMeta"><strong>${escapeHtml(m.name || "玩家")}</strong></div>
      <div class="chatText">${escapeHtml(m.text || "")}</div>
    </div>`;
  }).join("");

  box.scrollTop = box.scrollHeight;
}

function sendChat() {
  const input = $("chatInput");
  const error = $("chatError");
  const message = input.value.trim();
  if (!message) return;

  $("chatSendBtn").disabled = true;
  socket.emit("sendChat", { message }, res => {
    $("chatSendBtn").disabled = false;
    if (!res?.ok) {
      error.textContent = res?.message || "訊息傳送失敗";
      return;
    }
    input.value = "";
    error.textContent = "";
    input.focus();
  });
}

$("chatSendBtn").onclick = sendChat;
$("chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

socket.on("chatMessage", msg => {
  if (!state) return;
  state.chat = [...(state.chat || []), msg].slice(-30);
  renderChat(state.chat);
});








function renderState(){

  if(!state)return;
  $("roomCode").textContent=state.code;
  $("liarRoundDisplay").textContent=`${state.liarRoundCount||0}/${state.liarRoundLimit||20}`;
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
    seat.innerHTML=`<div class="avatar">${escapeHtml(p.animal||"🐶")}</div><div class="name">${escapeHtml(p.name)}${p.id===socket.id?"（你）":""}</div><div class="record">勝 ${p.wins||0} ｜ 敗 ${p.losses||0}</div><div class="cardCountBadge" aria-label="剩餘牌數">${p.cardCount}</div>`;
  });

  const myTurn=!!me?.isTurn;
  const rankedPlayers=[...state.players].sort((a,b)=>(b.wins||0)-(a.wins||0)||(a.losses||0)-(b.losses||0));
  const medals=["🥇","🥈","🥉","4️⃣"];
  $("leaderboard").innerHTML=rankedPlayers.map((p,i)=>`<div class="leaderRow ${p.id===socket.id?"me":""}"><span>${medals[i]||i+1}</span><span class="leaderName">${escapeHtml(p.name)}</span><strong>${p.wins||0}勝</strong><span>${p.losses||0}敗</span></div>`).join("");

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

  // V5.18：抓吹牛按鈕固定在「你的操作」內，不再因版面/hidden 消失。
  const hasLastPlay = !!state.started && !!state.lastPlay;
  const isLastPlayer = hasLastPlay && state.lastPlay.playerId === socket.id;
  const canChallenge = hasLastPlay && !isLastPlayer;

  $("challengeArea").classList.remove("hidden");
  $("challengeBtn").classList.remove("hidden");
  $("challengeBtn").disabled = !canChallenge;

  if (!state.started) {
    $("challengeHintText").textContent = "遊戲開始後即可使用";
  } else if (!state.lastPlay) {
    $("challengeHintText").textContent = "目前還沒有人出牌";
  } else if (isLastPlayer) {
    $("challengeHintText").textContent = "你剛剛出牌，等待其他玩家抓吹牛";
  } else {
    $("challengeHintText").textContent = `可以抓 ${state.lastPlay.playerName} 的上一手`;
  }

  $("log").innerHTML=state.log.map(x=>`<div>${escapeHtml(x)}</div>`).join("");
  $("log").scrollTop=$("log").scrollHeight;

  renderChat(state.chat || []);
  renderHand();
}

function renderHand(){
  $("handCount").textContent=`（${hand.length} 張）`;
  const handEl = $("hand");
  handEl.dataset.count = String(hand.length);
  handEl.classList.toggle("manyCards", hand.length >= 16);
  handEl.classList.toggle("veryManyCards", hand.length >= 22);

  // V5.26：底部整塊都是手牌區。
  // 手牌多時自動使用兩排，避免玩家資訊框與手牌互相擋住。
  const handDock = handEl.closest(".handDock");
  const available = Math.max(
    300,
    (handDock?.clientWidth || handEl.clientWidth || 900) - 20
  );

  let rows = 1;
  if (hand.length >= 15) rows = 2;
  if (hand.length >= 31) rows = 3;

  const cardsPerRow = Math.max(1, Math.ceil(hand.length / rows));
  const gap = hand.length >= 25 ? 3 : hand.length >= 15 ? 4 : 6;

  const naturalWidth = Math.floor(
    (available - Math.max(0, cardsPerRow - 1) * gap) / cardsPerRow
  );

  const minWidth =
    hand.length >= 31 ? 34 :
    hand.length >= 25 ? 40 :
    hand.length >= 15 ? 46 :
    52;

  const maxWidth =
    hand.length >= 25 ? 50 :
    hand.length >= 15 ? 56 :
    62;

  const cardWidth = Math.max(
    minWidth,
    Math.min(maxWidth, naturalWidth)
  );

  handEl.style.setProperty("--dynamic-card-width", `${cardWidth}px`);
  handEl.style.setProperty("--dynamic-card-gap", `${gap}px`);
  handEl.dataset.rows = String(rows);

  // 兩人局通常約 26 張/人，兩排即可完整顯示。
  // 只有極端情況才允許手牌區本身上下捲動。
  handEl.classList.toggle(
    "needsVerticalScroll",
    rows >= 3 && hand.length > 39
  );
  $("hand").innerHTML="";

  // V5.27：只改「顯示順序」，不改伺服器手牌陣列。
  // selected 仍保存原始 index，所以出牌資料不會錯位。
  const rankOrder = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
  const suitOrder = {"♠":0,"♥":1,"♦":2,"♣":3};

  const displayHand = hand
    .map((card, originalIndex) => ({ card, originalIndex }))
    .sort((a,b) => {
      const rankDiff = rankOrder.indexOf(a.card.rank) - rankOrder.indexOf(b.card.rank);
      if (rankDiff !== 0) return rankDiff;
      return (suitOrder[a.card.suit] ?? 99) - (suitOrder[b.card.suit] ?? 99);
    });

  let previousRank = null;

  displayHand.forEach(({card, originalIndex})=>{
    const el=document.createElement("button");
    el.type="button";

    const red=card.suit==="♥"||card.suit==="♦";
    const newGroup = previousRank !== null && previousRank !== card.rank;

    el.className =
      "card" +
      (red ? " red" : "") +
      (selected.has(originalIndex) ? " selected" : "") +
      (newGroup ? " rankGroupStart" : "");

    el.textContent=`${card.suit}${card.rank}`;
    el.dataset.rank = card.rank;
    el.dataset.originalIndex = String(originalIndex);

    el.onclick=()=>{
      selected.has(originalIndex)
        ? selected.delete(originalIndex)
        : selected.add(originalIndex);
      renderHand();
    };

    $("hand").appendChild(el);
    previousRank = card.rank;
  });
}



$("lobbyBtn").onclick=()=>{
  // 直接回網站首頁的遊戲大廳。
  // 頁面離開時 Socket 會 disconnect，伺服器會同步移除該玩家。
  window.location.href="/";
};

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


// V5.9：確保頁面載入後倒數持續刷新
// V5.12：抓吹牛按鈕權限只看 state.canChallenge，所有房內玩家共用。

// V5.14：頁面載入後啟動唯一一個倒數刷新器。
// 尚未開始遊戲時只會停在 05:00；收到 liarDeadline 後才真正往下倒數。

let handResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(handResizeTimer);
  handResizeTimer = setTimeout(() => {
    if (Array.isArray(hand)) renderHand();
  }, 100);
});
