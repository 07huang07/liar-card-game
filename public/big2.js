
const socket = io();
const $ = id => document.getElementById(id);
let selectedAnimal = "🐶";
let hand = [];
let state = null;
let selected = new Set();
let selectedType = null;
let pendingCombos = [];
let lastAutoPreviewKey = "";
let comboOverlayOpenedByAuto = false;
let lastRenderedHistoryCount = 0;
let lastSettlementTs = 0;
document.querySelectorAll("#big2Animals button").forEach(btn=>{
  btn.onclick=()=>{
    document.querySelectorAll("#big2Animals button").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active"); selectedAnimal=btn.dataset.animal;
  };
});
document.querySelectorAll(".typeBtn").forEach(btn=>{
  btn.onclick=()=>{
    const t=btn.dataset.type;
    setSelectedType(selectedType===t ? null : t);
    setPassReminder(false);
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
$("big2Pass").onclick=()=>socket.emit("big2Pass",{},r=>{
  if(!r?.ok){
    $("big2Msg").textContent=r?.message||"不能 Pass";
    return;
  }
  setPassReminder(false);
  $("comboOverlay").classList.add("hidden");
  comboOverlayOpenedByAuto=false;
  $("big2Msg").textContent="";
});
$("big2Exit").onclick=()=>socket.emit("leaveRoom",{},()=>location.href="/");

$("settlementLeave").onclick=()=>{
  const isHost = state?.hostId === socket.id;

  if (isHost) {
    $("settlementLeave").disabled = true;
    $("settlementMsg").textContent = "正在結束遊戲…";

    socket.emit("big2EndSession", {}, res => {
      if (!res?.ok) {
        $("settlementLeave").disabled = false;
        $("settlementMsg").textContent = res?.message || "無法結束遊戲";
      }
    });

    return;
  }

  socket.emit("leaveRoom", {}, () => {
    location.href = "/";
  });
};

$("settlementRematch").onclick=()=>{
  if (state?.hostId !== socket.id) return;

  $("settlementRematch").disabled = true;
  $("settlementMsg").textContent = "正在開始下一場…";

  socket.emit("big2Rematch", {}, res => {
    if (!res?.ok) {
      $("settlementRematch").disabled = false;
      $("settlementMsg").textContent = res?.message || "無法開始下一場";
      return;
    }

    $("settlementMsg").textContent = "";
  });
};

function cardText(c){return `${c.suit}${c.rank}`}
function red(c){return c.suit==="♥"||c.suit==="♦"}
function renderHand(){
  $("big2HandCount").textContent=`（${hand.length} 張）`;
  $("big2Hand").innerHTML="";
  hand.forEach((c,i)=>{
    const b=document.createElement("button");
    b.className=`big2HandCard ${red(c)?"red":""} ${selected.has(i)?"selected":""}`;
    b.innerHTML=`<span class="b2CardSuit">${c.suit}</span><span class="b2CardRank">${c.rank}</span>`;

    // 單擊仍保留選取效果，方便玩家查看或日後擴充。
    b.onclick=()=>{
      selected.has(i)?selected.delete(i):selected.add(i);
      renderHand();
    };

    // V5.4：雙擊單張牌直接出牌，不需要再按「出牌」。
    b.ondblclick=(e)=>{
      e.preventDefault();
      e.stopPropagation();
      if(!state?.started){
        $("big2Msg").textContent="遊戲尚未開始";
        return;
      }
      submitPlay([i],"single");
    };

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
    s.innerHTML=`<div class="avatar">${esc(p.animal)}</div><div class="name">${esc(p.name)}${p.id===socket.id?"（你）":""}</div><div class="count">${p.cardCount} 張牌</div><div class="record">積分 ${p.points||0}｜勝 ${p.wins||0}</div>`;
  });
}
function renderStack(){
  const plays=state.tablePlays||[];
  const recent=plays.slice(-4);

  $("big2Stack").innerHTML=recent.map((p,idx,arr)=>{
    const latest=idx===arr.length-1;
    const offset=(idx-arr.length+1)*8;
    return `<div class="stackPlay ${latest?"latest":"old"}" style="transform:translate(-50%,-50%) translate(${offset}px,${offset}px)">
      ${p.cards.map(c=>`<div class="stackCard ${red(c)?"red":""}"><span class="stackSuit">${c.suit}</span><span class="stackRank">${c.rank}</span></div>`).join("")}
    </div>`;
  }).join("");

  const lp=state.lastPlay;
  const info=$("lastPlayInfo");
  if(lp){
    info.classList.remove("hidden");
    info.textContent=`上一手：${lp.playerName}｜${typeLabel(lp.type)}｜${lp.cards.map(cardText).join(" ")}`;
  }else{
    info.classList.add("hidden");
    info.textContent="";
  }
}
function renderHistory(){
  const box=$("big2History");
  const history=state.history||[];

  // 由舊到新排列，最新出牌固定在最下面。
  box.innerHTML=history.map(h=>`<div class="historyItem"><strong>${esc(h.playerName)}</strong>　${typeLabel(h.type)}<div class="historyCards">${h.cards.map(cardText).join(" ")}</div></div>`).join("");

  // 只有真的多一筆新紀錄時才自動移到底部；
  // 玩家仍可用滾輪往上查看之前的出牌。
  if(history.length!==lastRenderedHistoryCount){
    box.scrollTop=box.scrollHeight;
    lastRenderedHistoryCount=history.length;
  }
}
function renderLeaderboard(){
  const ps=[...state.players].sort((a,b)=>
    (b.points||0)-(a.points||0) ||
    (b.wins||0)-(a.wins||0) ||
    String(a.name).localeCompare(String(b.name))
  );

  $("big2Leaderboard").innerHTML=ps.map((p,i)=>`
    <div class="leaderRow">
      <span>${["🥇","🥈","🥉","4️⃣"][i]||i+1}</span>
      <span class="leaderName">${esc(p.animal)} ${esc(p.name)}</span>
      <strong>${p.points||0}分</strong>
      <span>${p.wins||0}勝</span>
    </div>`).join("");
}
function renderChat(msgs=[]){
  $("big2Chat").innerHTML=msgs.map(m=>`<div class="big2ChatMsg"><strong>${esc(m.animal)} ${esc(m.name)}</strong>：${esc(m.text)}</div>`).join("");
  $("big2Chat").scrollTop=$("big2Chat").scrollHeight;
}

function setSelectedType(type){
  selectedType = type || null;
  document.querySelectorAll(".typeBtn").forEach(
    b => b.classList.toggle("active", b.dataset.type===selectedType)
  );
}

function setPassReminder(on){
  $("big2Pass").classList.toggle("passReminder", !!on);
}

function requestPlayableCombos(type, {auto=false} = {}){
  socket.emit("big2Combos",{type},res=>{
    if(!res?.ok){
      if(auto){
        setPassReminder(true);
      }else{
        $("big2Msg").textContent=res?.message||"無該牌型組合";
      }
      return;
    }

    const combos = res.combos || [];
    if(!combos.length){
      if(auto){
        setPassReminder(true);
        $("big2Msg").textContent="沒有能壓過上一手的牌，請考慮 Pass";
      }else{
        $("big2Msg").textContent="無該牌型組合";
      }
      return;
    }

    setPassReminder(false);
    $("big2Msg").textContent="";
    pendingCombos=combos;
    comboOverlayOpenedByAuto=auto;
    showComboPreview(combos,type);
  });
}

function autoPreviewForCurrentTurn(){
  if(!state?.started){
    setPassReminder(false);
    return;
  }

  const current=state.players?.[state.turnIndex];
  if(current?.id!==socket.id){
    setPassReminder(false);
    return;
  }

  if(!state.lastPlay){
    setPassReminder(false);
    return;
  }

  const key=`${state.lastPlay.ts||""}|${state.lastPlay.playerId}|${state.turnIndex}|${socket.id}`;
  if(key===lastAutoPreviewKey) return;
  lastAutoPreviewKey=key;

  // 先檢查上一手同牌型，再檢查可以隨時出的鐵支、同花順。
  const candidates=[];
  if(state.lastPlay.type) candidates.push(state.lastPlay.type);
  if(!candidates.includes("fourkind")) candidates.push("fourkind");
  if(!candidates.includes("straightflush")) candidates.push("straightflush");

  let idx=0;

  function tryNext(){
    if(idx>=candidates.length){
      setSelectedType(null);
      setPassReminder(true);
      $("big2Msg").textContent="沒有可以壓過上一手的牌，請 Pass";
      return;
    }

    const type=candidates[idx++];

    socket.emit("big2Combos",{type},res=>{
      const combos=res?.ok ? (res.combos||[]) : [];

      if(!combos.length){
        tryNext();
        return;
      }

      setPassReminder(false);
      $("big2Msg").textContent="";

      // 單張只提醒有牌可出，仍由玩家雙擊手牌。
      if(type==="single"){
        setSelectedType(null);
        return;
      }

      setSelectedType(type);
      pendingCombos=combos;
      comboOverlayOpenedByAuto=true;
      showComboPreview(combos,type);
    });
  }

  tryNext();
}


function renderSettlement(){
  const overlay=$("big2SettlementOverlay");

  if(!state?.winnerId || !state?.scoreSummary){
    overlay.classList.add("hidden");
    return;
  }

  const summary=state.scoreSummary;
  const winner=state.players.find(p=>p.id===state.winnerId);

  $("settlementTitle").textContent=`${winner?.animal||"🏆"} ${winner?.name||"玩家"} 獲勝！`;
  $("settlementSubtitle").textContent=`本局獲得 +${summary.winnerGain||0} 分`;

  const detailMap=new Map((summary.details||[]).map(d=>[d.playerId,d]));

  $("settlementScores").innerHTML=state.players.map(p=>{
    const d=detailMap.get(p.id);
    const delta=d?.delta||0;
    const deltaText=delta>0?`+${delta}`:`${delta}`;

    let explain="";
    if(p.id===state.winnerId){
      explain=`其他玩家扣分總和轉入`;
    }else{
      const parts=[];
      if(d?.twos) parts.push(`2 × ${d.twos} = -${d.twos*5}`);
      if(d?.aces) parts.push(`A × ${d.aces} = -${d.aces*3}`);
      if(d?.others) parts.push(`其他 × ${d.others} = -${d.others}`);
      explain=parts.length?parts.join("、"):"無剩餘牌";
    }

    return `<div class="settlementScoreRow ${p.id===state.winnerId?"winner":""}">
      <div class="settlementPlayer">
        <span>${esc(p.animal)} ${esc(p.name)}</span>
        ${p.id===state.winnerId?'<span class="winnerTag">WIN</span>':""}
      </div>
      <div class="settlementExplain">${esc(explain)}</div>
      <strong class="${delta>=0?"positive":"negative"}">本局 ${deltaText}｜累積 ${p.points||0}</strong>
    </div>`;
  }).join("");

  const ranking=[...state.players].sort((a,b)=>
    (b.points||0)-(a.points||0) ||
    (b.wins||0)-(a.wins||0) ||
    String(a.name).localeCompare(String(b.name))
  );

  $("settlementRanking").innerHTML=ranking.map((p,i)=>`
    <div class="settlementRankRow ${p.id===socket.id?"me":""}">
      <span class="rankMedal">${["🥇","🥈","🥉","4️⃣"][i]||i+1}</span>
      <span class="rankPlayer">${esc(p.animal)} ${esc(p.name)}${p.id===socket.id?"（你）":""}</span>
      <strong>${p.points||0} 分</strong>
      <span>${p.wins||0} 勝</span>
    </div>`).join("");

  const isHost = state.hostId === socket.id;

  if (isHost) {
    $("settlementLeave").textContent = "結束遊戲";
    $("settlementLeave").disabled = false;
    $("settlementRematch").textContent = "再來一場";
    $("settlementRematch").disabled = false;
    $("settlementMsg").textContent = "你是房主，可以選擇結束遊戲或開始下一場。";
  } else {
    $("settlementLeave").textContent = "退出遊戲";
    $("settlementLeave").disabled = false;
    $("settlementRematch").textContent = "等待房主";
    $("settlementRematch").disabled = true;
    $("settlementMsg").textContent = "等待房主決定是否再來一場。";
  }

  overlay.classList.remove("hidden");
  lastSettlementTs=summary.ts||Date.now();
}

function closeSettlement(){
  $("big2SettlementOverlay").classList.add("hidden");
}


function render(){
  if(!state)return;
  $("big2Code").textContent=state.code;
  const cur=state.players[state.turnIndex];
  if(state.started){
    $("big2Status").textContent=`輪到：${cur?.animal||""} ${cur?.name||""}`;
  }else if(state.winnerId){
    const winner=state.players.find(p=>p.id===state.winnerId);
    const gain=state.scoreSummary?.winnerGain||0;
    $("big2Status").textContent=`本局結束：${winner?.animal||""} ${winner?.name||"玩家"} 勝利，+${gain} 分`;
  }else{
    $("big2Status").textContent=`等待開始，目前 ${state.players.length} 人`;
  }
  $("big2HostBox").classList.toggle("hidden",state.started||state.hostId!==socket.id);
  renderSeats();renderStack();renderHistory();renderLeaderboard();renderChat(state.chat||[]);
  autoPreviewForCurrentTurn();
  renderSettlement();
}

socket.on("yourHand",cards=>{if(state?.gameType==="big2"||location.pathname.includes("big2")){hand=cards;selected=new Set([...selected].filter(i=>i<hand.length));renderHand()}});
socket.on("roomState",s=>{if(s.gameType!=="big2")return;state=s;render()});
socket.on("big2RematchStarted",()=>{
  closeSettlement();
  selected.clear();
  setSelectedType(null);
  setPassReminder(false);
  comboOverlayOpenedByAuto=false;
  lastAutoPreviewKey="";
});
socket.on("sessionEnded",()=>{
  location.href="/";
});
socket.on("chatMessage",m=>{if(!state)return;state.chat=[...(state.chat||[]),m].slice(-30);renderChat(state.chat)});

$("big2ChatSend").onclick=sendChat;
$("big2ChatInput").onkeydown=e=>{if(e.key==="Enter"){e.preventDefault();sendChat()}};
function sendChat(){const text=$("big2ChatInput").value.trim();if(!text)return;socket.emit("sendChat",{message:text},r=>{if(r?.ok)$("big2ChatInput").value=""})}

$("big2Play").onclick=()=>{
  if(!selectedType){
    $("big2Msg").textContent="請先選擇牌型；單張請直接雙擊手牌";
    return;
  }
  requestPlayableCombos(selectedType,{auto:false});
};
function submitPlay(indices,type){
  socket.emit("big2Play",{indices,type},res=>{
    if(!res?.ok){
      $("big2Msg").textContent=res?.message||"出牌失敗";
      return;
    }
    selected.clear();
    setSelectedType(null);
    setPassReminder(false);
    comboOverlayOpenedByAuto=false;
    $("big2Msg").textContent="";
  });
}
function showComboPreview(combos,type){
  $("comboOptions").innerHTML=combos.map((c,i)=>`
    <div class="comboOption" data-i="${i}">
      <strong>${typeLabel(type)} 組合 ${i+1}</strong>
      <div class="comboPreview">
        ${c.cards.map(x=>`<div class="miniCard ${red(x)?"red":""}"><span class="miniSuit">${x.suit}</span><span class="miniRank">${x.rank}</span></div>`).join("")}
      </div>
    </div>`).join("");

  document.querySelectorAll(".comboOption").forEach(el=>el.onclick=()=>{
    const c=pendingCombos[+el.dataset.i];
    $("comboOverlay").classList.add("hidden");
    submitPlay(c.indices,type);
  });

  $("comboOverlay").classList.remove("hidden");
}
$("comboCancel").onclick=()=>{
  $("comboOverlay").classList.add("hidden");
  comboOverlayOpenedByAuto=false;
};

// 點預覽視窗外的半透明背景即可關閉，不必捲到底按取消。
$("comboOverlay").addEventListener("click",e=>{
  if(e.target===$("comboOverlay")){
    $("comboOverlay").classList.add("hidden");
    comboOverlayOpenedByAuto=false;
  }
});

function typeLabel(t){return ({single:"單張",pair:"對子",straight:"順子",fullhouse:"葫蘆",fourkind:"鐵支",straightflush:"同花順"}[t]||t)}
function esc(s){return String(s??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")}

// V5.15：大老二回合 10 秒倒數顯示
