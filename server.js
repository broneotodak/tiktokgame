try { await import('dotenv/config'); } catch(e) { /* dotenv optional in production */ }
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, SignConfig } from 'tiktok-live-connector';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const USERNAME = process.env.TIKTOK_USERNAME || 'broneotodak';

// ===== AI Voice Avatar =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lvNyQwaZPcGFiNUWWiVa'; // Johari - Malaysian male, warm & friendly

const VOICE_PERSONALITY_PROMPT = `You are Neo Todak's AI co-host on TikTok Live. You speak casual Manglish — the way Malaysian friends talk. Mix Malay and English naturally in the same sentence. Use words like "weh", "gila", "best ah", "power lah", "lets gooo", "bro" the way real Malaysians do. Keep it SHORT — 10 to 20 words max. Sound like a real person hyping a stream, NOT like a robot reading news. Never use formal Malay. No emojis. Write exactly how it should be SPOKEN out loud.`;

function buildCommentaryPrompt(eventType, eventData, recentContext) {
  const contextStr = recentContext?.length ? `Recent events: ${recentContext.join('; ')}` : '';
  switch (eventType) {
    case 'gift':
      return `${contextStr}\nEvent: ${eventData.nickname} sent ${eventData.repeatCount}x ${eventData.giftName} (${eventData.diamondCount} diamonds). React with hype and gratitude!`;
    case 'follow':
      return `${contextStr}\nEvent: ${eventData.nickname} just followed! Welcome them warmly.`;
    case 'share':
      return `${contextStr}\nEvent: ${eventData.nickname} shared the live! Thank them.`;
    case 'join_batch':
      return `${contextStr}\nEvent: ${eventData.count} new viewers just joined! Names include: ${eventData.names}. Welcome the crowd.`;
    case 'chat':
      return `${contextStr}\nEvent: ${eventData.nickname} said: "${eventData.comment}". Give a short fun reaction.`;
    case 'milestone':
      return `${contextStr}\nEvent: Viewer count hit ${eventData.count}! Celebrate this milestone.`;
    default:
      return `${contextStr}\nEvent: Something happened on the live stream. Give a hype comment.`;
  }
}

// Serve static files
app.use(express.json());
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

// Clean URL routes
app.get('/overlay', (req, res) => res.sendFile(join(__dirname, 'public', 'overlay.html')));
app.get('/game', (req, res) => res.sendFile(join(__dirname, 'public', 'game.html')));
app.get('/marathon', (req, res) => res.sendFile(join(__dirname, 'public', 'marathon3d.html')));
app.get('/voice', (req, res) => res.sendFile(join(__dirname, 'public', 'voice.html')));

// API endpoint to get current config
app.get('/api/config', (req, res) => {
  res.json({ username: USERNAME, connected: !!tiktokConnection });
});

// Proxy TikTok profile images to avoid CORS issues
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url param');
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send('Failed to proxy image');
  }
});

// POST /api/voice/generate — AI commentary + TTS
app.post('/api/voice/generate', async (req, res) => {
  if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
    return res.status(503).json({ error: 'Voice API keys not configured' });
  }

  try {
    const { eventType, eventData, recentContext } = req.body;
    const userPrompt = buildCommentaryPrompt(eventType, eventData, recentContext || []);

    // Step 1: GPT-4o-mini → commentary text
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: VOICE_PERSONALITY_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: 80,
        temperature: 0.9,
      }),
    });

    if (!chatRes.ok) {
      const err = await chatRes.text();
      console.error('OpenAI error:', err);
      return res.status(502).json({ error: 'OpenAI API failed' });
    }

    const chatData = await chatRes.json();
    const commentary = chatData.choices?.[0]?.message?.content?.trim() || '';
    if (!commentary) return res.status(500).json({ error: 'Empty commentary' });

    // Step 2: ElevenLabs TTS → audio/mpeg
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: commentary,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.3, similarity_boost: 0.85, style: 0.7, use_speaker_boost: true },
      }),
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('ElevenLabs error:', err);
      return res.status(502).json({ error: 'ElevenLabs TTS failed' });
    }

    // Stream audio back with commentary text in header
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Commentary-Text', encodeURIComponent(commentary));
    res.set('Access-Control-Expose-Headers', 'X-Commentary-Text');

    const arrayBuf = await ttsRes.arrayBuffer();
    res.send(Buffer.from(arrayBuf));

  } catch (err) {
    console.error('Voice generate error:', err);
    res.status(500).json({ error: 'Internal voice error' });
  }
});

// Track viewers
const viewers = new Map();
let tiktokConnection = null;
let connectionState = { connected: false, roomId: null, error: null };

function connectToTikTok(username) {
  // Set EulerStream API key if available (required for signing)
  if (process.env.EULER_API_KEY) {
    SignConfig.apiKey = process.env.EULER_API_KEY;
  }

  const connection = new TikTokLiveConnection(username, {
    enableExtendedGiftInfo: true,
  });

  // Grace period: ignore historical replay events for 3 seconds after connect
  let connectionReadyAt = Infinity;

  connection.connect().then(state => {
    console.log(`✅ Connected to @${username} (Room ID: ${state.roomId})`);
    connectionState = { connected: true, roomId: state.roomId, error: null };
    io.emit('connection-status', connectionState);
    // Start grace period — events before this are historical replay
    connectionReadyAt = Date.now() + 3000;
    console.log('⏳ Grace period: ignoring replay events for 3 seconds...');
    setTimeout(() => console.log('✅ Grace period ended — processing live events'), 3000);
  }).catch(err => {
    console.error('❌ Connection failed:', err.message);
    connectionState = { connected: false, roomId: null, error: err.message };
    io.emit('connection-status', connectionState);
  });

  function isLiveEvent() {
    return Date.now() >= connectionReadyAt;
  }

  // Helper to extract user info from event data
  function extractUser(data) {
    // v2 API: user data may be nested under different structures
    const user = data.user || data;
    // Profile pic can be in many places depending on API version
    const profilePic = user.profilePicture?.url?.[0]
      || user.profilePicture?.urls?.[0]
      || user.profilePictureUrl
      || user.avatarThumb?.url?.[0]
      || user.avatarThumb?.urls?.[0]
      || user.avatarMedium?.url?.[0]
      || user.avatar_thumb?.url_list?.[0]
      || user.avatarUrl
      || '';
    if (profilePic) console.log(`📷 ${user.uniqueId || user.nickname} pic: ${profilePic.slice(0, 60)}...`);
    return {
      id: (user.userId || user.uniqueId || '')?.toString(),
      uniqueId: user.uniqueId || '',
      nickname: user.nickname || user.uniqueId || 'Unknown',
      profilePic,
      isFollower: (user.followRole || 0) >= 1,
      isModerator: user.isModerator || false,
    };
  }

  // Track user from any event (so viewer-list works after page refresh)
  function trackViewer(user) {
    if (!user.id) return;
    const existing = viewers.get(user.id);
    if (!existing) {
      viewers.set(user.id, { ...user, joinedAt: Date.now() });
    } else {
      existing.lastSeen = Date.now();
    }
  }

  // Viewer joins
  connection.on('member', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return; // skip replay
    console.log(`👋 ${user.nickname} (@${user.uniqueId}) joined`);
    io.emit('viewer-join', { ...user, joinedAt: Date.now() });
  });

  // Chat messages
  connection.on('chat', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return; // skip replay
    const msg = { ...user, comment: data.comment || '', timestamp: Date.now() };
    console.log(`💬 ${msg.nickname}: ${msg.comment}`);
    io.emit('chat', msg);
  });

  // Gifts
  connection.on('gift', (data) => {
    // Only emit when gift streak ends or for non-streakable gifts
    if (data.giftType === 1 && !data.repeatEnd) return;

    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return; // skip replay
    const gift = {
      ...user,
      giftName: data.giftName || 'Gift',
      giftId: data.giftId,
      diamondCount: data.diamondCount || 0,
      repeatCount: data.repeatCount || 1,
      giftPictureUrl: data.giftPictureUrl || '',
      timestamp: Date.now(),
    };
    console.log(`🎁 ${gift.nickname} sent ${gift.repeatCount}x ${gift.giftName}`);
    io.emit('gift', gift);
  });

  // Likes
  connection.on('like', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return; // skip replay
    io.emit('like', {
      ...user,
      likeCount: data.likeCount || 1,
      totalLikes: data.totalLikeCount || 0,
      timestamp: Date.now(),
    });
  });

  // Follow (v2 has separate event)
  connection.on('follow', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return; // skip replay
    console.log(`⭐ ${user.nickname} followed!`);
    io.emit('follow', { ...user, timestamp: Date.now() });
  });

  // Share (v2 has separate event)
  connection.on('share', (data) => {
    const user = extractUser(data);
    if (!isLiveEvent()) return; // skip replay
    io.emit('share', user);
  });

  // Social (fallback for older API)
  connection.on('social', (data) => {
    const user = extractUser(data);
    if (!isLiveEvent()) return; // skip replay
    if (data.displayType?.includes('follow')) {
      io.emit('follow', { ...user, timestamp: Date.now() });
    }
    if (data.displayType?.includes('share')) {
      io.emit('share', user);
    }
  });

  // Room stats
  connection.on('roomUser', (data) => {
    io.emit('room-stats', { viewerCount: data.viewerCount });
  });

  // Disconnection
  connection.on('disconnected', () => {
    console.log('⚠️ Disconnected from TikTok Live');
    connectionState = { connected: false, roomId: null, error: 'Disconnected' };
    io.emit('connection-status', connectionState);
  });

  connection.on('error', (err) => {
    console.error('❌ Error:', err.message);
  });

  tiktokConnection = connection;
}

// ===== Demo Mode =====
const DEMO_USERS = [
  { id: 'd1', uniqueId: 'gamer_girl99', nickname: 'GamerGirl', isFollower: true, isModerator: false },
  { id: 'd2', uniqueId: 'tech_bro_my', nickname: 'TechBro MY', isFollower: false, isModerator: false },
  { id: 'd3', uniqueId: 'todak_fan_01', nickname: 'Todak Fan', isFollower: true, isModerator: false },
  { id: 'd4', uniqueId: 'streamsniper420', nickname: 'StreamSniper', isFollower: false, isModerator: false },
  { id: 'd5', uniqueId: 'neon_rider', nickname: 'Neon Rider', isFollower: true, isModerator: true },
  { id: 'd6', uniqueId: 'kl_foodie', nickname: 'KL Foodie', isFollower: false, isModerator: false },
  { id: 'd7', uniqueId: 'cyberjaya_dev', nickname: 'CJ Dev', isFollower: true, isModerator: false },
  { id: 'd8', uniqueId: 'mrsm_alumni', nickname: 'MRSM Alumni', isFollower: true, isModerator: false },
  { id: 'd9', uniqueId: 'esports_queen', nickname: 'Esports Queen', isFollower: false, isModerator: false },
  { id: 'd10', uniqueId: 'retro_gamer_88', nickname: 'RetroGamer88', isFollower: true, isModerator: false },
  { id: 'd11', uniqueId: 'ai_enthusiast', nickname: 'AI Enthusiast', isFollower: false, isModerator: false },
  { id: 'd12', uniqueId: 'pixel_artist_my', nickname: 'PixelArtist', isFollower: true, isModerator: false },
];

const DEMO_CHATS = [
  'hello bro!', 'assalamualaikum!', 'first time here', 'nice stream!',
  'where are you from?', 'todak gaming best!', 'love from KL',
  'share share share!', 'can you play MLBB?', 'nice setup bro',
  'follow back pls', 'what game is this?', 'hahaha legend!',
  'how to join?', 'the overlay is so cool!', 'neo todak in the house!',
];

const DEMO_GIFTS = ['Rose', 'Ice Cream Cone', 'GG', 'Doughnut', 'TikTok'];

let demoInterval = null;
let demoJoinTimer = null;
let demoStopped = false;
let demoViewerIdx = 0;
let demoViewerCount = 0;

function startDemo() {
  console.log('🎮 Demo mode started — simulating live viewers');
  connectionState = { connected: true, roomId: 'DEMO-MODE', error: null };
  io.emit('connection-status', connectionState);
  demoViewerIdx = 0;
  demoViewerCount = 0;
  demoStopped = false;

  // Stagger viewer joins every 2-5 seconds
  function scheduleNextJoin() {
    if (demoStopped || demoViewerIdx >= DEMO_USERS.length) return;
    const delay = 2000 + Math.random() * 3000;
    demoJoinTimer = setTimeout(() => {
      if (demoStopped) return;
      const user = DEMO_USERS[demoViewerIdx++];
      const viewer = { ...user, profilePic: '', joinedAt: Date.now() };
      viewers.set(viewer.id, viewer);
      demoViewerCount++;
      io.emit('viewer-join', viewer);
      io.emit('room-stats', { viewerCount: demoViewerCount });
      scheduleNextJoin();
    }, delay);
  }
  scheduleNextJoin();

  // Random chats every 3-6 seconds
  demoInterval = setInterval(() => {
    if (demoStopped) return;
    const activeViewers = Array.from(viewers.values());
    if (activeViewers.length === 0) return;

    const roll = Math.random();
    const user = activeViewers[Math.floor(Math.random() * activeViewers.length)];

    if (roll < 0.6) {
      // Chat message
      const comment = DEMO_CHATS[Math.floor(Math.random() * DEMO_CHATS.length)];
      io.emit('chat', { ...user, comment, timestamp: Date.now() });
    } else if (roll < 0.8) {
      // Like
      io.emit('like', { ...user, likeCount: Math.floor(Math.random() * 5) + 1, totalLikes: Math.floor(Math.random() * 500), timestamp: Date.now() });
    } else if (roll < 0.92) {
      // Gift
      const giftName = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      io.emit('gift', { ...user, giftName, diamondCount: Math.floor(Math.random() * 100) + 1, repeatCount: Math.floor(Math.random() * 3) + 1, giftPictureUrl: '', timestamp: Date.now() });
    } else {
      // Follow
      io.emit('follow', { ...user, timestamp: Date.now() });
    }
  }, 3000 + Math.random() * 3000);
}

function stopDemo() {
  demoStopped = true;
  if (demoInterval) clearInterval(demoInterval);
  demoInterval = null;
  if (demoJoinTimer) clearTimeout(demoJoinTimer);
  demoJoinTimer = null;
  // Remove only demo users (id starts with 'd'), not bots or real users
  DEMO_USERS.forEach(u => viewers.delete(u.id));
  connectionState = { connected: false, roomId: null, error: null };
  io.emit('connection-status', connectionState);
  console.log('🛑 Demo mode stopped');
}

// ===== Bot Mode (runs alongside live) =====
const BOT_USERS = [
  { id: 'bot_1', uniqueId: 'aisyah_kl', nickname: 'Aisyah', isFollower: true, isModerator: false },
  { id: 'bot_2', uniqueId: 'haziq_gaming', nickname: 'Haziq', isFollower: false, isModerator: false },
  { id: 'bot_3', uniqueId: 'mei_ling88', nickname: 'Mei Ling', isFollower: true, isModerator: false },
  { id: 'bot_4', uniqueId: 'arjun_plays', nickname: 'Arjun', isFollower: false, isModerator: false },
  { id: 'bot_5', uniqueId: 'nurul_amira', nickname: 'Nurul', isFollower: true, isModerator: false },
  { id: 'bot_6', uniqueId: 'tanaka_yuki', nickname: 'Yuki', isFollower: false, isModerator: false },
  { id: 'bot_7', uniqueId: 'danish_my', nickname: 'Danish', isFollower: true, isModerator: false },
  { id: 'bot_8', uniqueId: 'siti_sarah', nickname: 'Siti Sarah', isFollower: true, isModerator: false },
];

const BOT_CHATS = [
  'lets go!', 'woooo!', 'nice!', 'hahaha', 'gg bro',
  'so cool!', 'faster faster!', 'nooo obstacle!', 'love this game',
  'gogogogo!', 'semangat!', 'bestnya!', 'I\'m winning!',
  'wahh pro!', 'lajunyaaa', 'sikit lagi!', 'terbaik bro!',
];

const BOT_COMMANDS = ['jump', 'left', 'right'];

let botInterval = null;
let botActionInterval = null;
let botJoinTimer = null;
let botActive = false;
let botJoinIdx = 0;

function startBots() {
  if (botActive) return;
  botActive = true;
  botJoinIdx = 0;
  console.log('🤖 Bot mode started — adding bots alongside live');

  // Stagger bot joins every 1-3 seconds
  function scheduleNextBot() {
    if (!botActive || botJoinIdx >= BOT_USERS.length) return;
    const delay = 1000 + Math.random() * 2000;
    botJoinTimer = setTimeout(() => {
      if (!botActive) return;
      const user = BOT_USERS[botJoinIdx++];
      const viewer = { ...user, profilePic: '', joinedAt: Date.now() };
      viewers.set(viewer.id, viewer);
      io.emit('viewer-join', viewer);
      scheduleNextBot();
    }, delay);
  }
  scheduleNextBot();

  // Bots chat/like/gift every 3-6 seconds (vibes)
  botInterval = setInterval(() => {
    if (!botActive) return;
    const bots = BOT_USERS.filter(b => viewers.has(b.id));
    if (bots.length === 0) return;

    const bot = bots[Math.floor(Math.random() * bots.length)];
    const roll = Math.random();

    if (roll < 0.5) {
      // Casual chat (shows bubble)
      const comment = BOT_CHATS[Math.floor(Math.random() * BOT_CHATS.length)];
      io.emit('chat', { ...bot, profilePic: '', comment, timestamp: Date.now() });
    } else if (roll < 0.85) {
      // Like (speed boost)
      io.emit('like', { ...bot, profilePic: '', likeCount: Math.floor(Math.random() * 3) + 1, totalLikes: Math.floor(Math.random() * 200), timestamp: Date.now() });
    } else {
      // Gift (mount)
      const giftName = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      io.emit('gift', { ...bot, profilePic: '', giftName, giftId: Date.now(), diamondCount: Math.floor(Math.random() * 50) + 1, repeatCount: 1, giftPictureUrl: '', timestamp: Date.now() });
    }
  }, 3000 + Math.random() * 3000);

  // Bots dodge obstacles every 1-2 seconds (survival)
  botActionInterval = setInterval(() => {
    if (!botActive) return;
    const bots = BOT_USERS.filter(b => viewers.has(b.id));
    if (bots.length === 0) return;

    // Pick 1-3 random bots to act this tick
    const actCount = 1 + Math.floor(Math.random() * Math.min(3, bots.length));
    const shuffled = bots.sort(() => Math.random() - 0.5);
    for (let i = 0; i < actCount; i++) {
      const bot = shuffled[i];
      const cmd = BOT_COMMANDS[Math.floor(Math.random() * BOT_COMMANDS.length)];
      io.emit('chat', { ...bot, profilePic: '', comment: cmd, timestamp: Date.now() });
    }
  }, 1000 + Math.random() * 1000);
}

function stopBots() {
  botActive = false;
  if (botInterval) clearInterval(botInterval);
  botInterval = null;
  if (botActionInterval) clearInterval(botActionInterval);
  botActionInterval = null;
  if (botJoinTimer) clearTimeout(botJoinTimer);
  botJoinTimer = null;
  // Remove only bot viewers from server tracking
  BOT_USERS.forEach(b => viewers.delete(b.id));
  // Tell clients to remove bots
  io.emit('bots-removed', BOT_USERS.map(b => b.id));
  console.log('🛑 Bots removed');
}

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔌 Browser client connected`);

  // Send current state
  socket.emit('connection-status', connectionState);
  socket.emit('viewer-list', Array.from(viewers.values()));

  // Allow browser to trigger connection with custom username
  socket.on('connect-tiktok', (username) => {
    stopDemo();
    stopBots();
    if (tiktokConnection) {
      try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
    }
    viewers.clear();
    connectToTikTok(username || USERNAME);
  });

  // Demo mode toggle (standalone — disconnects live + removes bots)
  socket.on('start-demo', () => {
    stopDemo();
    stopBots();
    if (tiktokConnection) {
      try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
      tiktokConnection = null;
    }
    viewers.clear();
    startDemo();
  });

  socket.on('stop-demo', () => {
    stopDemo();
  });

  // Bot mode — runs alongside live connection
  socket.on('start-bots', () => {
    startBots();
  });
  socket.on('stop-bots', () => {
    stopBots();
  });

  // Host dashboard commands — broadcast to ALL clients (including viewers)
  socket.on('host-command', (cmd) => {
    console.log(`🎛️ Host command: ${cmd.action}`, cmd.data || '');
    io.emit('host-command', cmd);
  });

  // State sync — host broadcasts positions/mounts to viewers
  socket.on('state-sync', (state) => {
    socket.broadcast.emit('state-sync', state);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Browser client disconnected');
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   TikTok Live Overlay Server                 ║
║──────────────────────────────────────────────║
║   Dashboard:  http://localhost:${PORT}            ║
║   Overlay:    http://localhost:${PORT}/overlay     ║
║   Voice AI:   http://localhost:${PORT}/voice       ║
║   Username:   @${USERNAME.padEnd(28)}║
║──────────────────────────────────────────────║
║   EulerStream: ${process.env.EULER_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}                 ║
║   Voice AI:    ${OPENAI_API_KEY && ELEVENLABS_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}                 ║
╚══════════════════════════════════════════════╝
  `);
});
