const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};
const leaderboardTimers = {};

const badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy"];
function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

io.on('connection', (socket) => {
    
    // --- 1. ODA OLUŞTURMA ---
    socket.on('create_room', () => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = { 
            teacherSocketId: socket.id,
            teacherDisconnectTimeout: null,
            players: {}, questions: [], status: 'waiting' 
        };
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    // --- 2. ÖĞRETMEN YENİDEN BAĞLANMA ---
    socket.on('teacher_reconnect', (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (room) {
            if (room.teacherDisconnectTimeout) {
                clearTimeout(room.teacherDisconnectTimeout);
                room.teacherDisconnectTimeout = null;
            }
            room.teacherSocketId = socket.id; 
            socket.join(roomCode);
            socket.emit('teacher_reconnected_success', { status: room.status, players: Object.values(room.players) });
            if (room.status === 'waiting') socket.emit('lobby_update', Object.values(room.players));
            else if (room.status === 'playing') socket.emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
        }
    });

    // --- 3. ÖĞRENCİYİ ATMA ---
    socket.on('kick_player', (data) => {
        const { roomCode, playerId } = data;
        const room = rooms[roomCode];
        if (room && room.teacherSocketId === socket.id) {
            if (room.players[playerId]) {
                io.to(playerId).emit('kicked_out', 'Öğretmen tarafından odadan çıkarıldınız.');
                delete room.players[playerId];
                const targetSocket = io.sockets.sockets.get(playerId);
                if (targetSocket) targetSocket.leave(roomCode);
                if (room.status === 'waiting') io.to(roomCode).emit('lobby_update', Object.values(room.players));
                else if (room.status === 'playing') { requestLeaderboardUpdate(roomCode); checkIfGameOver(roomCode); }
            }
        }
    });

    // --- ÖĞRENCİ YENİDEN BAĞLANMA (MÜKEMMEL GERİ DÖNÜŞ) ---
    socket.on('student_reconnect', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];

        if (room) {
            const oldSocketId = Object.keys(room.players).find(key => room.players[key].name === playerName);
            if (oldSocketId) {
                let playerObj = room.players[oldSocketId];
                if(!playerObj) return;

                // Eski ID'yi sil, yenisini ver. Statüyü "playing" yap!
                playerObj.id = socket.id;
                playerObj.status = room.status === 'playing' ? 'playing' : 'waiting';
                
                delete room.players[oldSocketId];
                room.players[socket.id] = playerObj;
                socket.join(roomCode);

                socket.emit('join_success', { roomCode: roomCode });

                if (room.status === 'playing') {
                    requestLeaderboardUpdate(roomCode); 
                    // Oyuncuya kaldığı soruyu "Kilitleri açılmış halde" geri yolla
                    sendIndividualQuestion(roomCode, socket.id);
                } else {
                    io.to(roomCode).emit('lobby_update', Object.values(room.players));
                }
            } else {
                socket.emit('join_error', { message: 'Öğretmen odayı kapatmış olabilir. Lütfen tekrar girin.' });
            }
        }
    });

    // --- 4. ODAYA KATILMA ---
    socket.on('join_room', (data) => {
        const { roomCode, playerName } = data;
        const room = rooms[roomCode];
        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı veya süresi doldu!' });
        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Lütfen uygun bir isim kullanın!' });

        socket.join(roomCode);
        room.players[socket.id] = { id: socket.id, name: playerName, score: 0, combo: 0, correct: 0, wrong: 0, currentIndex: 0, status: 'waiting', lastQuestionSentAt: 0 };
        socket.emit('join_success', { roomCode: roomCode });
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
    });

    // --- 5. OYUNU BAŞLATMA ---
    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        if (room && room.teacherSocketId === socket.id) {
            room.questions = questions; room.status = 'playing';
            Object.keys(room.players).forEach(pId => {
                let order = Array.from({length: questions.length}, (_, i) => i);
                room.players[pId].shuffledOrder = order.sort(() => Math.random() - 0.5);
                room.players[pId].status = 'playing';
            });
            io.to(roomCode).emit('game_starting');
            setTimeout(() => { Object.keys(room.players).forEach(pId => sendIndividualQuestion(roomCode, pId)); }, 4500);
        }
    });

    function sendIndividualQuestion(roomCode, pId) {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players[pId];
        
        if (!player || player.currentIndex >= room.questions.length) {
            if(player && player.status !== 'disconnected') player.status = 'finished';
            io.to(pId).emit('player_finished');
            requestLeaderboardUpdate(roomCode);
            checkIfGameOver(roomCode);
            return;
        }
        const questionIndex = player.shuffledOrder[player.currentIndex];
        const q = room.questions[questionIndex];
        player.lastQuestionSentAt = Date.now();
        io.to(pId).emit('new_question', { questionText: q.questionText, options: q.options, qNum: player.currentIndex + 1, total: room.questions.length });
    }

    function checkIfGameOver(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        // OYUNUN BİTMESİ İÇİN KİMSENİN "PLAYING" DURUMUNDA OLMAMASI LAZIM. "Disconnected" olanları bekleriz!
        const allFinished = Object.values(room.players).every(p => p.status === 'finished');
        if (allFinished && Object.keys(room.players).length > 0) {
            room.status = 'finished';
            if (leaderboardTimers[roomCode]) clearTimeout(leaderboardTimers[roomCode]);
            io.to(roomCode).emit('game_over', { leaderboard: Object.values(room.players).sort((a,b) => b.score - a.score) });
        }
    }

    // --- 8. CEVAP GÖNDERME VE PUANLAMA ---
    socket.on('submit_answer', (data) => {
        const { roomCode, selectedOption } = data;
        const room = rooms[roomCode];
        const player = room ? room.players[socket.id] : null;
        if (!player || player.status !== 'playing') return;

        const currentQ = room.questions[player.shuffledOrder[player.currentIndex]];
        const responseTime = Date.now() - player.lastQuestionSentAt;
        let isCorrect = (selectedOption === currentQ.correctAnswer);

        if (isCorrect) {
            player.correct++; player.combo++;
            const timeBonus = Math.max(0, 10000 - responseTime) * 0.05; 
            player.score += Math.floor(500 + timeBonus + (player.combo * 50));
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints: Math.floor(500 + timeBonus + (player.combo * 50)), totalScore: player.score, combo: player.combo });
        } else {
            player.wrong++; player.combo = 0;
            player.score = Math.max(0, player.score - 500); 
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: -500, totalScore: player.score, combo: 0 });
        }
        
        requestLeaderboardUpdate(roomCode);
        player.currentIndex++;
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1500);
    });

    function requestLeaderboardUpdate(roomCode) {
        if (leaderboardTimers[roomCode]) return;
        leaderboardTimers[roomCode] = setTimeout(() => {
            const room = rooms[roomCode];
            if (room) io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score));
            delete leaderboardTimers[roomCode];
        }, 1000); 
    }

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode] && rooms[roomCode].teacherSocketId === socket.id) {
            io.to(roomCode).emit('game_over', { leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) });
            delete rooms[roomCode];
        }
    });

    // --- KOPMA YÖNETİMİ (OYUNDAN ASLA ATMA) ---
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.teacherSocketId === socket.id) {
                room.teacherDisconnectTimeout = setTimeout(() => {
                    io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                    delete rooms[roomCode];
                }, 60000); 
            } else if (room.players[socket.id]) {
                // Öğrenci koparsa "disconnected" (Koptu) yap. Oyunu BİTİRME. Bekle!
                room.players[socket.id].status = 'disconnected';
                requestLeaderboardUpdate(roomCode);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online - Port: ${PORT}`); });
