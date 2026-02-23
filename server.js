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

// Serve static files
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

// Clean URL routes
app.get('/overlay', (req, res) => res.sendFile(join(__dirname, 'public', 'overlay.html')));
app.get('/game', (req, res) => res.sendFile(join(__dirname, 'public', 'game.html')));
app.get('/marathon', (req, res) => res.sendFile(join(__dirname, 'public', 'marathon3d.html')));

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

  connection.connect().then(state => {
    console.log(`✅ Connected to @${username} (Room ID: ${state.roomId})`);
    connectionState = { connected: true, roomId: state.roomId, error: null };
    io.emit('connection-status', connectionState);
  }).catch(err => {
    console.error('❌ Connection failed:', err.message);
    connectionState = { connected: false, roomId: null, error: err.message };
    io.emit('connection-status', connectionState);
  });

  // Helper to extract user info from event data
  function extractUser(data) {
    // v2 API: user data may be nested under different structures
    const user = data.user || data;
    return {
      id: (user.userId || user.uniqueId || '')?.toString(),
      uniqueId: user.uniqueId || '',
      nickname: user.nickname || user.uniqueId || 'Unknown',
      profilePic: user.profilePicture?.url?.[0] || user.profilePictureUrl || '',
      isFollower: (user.followRole || 0) >= 1,
      isModerator: user.isModerator || false,
    };
  }

  // Viewer joins
  connection.on('member', (data) => {
    const user = extractUser(data);
    const viewer = { ...user, joinedAt: Date.now() };
    viewers.set(viewer.id, viewer);
    console.log(`👋 ${viewer.nickname} (@${viewer.uniqueId}) joined`);
    io.emit('viewer-join', viewer);
  });

  // Chat messages
  connection.on('chat', (data) => {
    const user = extractUser(data);
    const msg = { ...user, comment: data.comment || '', timestamp: Date.now() };
    console.log(`💬 ${msg.nickname}: ${msg.comment}`);
    io.emit('chat', msg);
  });

  // Gifts
  connection.on('gift', (data) => {
    // Only emit when gift streak ends or for non-streakable gifts
    if (data.giftType === 1 && !data.repeatEnd) return;

    const user = extractUser(data);
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
    console.log(`⭐ ${user.nickname} followed!`);
    io.emit('follow', { ...user, timestamp: Date.now() });
  });

  // Share (v2 has separate event)
  connection.on('share', (data) => {
    const user = extractUser(data);
    io.emit('share', user);
  });

  // Social (fallback for older API)
  connection.on('social', (data) => {
    const user = extractUser(data);
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
  viewers.clear();
  connectionState = { connected: false, roomId: null, error: null };
  io.emit('connection-status', connectionState);
  console.log('🛑 Demo mode stopped');
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
    if (tiktokConnection) {
      try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
    }
    viewers.clear();
    connectToTikTok(username || USERNAME);
  });

  // Demo mode toggle
  socket.on('start-demo', () => {
    stopDemo();
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
║   Username:   @${USERNAME.padEnd(28)}║
║──────────────────────────────────────────────║
║   EulerStream: ${process.env.EULER_API_KEY ? 'Configured' : 'NOT SET'}                    ║
╚══════════════════════════════════════════════╝
  `);
});
