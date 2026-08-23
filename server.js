const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

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
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRoom(code) {
  return {
    code,
    players: [],
    started: false,
    turnIndex: 0,
    pile: [],
    lastPlay: null,
    roundRank: null,
    winnerId: null,
    matchRecorded: false,
    log: []
  };
}

function roomPublicState(room) {
  return {
    code: room.code,
    started: room.started,
    turnIndex: room.turnIndex,
    pileCount: room.pile.length,
    roundRank: room.roundRank,
    tableCards: room.pile.map(() => ({ hidden: true })),
    // 由伺服器明確指定目前唯一可以抓吹牛的玩家
    challengePlayerId:
      room.started && room.lastPlay && room.players[room.turnIndex]
        ? room.players[room.turnIndex].id
        : null,
    winnerId: room.winnerId,
    lastPlay: room.lastPlay ? {
      playerId: room.lastPlay.playerId,
      playerName: room.lastPlay.playerName,
      claimRank: room.lastPlay.claimRank,
      count: room.lastPlay.cards.length
    } : null,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      animal: p.animal,
      wins: p.wins || 0,
      losses: p.losses || 0,
      cardCount: p.hand.length,
      isTurn: room.started && i === room.turnIndex,
      isWinner: p.id === room.winnerId
    })),
    log: room.log.slice(-12)
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
  return String(name || "").trim().slice(0, 16);
}

function cleanAnimal(animal) {
  const allowed = ["🐶","🐱","🐰","🦊","🐼","🐯","🐸","🐵"];
  return allowed.includes(animal) ? animal : "🐶";
}

function cleanCode(code) {
  return String(code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}


function dealTenCards(room) {
  const deck = makeDeck();
  room.players.forEach(p => p.hand = []);

  for (let round = 0; round < 10; round++) {
    for (const player of room.players) {
      if (deck.length) player.hand.push(deck.pop());
    }
  }

  room.started = true;
  room.winnerId = null;
  room.turnIndex = 0;
  room.pile = [];
  room.lastPlay = null;
  room.roundRank = null;
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

io.on("connection", socket => {
  socket.on("createRoom", ({ name, animal }, cb) => {
    name = cleanName(name);
    animal = cleanAnimal(animal);
    if (!name) return cb?.({ ok: false, message: "請輸入暱稱" });

    let code;
    do code = Math.random().toString(36).slice(2, 7).toUpperCase();
    while (rooms.has(code));

    const room = newRoom(code);
    room.players.push({ id: socket.id, name, animal, hand: [], wins: 0, losses: 0 });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    room.log.push(`${name} 建立了房間`);
    emitRoom(room);
    cb?.({ ok: true, code });
  });

  socket.on("joinRoom", ({ name, code, animal }, cb) => {
    name = cleanName(name);
    animal = cleanAnimal(animal);
    code = cleanCode(code);
    const room = rooms.get(code);

    if (!name) return cb?.({ ok: false, message: "請輸入暱稱" });
    if (!room) return cb?.({ ok: false, message: "找不到這個房間" });
    if (room.started) return cb?.({ ok: false, message: "遊戲已開始" });
    if (room.players.length >= 4) return cb?.({ ok: false, message: "房間已滿（最多 4 人）" });

    room.players.push({ id: socket.id, name, animal, hand: [], wins: 0, losses: 0 });
    socket.join(code);
    socket.data.roomCode = code;
    room.log.push(`${name} 加入了房間`);
    emitRoom(room);
    cb?.({ ok: true, code });
  });

  socket.on("startGame", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.players[0]?.id !== socket.id) return cb?.({ ok: false, message: "只有房主可以開始" });
    if (room.players.length < 2) return cb?.({ ok: false, message: "至少需要 2 人" });

    dealTenCards(room);
    room.matchRecorded = false;
    room.log = ["遊戲開始！"];
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("playCards", ({ indices, claimRank }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started) return;
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

    room.log.push(`${player.name} 出了 ${cards.length} 張，宣稱都是 ${claimRank}`);
    nextTurn(room);
    emitRoom(room);
    cb?.({ ok: true });
  });

  socket.on("challenge", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.started || !room.lastPlay) {
      return cb?.({ ok: false, message: "目前沒有可以抓的上一手" });
    }

    const challenger = getPlayer(room, socket.id);
    if (!challenger || currentPlayer(room)?.id !== socket.id) {
      return cb?.({ ok: false, message: "現在不是你的抓吹牛時機" });
    }

    const revealedCards = room.lastPlay.cards.map(card => ({ suit: card.suit, rank: card.rank }));
    const liar = room.lastPlay.cards.some(card => card.rank !== room.lastPlay.claimRank);
    const accused = getPlayer(room, room.lastPlay.playerId);
    const challengedPileCount = room.pile.length;

    if (liar) {
      accused.hand.push(...room.pile);
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


  socket.on("continueMatch", (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb?.({ ok: false, message: "房間不存在" });
    if (!room.winnerId) return cb?.({ ok: false, message: "目前還沒有完成的對局" });
    if (room.players.length < 2) return cb?.({ ok: false, message: "至少需要 2 人" });

    dealTenCards(room);
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
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room) return;

    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== -1) {
      const [left] = room.players.splice(idx, 1);
      room.log.push(`${left.name} 離開了房間`);
      if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    }

    if (room.players.length === 0) rooms.delete(code);
    else emitRoom(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Liar Card Game running on http://localhost:${PORT}`);
});
