const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 64 * 1024,
  pingTimeout: 20000,
  pingInterval: 25000
});

app.disable("x-powered-by");

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use((req, res, next) => {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

app.use(express.json({ limit: "16kb" }));

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const securityState = {
  socketActions: new Map(),
  joinFailures: new Map()
};

function safeText(value, maxLength = 32) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[<>]/g, "")
    .trim()
    .slice(0, maxLength);
}

function safeRoomCode(value) {
  return String(value ?? "").replace(/\D/g, "").slice(0, 3);
}

function safeInteger(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function allowSocketAction(socket, key, limit = 8, windowMs = 3000) {
  const now = Date.now();
  const id = `${socket.id}:${key}`;
  const previous = securityState.socketActions.get(id) || [];
  const recent = previous.filter(ts => now - ts < windowMs);

  if (recent.length >= limit) {
    securityState.socketActions.set(id, recent);
    return false;
  }

  recent.push(now);
  securityState.socketActions.set(id, recent);
  return true;
}

function joinAttemptKey(socket) {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  return String(forwarded || socket.handshake.address || "unknown")
    .split(",")[0]
    .trim();
}

function canAttemptJoin(socket) {
  const key = joinAttemptKey(socket);
  const now = Date.now();
  const state = securityState.joinFailures.get(key);

  if (!state) return true;
  if (state.lockedUntil && now < state.lockedUntil) return false;

  if (state.lockedUntil && now >= state.lockedUntil) {
    securityState.joinFailures.delete(key);
  }

  return true;
}

function recordJoinFailure(socket) {
  const key = joinAttemptKey(socket);
  const now = Date.now();
  const state = securityState.joinFailures.get(key) || {
    count: 0,
    firstAt: now,
    lockedUntil: 0
  };

  if (now - state.firstAt > 60_000) {
    state.count = 0;
    state.firstAt = now;
  }

  state.count += 1;

  if (state.count >= 8) {
    state.lockedUntil = now + 30_000;
  }

  securityState.joinFailures.set(key, state);
}

function clearJoinFailures(socket) {
  securityState.joinFailures.delete(joinAttemptKey(socket));
}



function makeDeck() {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];
  for (const suit of suits) {
    for (const rank of ranks) deck.push({ suit, rank });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];

  // V5.15：使用 Node.js crypto.randomInt 做 Fisher-Yates 洗牌。
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }

  return a;
}

function newRoom(code, gameType = "liar") {
  return {
    code,
    gameType,
    players: [],
    started: false,
    turnIndex: 0,
    pile: [],
    lastPlay: null,
    roundRank: null,
    winnerId: null,
    matchRecorded: false,
    log: [],
    chat: [],
    liarRoundCount: 0,
    liarRoundLimit: 20,
  };
}

function roomPublicState(room) {
  return {
    code: room.code,
    gameType: room.gameType || "liar",
    hostId: room.players[0]?.id || null,
    started: room.started,
    turnIndex: room.turnIndex,
    pileCount: room.pile.length,
    roundRank: room.roundRank,
    tableCards: room.pile.map(() => ({ hidden: true })),
    // 由伺服器明確指定目前唯一可以抓吹牛的玩家
winnerId: room.winnerId,
    liarRoundCount: room.gameType === "liar" ? (room.liarRoundCount || 0) : 0,
    liarRoundLimit: room.gameType === "liar" ? (room.liarRoundLimit || 20) : 0,
    challengePlayerId: null,
    canChallenge: room.gameType === "liar" && room.started === true && !!room.lastPlay,
lastPlay: room.lastPlay ? (
      room.gameType === "big2"
        ? {
            playerId: room.lastPlay.playerId,
            playerName: room.lastPlay.playerName,
            type: room.lastPlay.type,
            cards: room.lastPlay.cards,
            ts: room.lastPlay.ts
          }
        : {
            playerId: room.lastPlay.playerId,
            playerName: room.lastPlay.playerName,
            claimRank: room.lastPlay.claimRank,
            count: room.lastPlay.cards.length
          }
    ) : null,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      animal: p.animal,
      wins: p.wins || 0,
      losses: p.losses || 0,
      points: p.points || 0,
      cardCount: p.hand.length,
      isTurn: room.started && i === room.turnIndex,
      isWinner: p.id === room.winnerId
    })),
    log: room.log.slice(-12),
    chat: room.chat.slice(-30),
    tablePlays: (room.tablePlays || []).slice(-6),
    history: (room.history || []).slice(-40),
    scoreSummary: room.scoreSummary || null
  };
}

function emitRoom(room) {
  io.to(room.code).emit("roomState", roomPublicState(room));
  for (const p of room.players) {
    io.to(p.id).emit("yourHand", p.hand);
  }
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

function nextTurn(room) {
  if (!room.players.length) return;
  room.turnIndex = (room.turnIndex + 1) % room.players.length;
}

function cleanName(name) {
  return safeText(name, 16);
}

function generateRandomName(room = null) {
  // 三位數字暱稱，例：玩家472；加入既有房間時避免撞名
  for (let i = 0; i < 30; i++) {
    const candidate = `玩家${Math.floor(100 + Math.random() * 900)}`;
    if (!room || !room.players.some(p => p.name === candidate)) return candidate;
  }
  return `玩家${Date.now().toString().slice(-4)}`;
}

function cleanAnimal(animal) {
  const allowed = ["🐶","🐱","🐰","🦊","🐼","🐯","🐸","🐵"];
  return allowed.includes(animal) ? animal : "🐶";
}

function cleanCode(code) {
  return safeRoomCode(code);
}


function dealStartingCards(room) {
  const deck = makeDeck();

  room.players.forEach(p => {
    p.hand = [];
  });

  // V5.20：從房主開始，一張一張輪流發，直到 52 張全部發完。
  let receiverIndex = 0;
  while (deck.length > 0) {
    const card = deck.pop();
    room.players[receiverIndex].hand.push(card);
    receiverIndex = (receiverIndex + 1) % room.players.length;
  }

  room.started = true;
  room.winnerId = null;
  room.turnIndex = 0;
  room.pile = [];
  room.lastPlay = null;
  room.roundRank = null;

  // 發牌完成後，立即檢查每位玩家是否有四張同點數。
  discardAllPlayersFourOfAKind(room, "deal");
}











function discardFourOfAKindFromHand(room, player, reason = "auto") {
  if (!room || !player || !Array.isArray(player.hand)) return [];

  const rankGroups = new Map();

  player.hand.forEach((card, index) => {
    if (!rankGroups.has(card.rank)) rankGroups.set(card.rank, []);
    rankGroups.get(card.rank).push(index);
  });

  const sets = [...rankGroups.entries()]
    .filter(([, indices]) => indices.length === 4)
    .map(([rank, indices]) => ({
      rank,
      indices: [...indices].sort((a, b) => b - a)
    }));

  const discardedSets = [];

  for (const set of sets) {
    const cards = [];

    for (const index of set.indices) {
      const [card] = player.hand.splice(index, 1);
      if (card) cards.push(card);
    }

    cards.reverse();

    if (cards.length === 4) {
      discardedSets.push({
        rank: set.rank,
        cards
      });

      room.log.push(
        `✨ ${player.name} 湊齊四張 ${set.rank}，系統自動丟棄！`
      );

      // 只給該玩家播放丟棄動畫與提示。
      io.to(player.id).emit("liarAutoDiscard", {
        rank: set.rank,
        cards,
        remaining: player.hand.length,
        reason
      });

      // 立即同步該玩家的新手牌。
      io.to(player.id).emit("yourHand", player.hand);
    }
  }

  return discardedSets;
}

function discardAllPlayersFourOfAKind(room, reason = "deal") {
  if (!room) return [];

  const result = [];

  for (const player of room.players) {
    const discarded = discardFourOfAKindFromHand(room, player, reason);
    if (discarded.length) {
      result.push({
        playerId: player.id,
        discarded
      });
    }
  }

  return result;
}

function finishLiarByRoundLimit(room) {
  if (!room || room.gameType !== "liar" || !room.started) return false;
  if ((room.liarRoundCount || 0) < (room.liarRoundLimit || 20)) return false;

  // 若有人已經把牌出完，先保留抓吹牛／不抓的正常勝負流程。
  if (room.players.some(p => p.hand.length === 0)) {
    return false;
  }

  let winner = room.players[0] || null;

  for (const player of room.players) {
    if (!winner || player.hand.length < winner.hand.length) {
      winner = player;
    }
  }

  if (!winner) return false;

  room.winnerId = winner.id;
  room.started = false;

  room.log.push(
    `🏁 ${room.liarRoundLimit || 20} 回合結束！${winner.name} 以最少手牌（${winner.hand.length} 張）獲勝`
  );

  recordMatchResult(room, winner.id);
  return true;
}

function recordMatchResult(room, winnerId) {
  if (room.matchRecorded) return;
  const winner = room.players.find(p => p.id === winnerId);
  if (!winner) return;

  winner.wins = (winner.wins || 0) + 1;
  for (const p of room.players) {
    if (p.id !== winnerId) p.losses = (p.losses || 0) + 1;
  }
  room.matchRecorded = true;
}


const BIG2_RANK = { "3":0,"4":1,"5":2,"6":3,"7":4,"8":5,"9":6,"10":7,"J":8,"Q":9,"K":10,"A":11,"2":12 };
const BIG2_SUIT = { "♣":0,"♦":1,"♥":2,"♠":3 };

function big2CardValue(c){ return BIG2_RANK[c.rank]*4 + BIG2_SUIT[c.suit]; }
function big2Sort(cards){ return [...cards].sort((a,b)=>big2CardValue(a)-big2CardValue(b)); }
function big2Deal(room){

  const deck = makeDeck();

  // 積分與勝場跨場保留，只清空手牌。
  room.players.forEach(p => {
    if (!Number.isFinite(p.points)) p.points = 0;
    if (!Number.isFinite(p.wins)) p.wins = 0;
    p.hand = [];
  });

  // 從房主（players[0]）開始，一張一張輪流發，
  // 直到 52 張全部發完，不保留任何底牌。
  let receiverIndex = 0;
  while (deck.length > 0) {
    const card = deck.pop();
    room.players[receiverIndex].hand.push(card);
    receiverIndex = (receiverIndex + 1) % room.players.length;
  }

  room.players.forEach(p => p.hand = big2Sort(p.hand));

  room.started = true;
  room.turnIndex = 0;
  room.lastPlay = null;
  room.tablePlays = [];
  room.history = [];
  room.passCount = 0;
  room.winnerId = null;
  room.matchRecorded = false;
  room.scoreSummary = null;

  // 大老二首手仍由持有梅花 3 的玩家先出。
  const starter = room.players.findIndex(
    p => p.hand.some(c => c.rank === "3" && c.suit === "♣")
  );
  room.turnIndex = starter >= 0 ? starter : 0;


}
function big2Groups(cards){
  const m=new Map();
  cards.forEach((c,i)=>{if(!m.has(c.rank))m.set(c.rank,[]);m.get(c.rank).push({c,i})});
  return m;
}
function comb(arr,k){
  const out=[];
  function rec(start,p){if(p.length===k){out.push([...p]);return}for(let i=start;i<arr.length;i++){p.push(arr[i]);rec(i+1,p);p.pop()}}
  rec(0,[]);return out;
}
function big2FindCombos(hand,type){
  const groups=big2Groups(hand), out=[];

  if(type==="single"){
    for(let i=0;i<hand.length;i++) out.push([i]);
  }
  if(type==="pair"){
    for(const g of groups.values()) for(const pair of comb(g,2)) out.push(pair.map(x=>x.i));
  }
  if(type==="fullhouse"){
    const triples=[...groups.values()].filter(g=>g.length>=3), pairs=[...groups.values()].filter(g=>g.length>=2);
    for(const t of triples) for(const p of pairs) if(t[0].c.rank!==p[0].c.rank)
      for(const a of comb(t,3)) for(const b of comb(p,2)) out.push([...a,...b].map(x=>x.i));
  }
  if(type==="fourkind"){
    const fours=[...groups.values()].filter(g=>g.length===4);
    for(const f of fours){
      const fi=f.map(x=>x.i);
      for(let i=0;i<hand.length;i++) if(!fi.includes(i)) out.push([...fi,i]);
    }
  }
  if(type==="straight"){
    const indexed=hand.map((c,i)=>({c,i}));
    for(const five of comb(indexed,5)){
      const vals=five.map(x=>BIG2_RANK[x.c.rank]).sort((a,b)=>a-b);
      const unique=new Set(vals).size===5;
      if(unique && vals.every((v,i)=>i===0||v===vals[i-1]+1)) {
        out.push(five.map(x=>x.i));
      }
    }
  }
  if(type==="straightflush"){
    for(const suit of Object.keys(BIG2_SUIT)){
      const suited=hand.map((c,i)=>({c,i})).filter(x=>x.c.suit===suit);
      for(const five of comb(suited,5)){
        const vals=five.map(x=>BIG2_RANK[x.c.rank]).sort((a,b)=>a-b);
        const unique=new Set(vals).size===5;
        if(unique && vals.every((v,i)=>i===0||v===vals[i-1]+1)) out.push(five.map(x=>x.i));
      }
    }
  }
  return out;
}
function big2Classify(cards,type){
  cards=big2Sort(cards);
  if(type==="single"&&cards.length===1)return {ok:true,type,score:big2CardValue(cards[0])};
  if(type==="pair"&&cards.length===2&&cards[0].rank===cards[1].rank)return {ok:true,type,score:Math.max(...cards.map(big2CardValue))};
  if(type==="straight"&&cards.length===5){
    const vals=cards.map(c=>BIG2_RANK[c.rank]).sort((a,b)=>a-b);
    const unique=new Set(vals).size===5;
    if(unique && vals.every((v,i)=>i===0||v===vals[i-1]+1)){
      const highestRank=vals.at(-1);
      const highCards=cards.filter(c=>BIG2_RANK[c.rank]===highestRank);
      const highSuit=Math.max(...highCards.map(c=>BIG2_SUIT[c.suit]));
      return {ok:true,type,score:highestRank*4+highSuit};
    }
  }
  if(type==="fullhouse"&&cards.length===5){
    const counts=[...big2Groups(cards).values()].map(g=>g.length).sort().join(",");
    if(counts==="2,3"){
      const triple=[...big2Groups(cards).values()].find(g=>g.length===3);
      return {ok:true,type,score:BIG2_RANK[triple[0].c.rank]};
    }
  }
  if(type==="fourkind"&&cards.length===5){
    const four=[...big2Groups(cards).values()].find(g=>g.length===4);
    if(four)return {ok:true,type,score:BIG2_RANK[four[0].c.rank]};
  }
  if(type==="straightflush"&&cards.length===5){
    const same=cards.every(c=>c.suit===cards[0].suit);
    const vals=cards.map(c=>BIG2_RANK[c.rank]).sort((a,b)=>a-b);
    const unique=new Set(vals).size===5;
    if(same&&unique&&vals.every((v,i)=>i===0||v===vals[i-1]+1))return {ok:true,type,score:vals.at(-1)*4+BIG2_SUIT[cards[0].suit]};
  }
  return {ok:false};
}
const BIG2_TYPE_POWER={single:0,pair:1,straight:2,fullhouse:3,fourkind:4,straightflush:5};


function big2PenaltyForHand(hand){
  let penalty = 0;
  let twos = 0;
  let aces = 0;
  let others = 0;

  for(const card of hand){
    if(card.rank === "2"){
      penalty += 5;
      twos += 1;
    }else if(card.rank === "A"){
      penalty += 3;
      aces += 1;
    }else{
      penalty += 1;
      others += 1;
    }
  }

  return { penalty, twos, aces, others };
}

function big2RecordScore(room, winnerId){
  if(room.matchRecorded) return;

  const winner = room.players.find(p=>p.id===winnerId);
  if(!winner) return;

  let winnerGain = 0;
  const details = [];

  for(const p of room.players){
    if(!Number.isFinite(p.points)) p.points = 0;

    if(p.id === winnerId) continue;

    const result = big2PenaltyForHand(p.hand);
    p.points -= result.penalty;
    winnerGain += result.penalty;

    details.push({
      playerId: p.id,
      playerName: p.name,
      delta: -result.penalty,
      remainingCards: p.hand.length,
      twos: result.twos,
      aces: result.aces,
      others: result.others,
      totalPointsAfter: p.points
    });
  }

  winner.points = (winner.points || 0) + winnerGain;
  winner.wins = (winner.wins || 0) + 1;

  details.push({
    playerId: winner.id,
    playerName: winner.name,
    delta: winnerGain,
    remainingCards: 0,
    twos: 0,
    aces: 0,
    others: 0,
    totalPointsAfter: winner.points
  });

  room.scoreSummary = {
    winnerId: winner.id,
    winnerName: winner.name,
    winnerGain,
    details,
    ts: Date.now()
  };

  room.matchRecorded = true;
}

function big2CanBeat(play,last){
  if(!last) return true;

  const bombPower = {
    fourkind: 1,
    straightflush: 2
  };

  const playBomb = bombPower[play.type] || 0;
  const lastBomb = bombPower[last.type] || 0;

  // 鐵支、同花順可以直接壓任何一般牌型。
  if(playBomb && !lastBomb) return true;

  // 一般牌無法反壓炸彈。
  if(!playBomb && lastBomb) return false;

  // 炸彈對炸彈：同花順 > 鐵支。
  if(playBomb && lastBomb && play.type !== last.type){
    return playBomb > lastBomb;
  }

  // 相同牌型比大小。
  if(play.type !== last.type) return false;
  return play.score > last.score;
}


const MAINTENANCE_PASSWORD = process.env.MAINTENANCE_PASSWORD || "321";
const MAINTENANCE_FILE = path.join(__dirname, "maintenance-log.json");

const DEFAULT_MAINTENANCE_ENTRIES = [
  {
    version: "V5.36",
    date: "2026/08/24",
    content: "大老二新增玩家框旁的獨立剩餘牌數小框；其餘遊戲畫面與功能維持不變。"
  }
];

function readMaintenanceEntries() {
  try {
    if (!fs.existsSync(MAINTENANCE_FILE)) {
      fs.writeFileSync(
        MAINTENANCE_FILE,
        JSON.stringify(DEFAULT_MAINTENANCE_ENTRIES, null, 2),
        "utf8"
      );
      return [...DEFAULT_MAINTENANCE_ENTRIES];
    }

    const parsed = JSON.parse(fs.readFileSync(MAINTENANCE_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.slice(0, 1) : [...DEFAULT_MAINTENANCE_ENTRIES];
  } catch (err) {
    console.error("Maintenance log read error:", err?.message || err);
    return [...DEFAULT_MAINTENANCE_ENTRIES];
  }
}

function writeMaintenanceEntries(entries) {
  fs.writeFileSync(
    MAINTENANCE_FILE,
    JSON.stringify(entries.slice(0, 1), null, 2),
    "utf8"
  );
}

app.get("/api/maintenance", (req, res) => {
  res.json({
    ok: true,
    entries: readMaintenanceEntries()
  });
});

app.post("/api/maintenance", (req, res) => {
  const password = String(req.body?.password ?? "");
  const version = safeText(req.body?.version, 16);
  const date = safeText(req.body?.date, 10);
  const content = safeText(req.body?.content, 240);

  if (password !== MAINTENANCE_PASSWORD) {
    return res.status(401).json({
      ok: false,
      message: "密碼錯誤"
    });
  }

  if (!version) {
    return res.status(400).json({
      ok: false,
      message: "請輸入版本編號"
    });
  }

  if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) {
    return res.status(400).json({
      ok: false,
      message: "日期格式必須是 YYYY/MM/DD"
    });
  }

  if (!content) {
    return res.status(400).json({
      ok: false,
      message: "請輸入維修內容"
    });
  }

  const entries = [{ version, date, content }];
  writeMaintenanceEntries(entries);

  res.json({
    ok: true,
    entries
  });
});


io.on("connection", socket => {
  socket.on("createRoom", ({ name, animal, gameType = "liar", roundLimit = 20 }, cb) => {
    if (!allowSocketAction(socket, "createRoom", 3, 10000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    name = cleanName(name);
    animal = cleanAnimal(animal);
    if (!name) name = generateRandomName();

    let code;
    do code = String(crypto.randomInt(100, 1000));
    while (rooms.has(code));

    gameType = gameType === "big2" ? "big2" : "liar";
    const room = newRoom(code, gameType);
    if (gameType === "liar") {
      room.liarRoundLimit = safeInteger(roundLimit, 1, 200, 20);
    }
    room.players.push({ id: socket.id, name, animal, hand: [], wins: 0, losses: 0, points: 0 });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    room.log.push(`${name} 建立了房間`);
    emitRoom(room);
    cb?.({ ok: true, code, name, gameType: room.gameType });
  });

  socket.on("joinRoom", ({ name, code, animal }, cb) => {
    if (!canAttemptJoin(socket)) {
      return cb?.({ ok: false, message: "房號嘗試次數過多，請 30 秒後再試" });
    }

    if (!allowSocketAction(socket, "joinRoom", 6, 10000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    name = cleanName(name);
    animal = cleanAnimal(animal);
    code = cleanCode(code);
    const room = rooms.get(code);

    if (!room) {
      recordJoinFailure(socket);
      return cb?.({ ok: false, message: "找不到這個房間" });
    }

    clearJoinFailures(socket);
    if (!name) name = generateRandomName(room);
    if (room.started) return cb?.({ ok: false, message: "遊戲已開始" });
    if (room.players.length >= 4) return cb?.({ ok: false, message: "房間已滿（最多 4 人）" });

    room.players.push({ id: socket.id, name, animal, hand: [], wins: 0, losses: 0, points: 0 });
    socket.join(code);
    socket.data.roomCode = code;
    room.log.push(`${name} 加入了房間`);
    emitRoom(room);
    cb?.({ ok: true, code, name, gameType: room.gameType });
  });

  socket.on("sendChat", ({ message }, cb) => {
    if (!allowSocketAction(socket, "sendChat", 5, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, message: "你目前不在房間內" });

    const player = getPlayer(room, socket.id);
    if (!player) return cb?.({ ok: false, message: "找不到玩家資料" });

    const now = Date.now();
    if (socket.data.lastChatAt && now - socket.data.lastChatAt < 400) {
      return cb?.({ ok: false, message: "訊息傳送太快了" });
    }

    message = safeText(String(message || "").replace(/\s+/g, " "), 120);
    if (!message) return cb?.({ ok: false, message: "請輸入訊息" });

    socket.data.lastChatAt = now;

    const chatMessage = {
      id: `${now}-${socket.id.slice(0, 6)}`,
      playerId: player.id,
      name: player.name,
      animal: player.animal,
      text: message,
      ts: now
    };

    room.chat.push(chatMessage);
    if (room.chat.length > 30) room.chat.splice(0, room.chat.length - 30);

    io.to(room.code).emit("chatMessage", chatMessage);
    cb?.({ ok: true });
  });


  socket.on("big2Start", (_, cb) => {
    const room=rooms.get(socket.data.roomCode);
    if(!room||room.gameType!=="big2")return cb?.({ok:false,message:"這不是大老二房間"});
    if(room.players[0]?.id!==socket.id)return cb?.({ok:false,message:"只有房主可以開始"});
    if(room.players.length<2)return cb?.({ok:false,message:"至少需要 2 人"});
    big2Deal(room); emitRoom(room); cb?.({ok:true});
  });

  socket.on("big2Combos", ({type}, cb) => {
    if (!allowSocketAction(socket, "big2Combos", 10, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room=rooms.get(socket.data.roomCode), player=room&&getPlayer(room,socket.id);
    if(!room||room.gameType!=="big2"||!player){
      return cb?.({ok:false,message:"房間狀態錯誤"});
    }

    if(!room.started){
      return cb?.({ok:false,message:"遊戲尚未開始"});
    }

    if(currentPlayer(room)?.id!==socket.id){
      return cb?.({ok:false,message:"還沒輪到你"});
    }

    const raw = big2FindCombos(player.hand,type);
    const combos = [];

    for(const indices of raw){
      const cards = indices.map(i=>player.hand[i]);
      const info = big2Classify(cards,type);
      if(!info.ok) continue;

      // 第一手必須含梅花 3
      if(!room.history.length && !cards.some(c=>c.rank==="3"&&c.suit==="♣")){
        continue;
      }

      // 只預覽真正能壓過上一手的組合
      if(!big2CanBeat(info,room.lastPlay)){
        continue;
      }

      combos.push({
        indices,
        cards,
        score: info.score
      });

      if(combos.length>=24) break;
    }

    cb?.({ok:true,combos});
  });

  socket.on("big2Play", ({indices,type}, cb) => {
    if (!allowSocketAction(socket, "big2Play", 8, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room=rooms.get(socket.data.roomCode);
    if(!room||room.gameType!=="big2"||!room.started)return cb?.({ok:false,message:"遊戲尚未開始"});
    const player=getPlayer(room,socket.id);
    if(currentPlayer(room)?.id!==socket.id)return cb?.({ok:false,message:"還沒輪到你"});
    const uniq=[...new Set((indices||[]).map(Number))].filter(i=>Number.isInteger(i)&&i>=0&&i<player.hand.length).sort((a,b)=>a-b);
    const cards=uniq.map(i=>player.hand[i]);
    const info=big2Classify(cards,type);
    if(!info.ok)return cb?.({ok:false,message:"這組牌不符合所選牌型"});
    if(!big2CanBeat(info,room.lastPlay))return cb?.({ok:false,message:"必須用相同牌型且比上一手大"});
    // 首手需含梅花3
    if(!room.history.length&&!cards.some(c=>c.rank==="3"&&c.suit==="♣"))return cb?.({ok:false,message:"第一手必須包含梅花 3"});
    for(const i of [...uniq].sort((a,b)=>b-a))player.hand.splice(i,1);
    const play={playerId:player.id,playerName:player.name,type,cards:big2Sort(cards),score:info.score,ts:Date.now()};
    room.lastPlay=play; room.tablePlays.push(play); room.history.push(play); room.passCount=0;
    if(player.hand.length===0){
      // 只要任何一位玩家出完牌，本局立刻結束並結算積分。
      room.winnerId = player.id;
      room.started = false;

      big2RecordScore(room, player.id);
    }else{
      nextTurn(room);

    }

    emitRoom(room);
    cb?.({ok:true});
  });

  socket.on("big2Rematch", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.gameType !== "big2") {
      return cb?.({ ok: false, message: "這不是大老二房間" });
    }

    if (room.players[0]?.id !== socket.id) {
      return cb?.({ ok: false, message: "只有房主可以開始下一場" });
    }

    if (room.started) {
      return cb?.({ ok: false, message: "目前牌局尚未結束" });
    }

    if (!room.winnerId) {
      return cb?.({ ok: false, message: "目前沒有已完成的牌局" });
    }

    if (room.players.length < 2) {
      return cb?.({ ok: false, message: "至少需要 2 位玩家" });
    }

    big2Deal(room);
    io.to(room.code).emit("big2RematchStarted");
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("big2EndSession", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.gameType !== "big2") {
      return cb?.({ ok: false, message: "這不是大老二房間" });
    }

    if (room.players[0]?.id !== socket.id) {
      return cb?.({ ok: false, message: "只有房主可以結束遊戲" });
    }

    io.to(room.code).emit("sessionEnded");

    for (const player of room.players) {
      const playerSocket = io.sockets.sockets.get(player.id);

      if (playerSocket) {
        playerSocket.leave(room.code);
        playerSocket.data.roomCode = null;
      }
    }

    rooms.delete(room.code);
    cb?.({ ok: true });
  });

  socket.on("big2Pass", (_, cb) => {
    if (!allowSocketAction(socket, "big2Pass", 5, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.gameType !== "big2" || !room.started) {
      return cb?.({ ok: false, message: "遊戲尚未開始" });
    }

    if (currentPlayer(room)?.id !== socket.id) {
      return cb?.({ ok: false, message: "還沒輪到你" });
    }

    if (!room.lastPlay) {
      return cb?.({ ok: false, message: "目前是新一輪，不能 Pass" });
    }

    room.passCount = (room.passCount || 0) + 1;
    nextTurn(room);

    if (room.passCount >= room.players.length - 1) {
      const lastId = room.lastPlay.playerId;
      room.lastPlay = null;
      room.tablePlays = [];
      room.passCount = 0;

      const idx = room.players.findIndex(p => p.id === lastId);
      if (idx >= 0) room.turnIndex = idx;
    }

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("startGame", (_, cb) => {
    if (!allowSocketAction(socket, "startGame", 3, 5000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.gameType !== "liar") return cb?.({ ok: false, message: "這不是吹牛房間" });
    if (room.players[0]?.id !== socket.id) return cb?.({ ok: false, message: "只有房主可以開始" });
    if (room.players.length < 2) return cb?.({ ok: false, message: "至少需要 2 人" });

    dealStartingCards(room);
    room.liarRoundCount = 0;

    const autoDiscardWinner = room.players.find(p => p.hand.length === 0);
    if (autoDiscardWinner) {
      room.winnerId = autoDiscardWinner.id;
      room.started = false;
      recordMatchResult(room, autoDiscardWinner.id);
      room.log.push(`🎉 ${autoDiscardWinner.name} 因自動丟棄後手牌歸零，獲勝！`);
    }

    // V5.11：從房主按下「開始遊戲」這次事件開始計算整整 5 分鐘。
    room.matchRecorded = false;
    room.log = ["遊戲開始！"];
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("playCards", ({ indices, claimRank }, cb) => {
    if (!allowSocketAction(socket, "playCards", 8, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.gameType !== "liar" || !room.started) return;
    const player = getPlayer(room, socket.id);
    if (!player || currentPlayer(room)?.id !== socket.id) {
      return cb?.({ ok: false, message: "還沒輪到你" });
    }

    const uniq = [...new Set((indices || []).map(Number))]
      .filter(i => Number.isInteger(i) && i >= 0 && i < player.hand.length)
      .sort((a,b) => b-a);

    const validRanks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
    if (!uniq.length) return cb?.({ ok: false, message: "至少要選 1 張牌" });

    // 第一手決定本輪點數；之後只能沿用同一個宣稱點數
    if (!room.roundRank) {
      if (!validRanks.includes(claimRank)) {
        return cb?.({ ok: false, message: "請選擇本輪點數" });
      }
      room.roundRank = claimRank;
    } else {
      claimRank = room.roundRank;
    }

    const cards = [];
    for (const idx of uniq) cards.push(player.hand.splice(idx, 1)[0]);
    cards.reverse();

    room.pile.push(...cards);
    room.lastPlay = {
      playerId: player.id,
      playerName: player.name,
      claimRank,
      cards
    };

    // 每一次成功出牌算一回合
    room.liarRoundCount = (room.liarRoundCount || 0) + 1;

    room.log.push(`${player.name} 出了 ${cards.length} 張，宣稱都是 ${claimRank}`);

    if (!finishLiarByRoundLimit(room)) {
      nextTurn(room);
    }

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("challenge", (_, cb) => {
    if (!allowSocketAction(socket, "challenge", 5, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room = rooms.get(socket.data.roomCode);

    // V5.13：抓吹牛不看回合、不看上家、不看 turnIndex。
    // 只要牌局進行中且存在上一手，除了剛出牌本人，其餘房內玩家都能抓。
    if (!room || room.gameType !== "liar" || !room.started || !room.lastPlay) {
      return cb?.({ ok: false, message: "目前沒有可以抓的上一手" });
    }

    const challenger = getPlayer(room, socket.id);
    if (!challenger) {
      return cb?.({ ok: false, message: "你目前不在這個房間" });
    }

    if (room.lastPlay.playerId === socket.id) {
      return cb?.({ ok: false, message: "不能抓自己剛出的牌" });
    }

    const revealedCards = room.lastPlay.cards.map(card => ({ suit: card.suit, rank: card.rank }));
    const liar = room.lastPlay.cards.some(card => card.rank !== room.lastPlay.claimRank);
    const accused = getPlayer(room, room.lastPlay.playerId);
    const challengedPileCount = room.pile.length;

    if (liar) {
      accused.hand.push(...room.pile);
      discardFourOfAKindFromHand(room, accused, "challenge");
      room.log.push(`抓到了！${accused.name} 吹牛，收下桌面 ${room.pile.length} 張牌`);
      room.turnIndex = room.players.findIndex(p => p.id === challenger.id);

      io.to(room.code).emit("challengeResult", {
        success: true,
        challengerName: challenger.name,
        accusedName: accused.name,
        loserName: accused.name,
        pileCount: challengedPileCount,
        claimRank: room.lastPlay.claimRank,
        revealedCards
      });
    } else {
      challenger.hand.push(...room.pile);
      discardFourOfAKindFromHand(room, challenger, "challenge");
      room.log.push(`抓錯了！${accused.name} 沒吹牛，${challenger.name} 收下桌面 ${room.pile.length} 張牌`);
      room.turnIndex = room.players.findIndex(p => p.id === accused.id);
      nextTurn(room);

      io.to(room.code).emit("challengeResult", {
        success: false,
        challengerName: challenger.name,
        accusedName: accused.name,
        loserName: challenger.name,
        pileCount: challengedPileCount,
        claimRank: room.lastPlay.claimRank,
        revealedCards
      });
    }

    room.pile = [];
    room.lastPlay = null;
    // 抓吹牛判定完成後，解除本輪點數鎖定
    room.roundRank = null;

    // 抓牌結算後，若有人沒牌，才正式獲勝
    const winner = room.players.find(p => p.hand.length === 0);
    if (winner) {
      room.winnerId = winner.id;
      room.started = false;

      recordMatchResult(room, winner.id);
      room.log.push(`🎉 ${winner.name} 獲勝！`);
    }

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("passChallenge", (_, cb) => {
    if (!allowSocketAction(socket, "passChallenge", 5, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
    const player = getPlayer(room, socket.id);
    if (!player || currentPlayer(room)?.id !== socket.id) {
      return cb?.({ ok: false, message: "還沒輪到你" });
    }

    // 如果上一手玩家已出完手牌，且你選擇不抓，上一手玩家獲勝
    if (room.lastPlay) {
      const prev = getPlayer(room, room.lastPlay.playerId);
      if (prev && prev.hand.length === 0) {
        room.winnerId = prev.id;
        room.started = false;

        recordMatchResult(room, prev.id);
        room.log.push(`🎉 ${prev.name} 出完手牌並通過挑戰機會，獲勝！`);
        emitRoom(room);
        return cb?.({ ok: true, gameOver: true });
      }
    }

    cb?.({ ok: true });
  });


  socket.on("leaveRoom", (_, cb) => {
    if (!allowSocketAction(socket, "leaveRoom", 3, 3000)) {
      return cb?.({ ok: false, message: "操作太頻繁，請稍後再試" });
    }
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) {
      socket.data.roomCode = null;
      return cb?.({ ok: true });
    }
    const leaving = room.players.find(p => p.id === socket.id);
    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(code);
    socket.data.roomCode = null;
    if (!room.players.length) {

      rooms.delete(code);
      return cb?.({ ok: true });
    }
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    if (room.started && room.players.length < 2) {
      room.started = false;
      room.roundRank = null;
      room.pile = [];
      room.lastPlay = null;
      room.winnerId = null;
    }
    room.log.push(`${leaving?.name || "玩家"} 離開了房間`);

    if(room.gameType === "big2" && room.started){

    }

    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("continueMatch", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, message: "房間不存在" });
    if (!room.winnerId) return cb?.({ ok: false, message: "目前還沒有完成的對局" });
    if (room.players.length < 2) return cb?.({ ok: false, message: "至少需要 2 人" });

    dealStartingCards(room);
    room.matchRecorded = false;
    room.log.push("🔄 開始下一場！");
    io.to(room.code).emit("matchContinued");
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("endSession", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, message: "房間不存在" });

    io.to(room.code).emit("sessionEnded");
    for (const p of room.players) {
      const ps = io.sockets.sockets.get(p.id);
      if (ps) {
        ps.leave(room.code);
        ps.data.roomCode = null;
      }
    }
    rooms.delete(room.code);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const key of securityState.socketActions.keys()) {
      if (key.startsWith(`${socket.id}:`)) {
        securityState.socketActions.delete(key);
      }
    }

    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const [left] = room.players.splice(idx, 1);
      room.log.push(`${left.name} 離開了房間`);
      if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    }

    if (room.players.length === 0) {

      rooms.delete(code);
    } else {
      if(room.gameType === "big2" && room.started){

      }
      emitRoom(room);
    }
  });
});

app.use((req, res) => {
  res.status(404).send("Not Found");
});

app.use((err, req, res, next) => {
  console.error("Server error:", err?.message || err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).send("Internal Server Error");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Liar Card Game running on http://localhost:${PORT}`);
});
