require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const playerRooms = new Map();

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 6; i++) r += c[Math.floor(Math.random() * c.length)];
  return rooms.has(r) ? genCode() : r;
}

function getRoom(code) { return rooms.get(code); }

function broadcastRoom(code) {
  const room = getRoom(code);
  if (!room) return;
  io.to(code).emit('roomUpdate', {
    code: room.code,
    players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, ready: p.ready })),
    game: room.game,
    started: room.started,
    host: room.host
  });
}

/* ========== CHESS HELPERS ========== */
function initChessBoard() {
  const b = Array(64).fill('');
  const back = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[c] = back[c]; b[8+c] = 'P';
    b[48+c] = 'p'; b[56+c] = back[c].toLowerCase();
  }
  return b;
}
function rc(i){ return [Math.floor(i/8), i%8]; }
function idx(r,c){ return r*8+c; }
function pathClear(board,from,to){
  const [fr,fc]=rc(from),[tr,tc]=rc(to);
  const sr=Math.sign(tr-fr),sc=Math.sign(tc-fc);
  let r=fr+sr,c=fc+sc;
  while(r!==tr||c!==tc){ if(board[idx(r,c)]) return false; r+=sr; c+=sc; }
  return true;
}
function isValidChessMove(board,from,to,piece){
  const [fr,fc]=rc(from),[tr,tc]=rc(to);
  const dr=tr-fr,dc=tc-fc,target=board[to];
  const isW=piece===piece.toUpperCase();
  if(target&&(isW===(target===target.toUpperCase()))) return false;
  const p=piece.toUpperCase();
  if(p==='P'){
    const dir=isW?-1:1,startRow=isW?6:1;
    if(dc===0&&dr===dir&&!target) return true;
    if(dc===0&&dr===2*dir&&fr===startRow&&!target&&!board[from+dir*8]) return true;
    if(Math.abs(dc)===1&&dr===dir&&target) return true;
    return false;
  }
  if(p==='R') return (dr===0||dc===0)&&pathClear(board,from,to);
  if(p==='B') return Math.abs(dr)===Math.abs(dc)&&pathClear(board,from,to);
  if(p==='Q') return ((dr===0||dc===0)||Math.abs(dr)===Math.abs(dc))&&pathClear(board,from,to);
  if(p==='N') return (Math.abs(dr)===2&&Math.abs(dc)===1)||(Math.abs(dr)===1&&Math.abs(dc)===2);
  if(p==='K') return Math.abs(dr)<=1&&Math.abs(dc)<=1;
  return false;
}
function isInCheck(board,white){
  const king=white?'K':'k',ki=board.indexOf(king);
  if(ki<0) return false;
  for(let i=0;i<64;i++){
    const p=board[i];
    if(!p||(white===(p===p.toUpperCase()))) continue;
    if(isValidChessMove(board,i,ki,p)) return true;
  }
  return false;
}
function hasLegalMoves(board,white){
  for(let i=0;i<64;i++){
    const p=board[i];
    if(!p||(white!==(p===p.toUpperCase()))) continue;
    for(let j=0;j<64;j++){
      if(isValidChessMove(board,i,j,p)){
        const nb=[...board]; nb[j]=nb[i]; nb[i]='';
        if(!isInCheck(nb,white)) return true;
      }
    }
  }
  return false;
}

/* ========== GAME HELPERS ========== */
function checkLine(b){
  const L=[[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for(const[a,c,d]of L) if(b[a]&&b[a]===b[c]&&b[a]===b[d]) return b[a];
  return null;
}
function checkC4(board,p){
  for(let r=0;r<6;r++) for(let c=0;c<7;c++){
    if(c+3<7&&[0,1,2,3].every(i=>board[r][c+i]===p)) return true;
    if(r+3<6&&[0,1,2,3].every(i=>board[r+i][c]===p)) return true;
    if(r+3<6&&c+3<7&&[0,1,2,3].every(i=>board[r+i][c+i]===p)) return true;
    if(r+3<6&&c-3>=0&&[0,1,2,3].every(i=>board[r+i][c-i]===p)) return true;
  }
  return false;
}
function countSOS(board,sz,cell){
  let count=0; const r=Math.floor(cell/sz),c=cell%sz;
  const dirs=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  for(const[dr,dc]of dirs){
    const r1=r-dr,c1=c-dc,r2=r+dr,c2=c+dc;
    if(r1>=0&&r1<sz&&c1>=0&&c1<sz&&r2>=0&&r2<sz&&c2>=0&&c2<sz)
      if(board[r1*sz+c1]==='S'&&board[r2*sz+c2]==='S'&&board[cell]==='O') count++;
  }
  return count;
}
function checkBingo(card,called){
  for(let r=0;r<5;r++) if(card[r].every(n=>n===0||called.includes(n))) return true;
  for(let c=0;c<5;c++) if([0,1,2,3,4].every(r=>card[r][c]===0||called.includes(card[r][c]))) return true;
  if([0,1,2,3,4].every(i=>card[i][i]===0||called.includes(card[i][i]))) return true;
  if([0,1,2,3,4].every(i=>card[i][4-i]===0||called.includes(card[i][4-i]))) return true;
  return false;
}

/* ========== GAME DEFINITIONS ========== */
const GAMES = {
  tictactoe:{
    init:()=>({board:Array(9).fill(''),turn:0,winner:null,draw:false}),
    validate:(s,m,pid,room)=>{
      if(s.winner||s.draw) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      return m>=0&&m<=8&&s.board[m]==='';
    },
    apply:(s,m)=>{
      s.board[m]=s.turn===0?'X':'O';
      const w=checkLine(s.board);
      if(w) s.winner=w;
      else if(s.board.every(c=>c!=='')) s.draw=true;
      else s.turn=1-s.turn;
      return s;
    }
  },
  connectfour:{
    init:()=>({board:Array(6).fill(null).map(()=>Array(7).fill(0)),turn:0,winner:null}),
    validate:(s,m,pid,room)=>{
      if(s.winner) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      return m>=0&&m<=6&&s.board[0][m]===0;
    },
    apply:(s,m)=>{
      const p=s.turn+1;
      for(let r=5;r>=0;r--) if(s.board[r][m]===0){s.board[r][m]=p;break;}
      if(checkC4(s.board,p)) s.winner=p; else s.turn=1-s.turn;
      return s;
    }
  },
  sos:{
    init:()=>({board:Array(49).fill(''),size:7,turn:0,scores:[0,0],over:false}),
    validate:(s,m,pid,room)=>{
      if(s.over) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      return m.cell>=0&&m.cell<=48&&s.board[m.cell]===''&&(m.letter==='S'||m.letter==='O');
    },
    apply:(s,m)=>{
      s.board[m.cell]=m.letter;
      const pts=countSOS(s.board,s.size,m.cell);
      s.scores[s.turn]+=pts;
      if(s.board.every(c=>c!=='')) s.over=true;
      else if(pts===0) s.turn=1-s.turn;
      return s;
    }
  },
  dotsandboxes:{
    init:()=>({
      hL:Array(6).fill(null).map(()=>Array(5).fill(false)),
      vL:Array(5).fill(null).map(()=>Array(6).fill(false)),
      boxes:Array(5).fill(null).map(()=>Array(5).fill(0)),
      turn:0,scores:[0,0],rows:5,cols:5
    }),
    validate:(s,m,pid,room)=>{
      if(room.players[s.turn]?.id!==pid) return false;
      if(m.type==='h') return s.hL[m.r]&&s.hL[m.r][m.c]===false;
      if(m.type==='v') return s.vL[m.r]&&s.vL[m.r][m.c]===false;
      return false;
    },
    apply:(s,m)=>{
      if(m.type==='h') s.hL[m.r][m.c]=true; else s.vL[m.r][m.c]=true;
      let scored=0; const p=s.turn+1;
      for(let r=0;r<s.rows;r++) for(let c=0;c<s.cols;c++){
        if(s.boxes[r][c]===0&&s.hL[r][c]&&s.hL[r+1][c]&&s.vL[r][c]&&s.vL[r][c+1]){
          s.boxes[r][c]=p; scored++;
        }
      }
      s.scores[s.turn]+=scored;
      if(scored===0) s.turn=1-s.turn;
      return s;
    }
  },
  chess:{
    init:()=>({board:initChessBoard(),turn:0,captured:[[],[]],check:false,checkmate:false,stalemate:false}),
    validate:(s,m,pid,room)=>{
      if(s.checkmate||s.stalemate) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      const piece=s.board[m.from];
      if(!piece) return false;
      const isW=piece===piece.toUpperCase();
      if((s.turn===0&&!isW)||(s.turn===1&&isW)) return false;
      return isValidChessMove(s.board,m.from,m.to,piece);
    },
    apply:(s,m)=>{
      const cap=s.board[m.to];
      if(cap) s.captured[s.turn].push(cap);
      s.board[m.to]=s.board[m.from]; s.board[m.from]='';
      s.turn=1-s.turn;
      s.check=isInCheck(s.board,s.turn===0);
      if(!hasLegalMoves(s.board,s.turn===0)){
        if(s.check) s.checkmate=true; else s.stalemate=true;
      }
      return s;
    }
  },
  rps:{
    init:()=>({choices:[null,null],round:0,scores:[0,0],result:null,maxRounds:5,over:false}),
    validate:(s,m,pid,room)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      return pi>=0&&s.choices[pi]===null&&['rock','paper','scissors'].includes(m);
    },
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      s.choices[pi]=m;
      if(s.choices[0]&&s.choices[1]){
        const c=s.choices;
        if(c[0]===c[1]) s.result='draw';
        else if((c[0]==='rock'&&c[1]==='scissors')||(c[0]==='paper'&&c[1]==='rock')||(c[0]==='scissors'&&c[1]==='paper')){
          s.result='p1'; s.scores[0]++;
        } else { s.result='p2'; s.scores[1]++; }
        s.round++;
        if(s.round>=s.maxRounds) s.over=true;
        else { s.choices=[null,null]; s.result=null; }
      }
      return s;
    }
  },
  hangman:{
    init:()=>{
      const words=['JAVASCRIPT','PYTHON','MULTIPLAYER','SOCKET','DATABASE','ALGORITHM','FUNCTION','VARIABLE','NETWORK','BROWSER'];
      return {word:words[Math.floor(Math.random()*words.length)],guessed:[],wrong:0,maxWrong:6,turn:0,scores:[0,0],over:false,winner:null};
    },
    validate:(s,m,pid,room)=>{
      if(s.over) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      return !s.guessed.includes(m)&&m.length===1&&/[A-Z]/.test(m);
    },
    apply:(s,m)=>{
      s.guessed.push(m);
      if(!s.word.includes(m)){ s.wrong++; s.turn=1-s.turn; }
      if(s.word.split('').every(c=>s.guessed.includes(c))){ s.over=true; s.winner=s.turn; s.scores[s.turn]++; }
      else if(s.wrong>=s.maxWrong){ s.over=true; s.winner=1-s.turn; s.scores[1-s.turn]++; }
      return s;
    }
  },
  memorymatch:{
    init:()=>{
      const em=['🍎','🍊','🍋','🍇','🍉','🍓','🍒','🥝'];
      let cards=[...em,...em]; cards.sort(()=>Math.random()-0.5);
      return {cards,flipped:[],matched:Array(16).fill(false),turn:0,scores:[0,0],lock:false};
    },
    validate:(s,m,pid,room)=>{
      if(s.lock) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      return !s.matched[m]&&!s.flipped.includes(m);
    },
    apply:(s,m)=>{
      s.flipped.push(m);
      if(s.flipped.length===2){
        s.lock=true;
        const[a,b]=s.flipped;
        if(s.cards[a]===s.cards[b]){ s.matched[a]=s.matched[b]=true; s.scores[s.turn]++; s.flipped=[]; s.lock=false; }
      }
      return s;
    },
    afterDelay:(s)=>{
      if(s.flipped.length===2&&s.lock){ s.flipped=[]; s.lock=false; s.turn=1-s.turn; }
      return s;
    }
  },
  bingo:{
    init:()=>{
      const gen=()=>{
        const card=[];
        for(let c=0;c<5;c++){
          const min=c*15+1,max=c*15+15,nums=[];
          while(nums.length<5){const n=Math.floor(Math.random()*(max-min+1))+min; if(!nums.includes(n)) nums.push(n);}
          card.push(nums);
        }
        card[2][2]=0; return card;
      };
      return {cards:[gen(),gen()],called:[],turn:0,scores:[0,0],winner:null};
    },
    validate:(s,m,pid,room)=>{
      if(s.winner) return false;
      if(m==='call') return room.players[s.turn]?.id===pid;
      if(m==='bingo') return room.players.findIndex(p=>p.id===pid)>=0;
      return false;
    },
    apply:(s,m,room,pid)=>{
      if(m==='call'){
        let n; do{n=Math.floor(Math.random()*75)+1;}while(s.called.includes(n));
        s.called.push(n); s.turn=1-s.turn;
      } else if(m==='bingo'){
        const pi=room.players.findIndex(p=>p.id===pid);
        if(checkBingo(s.cards[pi],s.called)){s.winner=pi;s.scores[pi]++;}
      }
      return s;
    }
  },
  blockpuzzle:{
    init:()=>({scores:[0,0],time:120,over:false}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{const pi=room.players.findIndex(p=>p.id===pid);if(pi>=0)s.scores[pi]=m.score;return s;}
  },
  snake:{
    init:()=>({scores:[0,0],time:90,over:false}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{const pi=room.players.findIndex(p=>p.id===pid);if(pi>=0)s.scores[pi]=m.score;return s;}
  },
  battle2048:{
    init:()=>({scores:[0,0],time:120,over:false}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{const pi=room.players.findIndex(p=>p.id===pid);if(pi>=0)s.scores[pi]=m.score;return s;}
  },
  minesweeper:{
    init:()=>({scores:[0,0],times:[0,0],over:false,finished:[false,false]}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      if(pi>=0){s.times[pi]=m.time;s.finished[pi]=m.finished;}
      if(s.finished[0]&&s.finished[1])s.over=true;return s;
    }
  },
  sudokurace:{
    init:()=>({times:[0,0],over:false,finished:[false,false]}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      if(pi>=0){s.times[pi]=m.time;s.finished[pi]=true;}
      if(s.finished[0]&&s.finished[1])s.over=true;return s;
    }
  },
  numberguess:{
    init:()=>({target:Math.floor(Math.random()*100)+1,guesses:[[],[]],turn:0,winner:null,over:false}),
    validate:(s,m,pid,room)=>{
      if(s.over) return false;
      if(room.players[s.turn]?.id!==pid) return false;
      return m>=1&&m<=100;
    },
    apply:(s,m)=>{
      const hint=m===s.target?'correct':m<s.target?'higher':'lower';
      s.guesses[s.turn].push({num:m,hint});
      if(m===s.target){s.winner=s.turn;s.over=true;} else s.turn=1-s.turn;
      return s;
    }
  },
  wordscramble:{
    init:()=>{
      const words=['PUZZLE','GAMING','CODING','SERVER','SOCKET','BINARY','PYTHON','SCRIPT','MOBILE','SCREEN'];
      const word=words[Math.floor(Math.random()*words.length)];
      return {word,scrambled:word.split('').sort(()=>Math.random()-0.5).join(''),scores:[0,0],round:0,maxRounds:5,over:false,answered:[false,false]};
    },
    validate:(s,m,pid,room)=>{
      if(s.over) return false;
      const pi=room.players.findIndex(p=>p.id===pid);
      return pi>=0&&!s.answered[pi];
    },
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      s.answered[pi]=true;
      if(m.toUpperCase()===s.word) s.scores[pi]+=10;
      if(s.answered[0]&&s.answered[1]){
        s.round++;
        if(s.round>=s.maxRounds) s.over=true;
        else{
          const words=['PUZZLE','GAMING','CODING','SERVER','SOCKET','BINARY','PYTHON','SCRIPT','MOBILE','SCREEN'];
          s.word=words[Math.floor(Math.random()*words.length)];
          s.scrambled=s.word.split('').sort(()=>Math.random()-0.5).join('');
          s.answered=[false,false];
        }
      }
      return s;
    }
  },
  simonsays:{
    init:()=>({sequence:[Math.floor(Math.random()*4)],scores:[0,0],round:1,turn:0,phase:'show',over:false,winner:null}),
    validate:(s,m,pid,room)=>{
      if(s.over||s.phase!=='input') return false;
      return room.players[s.turn]?.id===pid;
    },
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      if(s.sequence[s.scores[pi]]===m){
        s.scores[pi]++;
        if(s.scores[pi]>=s.sequence.length){
          s.round++;s.sequence.push(Math.floor(Math.random()*4));
          s.scores=[0,0];s.phase='show';
        }
      } else { s.over=true;s.winner=1-pi; }
      return s;
    }
  },
  whackamole:{
    init:()=>({scores:[0,0],time:30,over:false}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{const pi=room.players.findIndex(p=>p.id===pid);if(pi>=0)s.scores[pi]=m.score;return s;}
  },
  slidingpuzzle:{
    init:()=>({times:[0,0],over:false,finished:[false,false]}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      if(pi>=0){s.times[pi]=m.time;s.finished[pi]=true;}
      if(s.finished[0]&&s.finished[1])s.over=true;return s;
    }
  },
  lightsout:{
    init:()=>({moves:[0,0],over:false,finished:[false,false]}),
    validate:()=>true,
    apply:(s,m,room,pid)=>{
      const pi=room.players.findIndex(p=>p.id===pid);
      if(pi>=0){s.moves[pi]=m.moves;s.finished[pi]=m.finished;}
      if(s.finished[0]&&s.finished[1])s.over=true;return s;
    }
  }
};

/* ========== SOCKET.IO ========== */
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ name, avatar }) => {
    const code = genCode();
    rooms.set(code, {
      code, host: socket.id, game: null, started: false,
      players: [{ id: socket.id, name: name||'Player 1', avatar: avatar||'🎮', ready: false }],
      gameState: null, chat: []
    });
    playerRooms.set(socket.id, code);
    socket.join(code);
    socket.emit('roomJoined', { code, isHost: true });
    broadcastRoom(code);
  });

  socket.on('joinRoom', ({ code, name, avatar }) => {
    const room = getRoom(code?.toUpperCase());
    if (!room) return socket.emit('errorMsg', 'Room not found');
    if (room.players.length >= 2) return socket.emit('errorMsg', 'Room is full');
    if (room.started) return socket.emit('errorMsg', 'Game already started');
    room.players.push({ id: socket.id, name: name||'Player 2', avatar: avatar||'🎲', ready: false });
    playerRooms.set(socket.id, code.toUpperCase());
    socket.join(code.toUpperCase());
    socket.emit('roomJoined', { code: code.toUpperCase(), isHost: false });
    broadcastRoom(code.toUpperCase());
  });

  socket.on('reconnect_room', ({ code, playerId }) => {
    const room = getRoom(code);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player) {
      player.id = socket.id;
      playerRooms.set(socket.id, code);
      socket.join(code);
      socket.emit('roomJoined', { code, isHost: room.host === playerId });
      broadcastRoom(code);
      if (room.started && room.gameState)
        socket.emit('gameStarted', { game: room.game, state: room.gameState });
    }
  });

  socket.on('toggleReady', () => {
    const code = playerRooms.get(socket.id);
    const room = getRoom(code);
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    if (p) { p.ready = !p.ready; broadcastRoom(code); }
  });

  socket.on('selectGame', (game) => {
    const code = playerRooms.get(socket.id);
    const room = getRoom(code);
    if (!room || room.host !== socket.id || !GAMES[game]) return;
    room.game = game;
    broadcastRoom(code);
  });

  socket.on('startGame', () => {
    const code = playerRooms.get(socket.id);
    const room = getRoom(code);
    if (!room || room.host !== socket.id || !room.game || room.players.length < 2) return;
    room.started = true;
    room.gameState = GAMES[room.game].init();
    io.to(code).emit('gameStarted', { game: room.game, state: room.gameState });
    broadcastRoom(code);
  });

  socket.on('gameMove', ({ move }) => {
    const code = playerRooms.get(socket.id);
    const room = getRoom(code);
    if (!room || !room.started || !room.game) return;
    const game = GAMES[room.game];
    if (!game.validate(room.gameState, move, socket.id, room))
      return socket.emit('invalidMove');
    room.gameState = game.apply(room.gameState, move, room, socket.id);
    io.to(code).emit('gameState', room.gameState);
    if (game.afterDelay) {
      setTimeout(() => {
        room.gameState = game.afterDelay(room.gameState);
        io.to(code).emit('gameState', room.gameState);
      }, 1200);
    }
  });

  socket.on('chatMessage', ({ text, type }) => {
    const code = playerRooms.get(socket.id);
    const room = getRoom(code);
    if (!room) return;
    const p = room.players.find(p => p.id === socket.id);
    io.to(code).emit('chatMessage', { name: p?.name, text, type: type||'text', time: Date.now() });
  });

  socket.on('leaveRoom', () => {
    const code = playerRooms.get(socket.id);
    if (!code) return;
    const room = getRoom(code);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) rooms.delete(code);
      else {
        if (room.host === socket.id) room.host = room.players[0].id;
        room.started = false; room.gameState = null;
        broadcastRoom(code);
      }
    }
    socket.leave(code);
    playerRooms.delete(socket.id);
    socket.emit('leftRoom');
  });

  socket.on('rematch', () => {
    const code = playerRooms.get(socket.id);
    const room = getRoom(code);
    if (!room || !room.game) return;
    room.started = true;
    room.gameState = GAMES[room.game].init();
    io.to(code).emit('gameStarted', { game: room.game, state: room.gameState });
  });

  socket.on('disconnect', () => {
    const code = playerRooms.get(socket.id);
    if (code) io.to(code).emit('playerDisconnected', { id: socket.id });
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
server.listen(PORT, () => console.log(`Game Hub on port ${PORT}`));
