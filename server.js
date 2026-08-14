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

let badWords = ["amk", "aq", "oç", "sik", "siktir", "pic", "yavsak", "fuck", "bitch", "pussy", "kasar"];

// WordPress sitenizden güncel yasaklı kelime listesini çeker
async function fetchBadWords() {
    try {
        const response = await fetch("https://kelimeoyunlari.com.tr/wp-admin/admin-ajax.php?action=ko_api_get_bad_words");
        const data = await response.json();
        if (data && data.success && Array.isArray(data.data)) {
            badWords = data.data;
            console.log("✅ Yasaklı kelime listesi WP'den güncellendi. Toplam:", badWords.length);
        }
    } catch(err) {
        console.error("⚠️ Yasaklı kelimeler çekilemedi, varsayılan liste kullanılıyor.", err.message);
    }
}

// Sunucu açıldığında hemen çalıştır ve her 1 saatte bir WP'yi kontrol et
fetchBadWords();
setInterval(fetchBadWords, 60 * 60 * 1000); // 1 Saat = 3.600.000 ms

function isNameClean(name) {
    const cleanName = name.replace(/[^a-zA-Zğüşıöç]/gi, '').toLowerCase();
    return !badWords.some(word => cleanName.includes(word));
}

// =========================================================================
// BELLEK KORUMA: ATIL ODALARI SİL (MEMORY LEAK GARBAGE COLLECTOR)
// =========================================================================
// Her 1 saatte bir sunucu belleğindeki odaları denetler.
// Oluşturulma süresi 6 saati aşmış veya atıl kalmış odaları RAM'den siler.
setInterval(() => {
    const now = Date.now();
    let cleanedCount = 0;
    for (const roomCode in rooms) {
        const room = rooms[roomCode];
        
        // Eğer bir odanın başlangıç zamanı yoksa şu anı ata (Eski odalar çökmesin diye)
        if (!room.created_at) room.created_at = now; 
        
        const ageInHours = (now - room.created_at) / (1000 * 60 * 60);
        
        // 6 saatten eski askıda kalmış odaları veya tüm oyuncuların çıktığı odaları temizle
        if (ageInHours >= 6 || Object.keys(room.players).length === 0) {
            delete rooms[roomCode];
            cleanedCount++;
        }
    }
    if (cleanedCount > 0) {
        console.log(`🧹 Bellek Temizliği: Atıl kalan ${cleanedCount} oda RAM'den silindi.`);
    }
}, 60 * 60 * 1000); // 1 saatte bir çalışır

io.on('connection', (socket) => {
    
    socket.on('create_room', () => {
        let roomCode;
        do { roomCode = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms[roomCode]);

        rooms[roomCode] = { 
    teacherSocketId: socket.id,
    teacherDisconnectTimeout: null, // Kopma toleransı (Sayfa yenileme için)
    players: {}, 
    questions: [], 
    status: 'waiting',
    created_at: Date.now() // BELLEK TEMİZLEME: Odanın tam olarak ne zaman oluşturulduğu kaydediliyor
};
        
        socket.join(roomCode); 
        socket.emit('room_created', { roomCode: roomCode });
    });

    socket.on('teacher_reconnect', (data) => {
        const { roomCode } = data;
        const room = rooms[roomCode];
        if (room) {
            if (room.teacherDisconnectTimeout) { clearTimeout(room.teacherDisconnectTimeout); room.teacherDisconnectTimeout = null; }
            room.teacherSocketId = socket.id; 
            socket.join(roomCode);
            socket.emit('teacher_reconnected_success', { status: room.status, players: Object.values(room.players) });
        } else {
            socket.emit('join_error', { message: 'Oda bulunamadı veya kapatılmış.' });
        }
    });

    socket.on('join_room', (data) => {
        const { roomCode, playerName, playerSection } = data;
        const room = rooms[roomCode];

        if (!room) return socket.emit('join_error', { message: '❌ Oda bulunamadı veya süresi doldu!' });
        if (!isNameClean(playerName)) return socket.emit('join_error', { message: '⚠️ Lütfen uygun bir isim kullanın!' });

        // KOPAN OYUNCU GERİ GELDİYSE (YENİDEN BAĞLANMA MANTIĞI)
        let existingPlayerKey = Object.keys(room.players).find(k => room.players[k].name === playerName);
        
        if (existingPlayerKey) {
            let p = room.players[existingPlayerKey];
            p.id = socket.id; // Eski verileri yeni sokete bağla
            if(room.status === 'playing') p.status = 'playing'; else p.status = 'waiting';
            
            room.players[socket.id] = p;
            if(existingPlayerKey !== socket.id) delete room.players[existingPlayerKey];
            
            socket.join(roomCode);
            socket.emit('join_success', { roomCode: roomCode });
            // Odadakilere durumu bildir
            io.to(roomCode).emit('lobby_update', Object.values(room.players));
            if(room.status === 'playing') io.to(room.teacherSocketId).emit('player_reconnected', { socketId: socket.id });
            return;
        }

        if (room.status !== 'waiting') return socket.emit('join_error', { message: '⛔ Yarışma çoktan başladı, girişler kapalı!' });

        // YENİ OYUNCU
        socket.join(roomCode);
        room.players[socket.id] = {
            id: socket.id,
            name: playerName,
            section: playerSection || 'A',
            score: 0,
            combo: 0,
            correct: 0, 
            wrong: 0,   
            currentIndex: 0,
            status: 'waiting',
            lastQuestionSentAt: 0
        };

        socket.emit('join_success', { roomCode: roomCode });
        io.to(roomCode).emit('lobby_update', Object.values(room.players));
    });

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
            }
        }
    });

    socket.on('start_game', (data) => {
        const { roomCode, questions } = data;
        const room = rooms[roomCode];
        if (room && room.teacherSocketId === socket.id) {
            room.questions = questions;
            room.status = 'playing';
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
            if(player && player.status !== 'left') player.status = 'finished';
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
            const comboBonus = player.combo * 50;
            const earnedPoints = Math.floor(500 + timeBonus + comboBonus);
            player.score += earnedPoints;
            socket.emit('answer_feedback', { isCorrect: true, earnedPoints, totalScore: player.score, combo: player.combo });
        } else {
            player.wrong++; player.combo = 0;
            player.score = Math.max(0, player.score - 500);
            socket.emit('answer_feedback', { isCorrect: false, earnedPoints: -500, totalScore: player.score, combo: 0 });
        }
        
        requestLeaderboardUpdate(roomCode);
        player.currentIndex++;
        setTimeout(() => sendIndividualQuestion(roomCode, socket.id), 1500);
    });

    // ==========================================
    // DOTS & BOXES DESTEĞİ
    // ==========================================
    socket.on('sync_game_state', (data) => {
        const { roomCode, state } = data;
        socket.to(roomCode).emit('game_state_updated', state);
    });

    socket.on('send_personal_question', (data) => {
        const { roomCode, targetPlayerId, questionData } = data;
        io.to(targetPlayerId).emit('personal_question_received', questionData);
    });

    socket.on('submit_personal_answer', (data) => {
        const { roomCode, answerData } = data;
        const room = rooms[roomCode];
        if (room && room.teacherSocketId) {
            io.to(room.teacherSocketId).emit('personal_answer_submitted', {
                playerId: socket.id,
                answerData: answerData
            });
        }
    });

   function checkIfGameOver(roomCode) {
        const room = rooms[roomCode];
        if (!room) return;
        
        // Herkes bitirdi mi veya ayrıldı mı kontrolü
        const allFinished = Object.values(room.players).every(p => p.status === 'finished' || p.status === 'left');
        
        if (allFinished && Object.keys(room.players).length > 0) {
            room.status = 'finished';
            
            // Eğer varsa zamanlayıcıları temizle
            if (leaderboardTimers[roomCode]) {
                clearTimeout(leaderboardTimers[roomCode]);
                delete leaderboardTimers[roomCode];
            }
            
            // Oyunculara oyunun bittiğini ve sonuçları bildir
            io.to(roomCode).emit('game_over', { 
                leaderboard: Object.values(room.players).sort((a,b) => b.score - a.score) 
            });

            // =========================================================
            // 🧹 HAFIZA SIZINTISINI (MEMORY LEAK) ÖNLEME KODU
            // =========================================================
            // Oyun bittikten sonra öğrencilerin sonuçları görebilmesi için
            // 5 dakika (300.000 ms) süre tanıyoruz. Sonra odayı RAM'den siliyoruz.
            setTimeout(() => {
                if (rooms[roomCode]) {
                    delete rooms[roomCode];
                    console.log(`Oda temizlendi (RAM bosaltildi): ${roomCode}`);
                }
            }, 5 * 60 * 1000); 
        }
    }

    socket.on('teacher_force_quit', (roomCode) => {
        if(rooms[roomCode] && rooms[roomCode].teacherSocketId === socket.id) {
            io.to(roomCode).emit('game_over', { leaderboard: Object.values(rooms[roomCode].players).sort((a,b) => b.score - a.score) });
            delete rooms[roomCode];
        }
    });

    function requestLeaderboardUpdate(roomCode) {
        if (leaderboardTimers[roomCode]) return;
        leaderboardTimers[roomCode] = setTimeout(() => {
            const room = rooms[roomCode];
            if (room) { io.to(roomCode).emit('update_leaderboard', Object.values(room.players).sort((a,b) => b.score - a.score)); }
            delete leaderboardTimers[roomCode];
        }, 1000); 
    }

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.teacherSocketId === socket.id) {
                room.teacherDisconnectTimeout = setTimeout(() => {
                    io.to(roomCode).emit('join_error', { message: 'Öğretmen oyundan ayrıldı. Oda kapatıldı.' });
                    delete rooms[roomCode];
                }, 60000);
            } else if (room.players[socket.id]) {
                room.players[socket.id].status = 'left';
                requestLeaderboardUpdate(roomCode);
                checkIfGameOver(roomCode);

                // BELLEK KORUMA: Odada aktif kimse kalmadıysa odayı sil
                const activePlayers = Object.values(room.players).filter(p => p.status === 'waiting' || p.status === 'playing');
                if (activePlayers.length === 0 && !room.teacherSocketId) {
                    delete rooms[roomCode];
                    console.log(`Oda bosaldi ve RAM'den silindi: ${roomCode}`);
                }
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server Online - Port: ${PORT}`); });
