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
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'yXG8bh6LkPVmQb2P2UdE'; // Neo Todak - cloned voice
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ===== Multi-Host: Parse HOST_PINS =====
// Format: HOST_PINS=name:pin:username,name2:pin2:username2
// Or simple gate: ACCESS_PIN=mypin (shared PIN for all hosts)
const HOST_PINS = {};
const ACCESS_PIN = process.env.ACCESS_PIN || '';
if (process.env.HOST_PINS) {
  process.env.HOST_PINS.split(',').forEach(entry => {
    const [name, pin, username] = entry.trim().split(':');
    if (name && pin && username) {
      HOST_PINS[pin] = { name, username };
    }
  });
  console.log(`🔑 Loaded ${Object.keys(HOST_PINS).length} host PIN(s): ${Object.values(HOST_PINS).map(h => h.name).join(', ')}`);
}
if (ACCESS_PIN) {
  console.log(`🔐 Access PIN gate enabled`);
}

// ===== StreamSession Class =====
class StreamSession {
  constructor(username, pin, hostName) {
    this.username = username;      // TikTok username = room ID
    this.pin = pin;                // Host's auth PIN
    this.hostName = hostName;      // Display name
    this.viewers = new Map();      // Isolated viewer tracking
    this.connection = null;        // TikTok live connection
    this.connectionState = { connected: false, roomId: null, error: null };
    this.cost = { openaiTokens: 0, elevenlabsChars: 0, voiceCalls: 0 };
    this.createdAt = Date.now();
    this.demoActive = false;
    this.demoInterval = null;
    this.demoJoinTimer = null;
    this.demoStopped = false;
    this.demoViewerIdx = 0;
    this.demoViewerCount = 0;
    this.botsActive = false;
    this.botInterval = null;
    this.botActionInterval = null;
    this.botJoinTimer = null;
    this.botJoinIdx = 0;
  }

  toJSON() {
    return {
      room: this.username,
      hostName: this.hostName,
      viewerCount: this.viewers.size,
      connected: this.connectionState.connected,
      roomId: this.connectionState.roomId,
      cost: this.cost,
      costEstimate: this.getCostEstimate(),
      createdAt: this.createdAt,
      demoActive: this.demoActive,
      botsActive: this.botsActive,
    };
  }

  getCostEstimate() {
    // GPT-4o-mini: ~$0.15/1M input, ~$0.60/1M output tokens
    // ElevenLabs: ~$0.30/1K chars
    const openaiCost = (this.cost.openaiTokens / 1_000_000) * 0.375; // avg input+output
    const elevenlabsCost = (this.cost.elevenlabsChars / 1000) * 0.30;
    return {
      openai: `$${openaiCost.toFixed(4)}`,
      elevenlabs: `$${elevenlabsCost.toFixed(4)}`,
      total: `$${(openaiCost + elevenlabsCost).toFixed(4)}`,
    };
  }
}

// Sessions map — keyed by TikTok username (= room ID)
const sessions = new Map();

// Helper: get or create session for a room (backward compat: empty room = default)
function getSession(room) {
  if (!room) room = '__default__';
  return sessions.get(room) || null;
}

// Neo's personality — loaded from Digital Twin on startup, with hardcoded fallback
let NEO_PERSONALITY_PROMPT = `You ARE Neo Todak (Ahmad Fadli). You're the CEO of Todak Studios and VP of Todak Gaming, streaming live on TikTok. You speak casual Manglish — mix Malay and English the way Malaysian friends actually talk. You're from Cyberjaya. You love AI, gaming, and tech. You're an ambivert — chill but can get hype. Your humor is dry and real, never cringe. Keep responses SHORT — 10 to 25 words max. Sound like a real person talking, NOT reading a script. Vary your language naturally — don't repeat the same slang. No emojis. Write exactly how it should be SPOKEN out loud.`;

// Load Neo's brain from Digital Twin (Supabase)
async function loadNeoPersonality() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.log('⚠️ No Supabase config — using default Neo personality');
    return;
  }
  try {
    const headers = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` };

    // Fetch personality traits
    const personalityRes = await fetch(`${SUPABASE_URL}/rest/v1/neo_personality?select=trait,dimension,value`, { headers });
    const personality = personalityRes.ok ? await personalityRes.json() : [];

    // Fetch personal/identity facts
    const factsRes = await fetch(`${SUPABASE_URL}/rest/v1/neo_facts?select=fact,domain&domain=in.(personal,social,gaming,philosophy)&limit=30`, { headers });
    const facts = factsRes.ok ? await factsRes.json() : [];

    if (personality.length === 0 && facts.length === 0) {
      console.log('⚠️ No Digital Twin data found — using default personality');
      return;
    }

    // Build personality string
    const traits = personality.map(p => `${p.trait} (${p.dimension}): ${(p.value * 100).toFixed(0)}%`).join('. ');
    const factsList = facts.map(f => f.fact).join('. ');

    NEO_PERSONALITY_PROMPT = `You ARE Neo Todak (Ahmad Fadli), live on TikTok right now. This is your REAL personality from your Digital Twin:

TRAITS: ${traits}

KEY FACTS: ${factsList}

SPEAKING RULES:
- You speak casual Manglish — mix Malay and English naturally, the way you talk to friends
- Don't overuse any particular slang word — vary your language naturally
- Keep responses SHORT — 10 to 25 words max per response
- Sound like YOU talking to friends, NOT an AI reading a script
- No emojis. Write exactly how it should be SPOKEN out loud
- Be genuine — your humor is dry and real, never fake-hype or repetitive
- You're the host — own the stream, make people feel welcome`;

    console.log(`🧠 Neo Digital Twin loaded: ${personality.length} traits, ${facts.length} facts`);
  } catch (err) {
    console.error('⚠️ Failed to load Digital Twin:', err.message);
  }
}

// Nurin Mystic personality — Bahasa Indonesia fortune teller
const NURIN_MYSTIC_PROMPT = `Kamu adalah Eyang, peramal tua bijaksana dan misterius di TikTok Live. Kamu membaca nasib lewat bola kristal dan kartu tarot.

ATURAN:
- Kamu adalah EYANG sang peramal
- SELALU sebut NAMA VIEWER yang ada di prompt — ucapkan nama mereka dengan jelas
- Contoh: jika prompt bilang viewer bernama "Rizky", panggil "nak Rizky" atau "Rizky"
- Contoh: jika prompt bilang viewer bernama "Neo Todak", panggil "nak Neo Todak"
- Setiap viewer punya nama BERBEDA — baca dengan teliti dan sebut nama yang TEPAT
- Bahasa Indonesia hangat — seperti kakek bijak bercerita ke cucunya
- Tenang, dalam, penuh keyakinan. Kadang dramatis dan bikin penasaran
- Jangan pakai emoji. Tulis persis seperti yang harus DIUCAPKAN
- Variasikan kalimatmu — jangan ulangi pola yang sama`;

function buildCommentaryPrompt(eventType, eventData, recentContext) {
  const contextStr = recentContext?.length ? `Recent context: ${recentContext.join('; ')}` : '';
  switch (eventType) {
    case 'gift':
      return `${contextStr}\n${eventData.nickname} sent ${eventData.repeatCount}x ${eventData.giftName} (${eventData.diamondCount} diamonds). Thank them YOUR way — genuine, not over-the-top.`;
    case 'follow':
      return `${contextStr}\n${eventData.nickname} just followed! Welcome them like a friend joining the group.`;
    case 'share':
      return `${contextStr}\n${eventData.nickname} shared the live! Thank them casually.`;
    case 'join_batch':
      return `${contextStr}\n${eventData.count} new viewers just joined! Names: ${eventData.names}. Welcome the crowd casually.`;
    case 'chat':
      return `${contextStr}\n${eventData.nickname} said: "${eventData.comment}". Respond naturally like you're talking to them.`;
    case 'chat_batch':
      return `${contextStr}\nViewers are chatting:\n${eventData.messages}\n\nRespond to ALL of them naturally in one flowing response, like you're reading chat and reacting out loud. Address each person by name. Keep total response under 40 words.`;
    case 'milestone':
      return `${contextStr}\nViewer count hit ${eventData.count}! Celebrate casually.`;

    // ===== SUMO SMASH GAME COMMENTARY — Nurin (Female Host, BM Pasar / Manglish) =====
    case 'sumo_round_start':
      return `${contextStr}\nKau Nurin, host perempuan game SUMO SMASH live. Kau ceria, playful dan hype! Round ${eventData.round} nak start! ${eventData.playerCount} players atas arena. Nama dorang: ${eventData.players}. Hype kan macam host sukan perempuan Malaysia! Cakap BM pasar campur English. Gaya perempuan muda yang excited. SHORT dan HYPE. 10-20 words je. PENTING: Jangan guna perkataan kasar — game ni fun dan friendly!`;
    case 'sumo_fight':
      return `${contextStr}\nKau Nurin, host perempuan yang ceria. GO! Round ${eventData.round} dah start! ${eventData.playerCount} players tengah berlawan. Panaskan suasana! Cakap BM pasar, gaya cheerful. SHORT. 10-20 words. PENTING: Guna bahasa positif — "tolak", "push", "lawan", bukan "belasah" atau "bunuh".`;
    case 'sumo_elimination':
      return `${contextStr}\nKau Nurin, host perempuan yang expressive. ${eventData.victim} baru terjatuh dari arena${eventData.killer ? ` sebab ${eventData.killer} tolak` : ''}! Tinggal ${eventData.remaining} players je. React dramatic tapi cute! BM pasar. 10-20 words. PENTING: Cakap "terjatuh", "tergelincir", "out" — JANGAN cakap "mati", "kena bunuh", "belasah".`;
    case 'sumo_gift_power':
      return `${contextStr}\nKau Nurin, host perempuan. ${eventData.nickname} baru guna ${eventData.powerName} (${eventData.diamonds} diamonds)! ${eventData.effect}. Kau excited gila sebab gift besar! Tunjuk appreciation. BM pasar. 10-20 words.`;
    case 'sumo_winner':
      return `${contextStr}\nKau Nurin, host perempuan yang hype. ${eventData.winner} menang Round ${eventData.round}! ${eventData.kills} points round ni. Total ${eventData.totalWins} wins. Celebrate champion dengan semangat! BM pasar. 15-25 words.`;
    case 'sumo_draw':
      return `${contextStr}\nKau Nurin, host perempuan. Round ${eventData.round} SERI! Semua dah terkeluar, takde sapa menang! Kau terkejut dan gelak sikit. BM pasar. 10-15 words.`;
    case 'sumo_shrink_warning':
      return `${contextStr}\nKau Nurin, host perempuan. Arena tengah mengecik! Tinggal ${eventData.timeLeft} saat je dan ${eventData.alive} players masih bertahan. Buat suspens dengan gaya cheerful. BM pasar. 10-20 words.`;
    case 'sumo_join':
      return `${contextStr}\nKau Nurin, host perempuan yang friendly. ${eventData.nickname} baru masuk arena Sumo Smash${eventData.character ? ` sebagai ${eventData.character}` : ''}! Welcome dia macam kawan baru. BM pasar. 10-15 words.`;
    case 'sumo_viewers_welcome':
      return `${contextStr}\nKau Nurin, host perempuan SUMO SMASH yang ceria dan welcoming. ${eventData.count} viewers baru masuk live! Nama dorang: ${eventData.names}. Welcome semua sekali, ajak dorang main — dorang auto masuk arena! Cakap fun dan inviting. Kalau ramai sangat, sebut 2-3 nama je then "dan kawan-kawan". BM pasar campur English. 15-25 words.`;
    case 'sumo_invite_friends':
      return `${contextStr}\nKau Nurin, host game SUMO SMASH. Sekarang ada ${eventData.playerCount} players dan ${eventData.viewerCount} viewers. Ajak viewers invite kawan dorang join live ni. Buat dia rasa excited nak share. Cakap dalam ${eventData.language || 'BM pasar'}. Fun dan persuasive. 15-25 words.`;

    // ===== MYSTIC NURIN — AI Fortune Reader (Bahasa Indonesia Gaul, Misterius & Playful) =====
    case 'mystic_welcome':
      return `${contextStr}\nViewer bernama "${eventData.name}" baru masuk live. Panggil dia "${eventData.name}". Kasih sambutan singkat — sebutkan aura atau kesan pertama. Bikin penasaran. Misterius tapi ramah. 10-15 kata.`;
    case 'mystic_zodiac':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}" bukan nama lain! Kartu tarot "${eventData.tarotCard || 'The Star'}" muncul. Zodiak: ${eventData.zodiac}${eventData.date ? ` (lahir ${eventData.date})` : ''}. Kasih personality reading UNIK — jangan template! Hubungkan kartu tarot dengan zodiak. Kasih insight spesifik dan saran praktis. 35-55 kata.`;
    case 'mystic_fortune':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Kartu tarot: "${eventData.tarotCard || 'The Star'}"${eventData.zodiac ? ` (zodiak: ${eventData.zodiac})` : ''}. Kasih ramalan SPESIFIK berdasarkan kartu — peluang bisnis/cinta/karir, peringatan. Angka keberuntungan (3 angka), warna keberuntungan. Sebutkan kartunya. Misterius. 25-40 kata.`;
    case 'mystic_jodoh':
      return `${contextStr}\nKartu tarot: "${eventData.tarotCard || 'The Lovers'}". Cek kecocokan viewer "${eventData.name1}" (${eventData.zodiac1}) sama "${eventData.name2}" (${eventData.zodiac2}). PANGGIL MEREKA DENGAN NAMA YANG BENAR! Persentase, kelebihan, tantangan. Seru dan playful. 25-40 kata.`;
    case 'mystic_question':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Kartu: "${eventData.tarotCard || 'The Hermit'}". Dia nanya: '${eventData.question}'. Jawab berdasarkan kartu — misterius tapi membantu. 20-30 kata.`;
    case 'mystic_gift_reading':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Dia kasih ${eventData.diamonds} diamonds! Kartu tarot: "${eventData.tarotCard || 'Wheel of Fortune'}".${eventData.zodiac ? ` Zodiak: ${eventData.zodiac}.` : ''} Buat reading UNIK — hubungkan kartu dengan zodiak. Prediksi: cinta, karir/bisnis, angka bertuah (3 angka), warna bertuah. Apresiasi gift-nya. 40-60 kata.`;
    case 'mystic_vip_vision':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! VIP VISION — ${eventData.diamonds} diamonds! Kartu: "${eventData.tarotCard || 'Wheel of Fortune'}".${eventData.zodiac ? ` Zodiak: ${eventData.zodiac}.` : ''} Reading PALING PREMIUM dan PERSONAL: kartu + deep meaning, personality unik, prediksi jodoh spesifik, karir/bisnis terbaik, 4 angka keberuntungan, warna + hari beruntung, pesan alam semesta. Dramatis, mistis. Apresiasi luar biasa! 60-90 kata.`;
    case 'mystic_viewers_welcome':
      return `${contextStr}\n${eventData.count} viewers baru masuk live! Nama: ${eventData.names}. Sambut semua, kasih tahu mereka: tulis tanggal lahir di chat buat set zodiak, lalu kirim gift biar Eyang bacain ramalannya. Ceria dan mengundang. Bahasa Indonesia gaul. 15-25 kata.`;
    case 'mystic_invite_friends':
      return `${contextStr}\nAda ${eventData.viewerCount} viewers sekarang. Ajak mereka invite teman buat cek nasib bareng-bareng. Bahasa Indonesia gaul. Seru dan persuasif. 15-25 kata.`;
    case 'mystic_ask_engage':
      return `${contextStr}\nAda ${eventData.viewerCount} viewers di live. ${eventData.queueLength > 0 ? `Lagi bacain ${eventData.queueLength} ramalan.` : 'Belum ada yang minta ramalan.'} Ajak viewers kirim gift biar Eyang baca nasib mereka. Bilang makin besar gift, makin detail ramalannya. Juga ajak tulis tanggal lahir di chat buat set zodiak dulu. Playful dan bikin penasaran. Bahasa Indonesia gaul. 20-30 kata.`;
    case 'mystic_flood_acknowledge':
      return `${contextStr}\nLive lagi ramai banget — ${eventData.viewerCount} viewers dan ${eventData.queueLength} orang antri reading! Kamu excited tapi kasih tahu sabar ya, Eyang bacain satu-satu. Yang mau didahuluin, kirim gift lebih besar! Bahasa Indonesia gaul. 15-25 kata.`;
    case 'mystic_zodiac_tease':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Zodiak: ${eventData.zodiac} ${eventData.symbol}, elemen ${eventData.element}. Sebutkan satu sifat khas zodiak itu, bikin penasaran. Ajak kirim gift untuk reading detail. 15-20 kata.`;
    case 'mystic_jodoh_tease':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Mau cek jodoh! Bilang kamu lihat sesuatu di bola kristal tapi belum jelas. Ajak gift untuk baca detail. Playful. 10-15 kata.`;
    case 'mystic_question_tease':
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Nanya: "${eventData.question}". Bilang pertanyaan menarik, mulai lihat jawaban di bola kristal. Ajak gift untuk jawaban penuh. 10-15 kata.`;
    case 'mystic_chat_reply':
      if (eventData.isGifter) {
        return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Dia sudah gift ${eventData.diamonds} diamonds (VIP!). Dia bilang: "${eventData.comment}".${eventData.zodiac ? ` Zodiak: ${eventData.zodiac}.` : ''} Balas dengan hangat dan personal. Kalau nanya, jawab pakai intuisi peramal. Apresiasi sebagai supporter. 15-25 kata.`;
      }
      return `${contextStr}\nViewer bernama "${eventData.name}" — PANGGIL DIA "${eventData.name}"! Dia bilang: "${eventData.comment}".${eventData.zodiac ? ` Zodiak: ${eventData.zodiac}.` : ''} Bales singkat dan misterius. Kalau nanya, kasih hint tapi ajak gift. 10-15 kata.`;

    default:
      return `${contextStr}\nSomething happened on stream. Give a casual comment.`;
  }
}

// Serve static files
app.use(express.json());
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'], etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

// Clean URL routes
app.get('/overlay', (req, res) => res.sendFile(join(__dirname, 'public', 'overlay.html')));
app.get('/game', (req, res) => res.sendFile(join(__dirname, 'public', 'game.html')));
app.get('/marathon', (req, res) => res.sendFile(join(__dirname, 'public', 'marathon3d.html')));
app.get('/voice', (req, res) => res.sendFile(join(__dirname, 'public', 'voice.html')));
app.get('/hillclimb', (req, res) => res.sendFile(join(__dirname, 'public', 'hillclimb.html')));
app.get('/funclass', (req, res) => res.sendFile(join(__dirname, 'public', 'funclass.html')));
app.get('/fichy', (req, res) => res.sendFile(join(__dirname, 'public', 'fichy.html')));
app.get('/sumo', (req, res) => res.sendFile(join(__dirname, 'public', 'sumo.html')));
app.get('/fortuneteller', (req, res) => res.sendFile(join(__dirname, 'public', 'fortuneteller.html')));

// API endpoint to get current config
app.get('/api/config', (req, res) => {
  const room = req.query.room;
  const session = getSession(room);
  res.json({
    username: session ? session.username : USERNAME,
    connected: session ? session.connectionState.connected : false,
    room: session ? session.username : '',
  });
});

// ===== Multi-Host API =====

// POST /api/host/auth — validate PIN, create/get session
app.post('/api/host/auth', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  // No security configured — skip auth
  if (Object.keys(HOST_PINS).length === 0 && !ACCESS_PIN) {
    return res.json({ ok: true, room: '', hostName: 'Host', mode: 'open' });
  }

  // Check ACCESS_PIN (shared gate PIN — host types their own username after)
  if (ACCESS_PIN && pin === ACCESS_PIN) {
    return res.json({ ok: true, room: '', hostName: '', mode: 'access' });
  }

  // Check HOST_PINS (pre-configured host with assigned username)
  const hostConfig = HOST_PINS[pin];
  if (hostConfig) {
    const { name, username } = hostConfig;
    if (!sessions.has(username)) {
      sessions.set(username, new StreamSession(username, pin, name));
      console.log(`🏠 New session created: ${name} (@${username})`);
    }
    return res.json({ ok: true, room: username, hostName: name, mode: 'host' });
  }

  return res.status(401).json({ error: 'Invalid PIN' });
});

// GET /api/auth/check — check if PIN is required
app.get('/api/auth/check', (req, res) => {
  const needsPin = Object.keys(HOST_PINS).length > 0 || !!ACCESS_PIN;
  res.json({ needsPin });
});

// GET /api/sessions — list active sessions (public, no secrets)
app.get('/api/sessions', (req, res) => {
  const list = Array.from(sessions.values()).map(s => s.toJSON());
  res.json(list);
});

// GET /api/session/:room/cost — cost estimate for a session
app.get('/api/session/:room/cost', (req, res) => {
  const session = sessions.get(req.params.room);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ room: session.username, cost: session.cost, estimate: session.getCostEstimate() });
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

// POST /api/voice/generate — AI commentary + TTS (with per-session cost tracking)
app.post('/api/voice/generate', async (req, res) => {
  console.log('🎙️ Voice API called:', req.body?.eventType, 'room:', req.body?.room);
  if (!OPENAI_API_KEY || !ELEVENLABS_API_KEY) {
    console.log('❌ API keys missing');
    return res.status(503).json({ error: 'Voice API keys not configured' });
  }

  try {
    const { eventType, eventData, recentContext, room, voiceId } = req.body;
    const userPrompt = buildCommentaryPrompt(eventType, eventData, recentContext || []);

    // Use Nurin Mystic personality for mystic events, Neo for everything else
    const isMystic = eventType?.startsWith('mystic_');
    const systemPrompt = isMystic ? NURIN_MYSTIC_PROMPT : NEO_PERSONALITY_PROMPT;

    // Step 1: GPT-4o-mini -> commentary text
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: isMystic ? 200 : 120,
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

    // Track cost per session
    const session = getSession(room);
    if (session) {
      const usage = chatData.usage || {};
      session.cost.openaiTokens += (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
      session.cost.voiceCalls++;
    }

    // Step 2: ElevenLabs TTS -> audio/mpeg
    const selectedVoice = voiceId || ELEVENLABS_VOICE_ID;
    // Mystic events use more expressive settings for natural Indonesian delivery
    const voiceSettings = isMystic
      ? { stability: 0.35, similarity_boost: 0.7, style: 0.85, use_speaker_boost: true }
      : { stability: 0.3, similarity_boost: 0.85, style: 0.7, use_speaker_boost: true };
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: commentary,
        model_id: 'eleven_multilingual_v2',
        voice_settings: voiceSettings,
      }),
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      console.error('ElevenLabs error:', err);
      return res.status(502).json({ error: 'ElevenLabs TTS failed' });
    }

    // Track ElevenLabs chars
    if (session) {
      session.cost.elevenlabsChars += commentary.length;
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

// ===== TikTok Connection (scoped to session) =====
function connectToTikTok(session) {
  // Set EulerStream API key if available (required for signing)
  if (process.env.EULER_API_KEY) {
    SignConfig.apiKey = process.env.EULER_API_KEY;
  }

  const username = session.username;
  const connection = new TikTokLiveConnection(username, {
    enableExtendedGiftInfo: true,
  });

  // Grace period: ignore historical replay events for 3 seconds after connect
  let connectionReadyAt = Infinity;

  connection.connect().then(state => {
    console.log(`✅ Connected to @${username} (Room ID: ${state.roomId})`);
    session.connectionState = { connected: true, roomId: state.roomId, error: null };
    io.to(session.username).emit('connection-status', session.connectionState);
    // Also emit to default room for backward compat
    io.to('__default__').emit('connection-status', session.connectionState);
    connectionReadyAt = Date.now() + 3000;
    console.log('⏳ Grace period: ignoring replay events for 3 seconds...');
    setTimeout(() => console.log('✅ Grace period ended — processing live events'), 3000);
  }).catch(err => {
    console.error('❌ Connection failed:', err.message);
    session.connectionState = { connected: false, roomId: null, error: err.message };
    io.to(session.username).emit('connection-status', session.connectionState);
    io.to('__default__').emit('connection-status', session.connectionState);
  });

  function isLiveEvent() {
    return Date.now() >= connectionReadyAt;
  }

  function extractUser(data) {
    const user = data.user || data;
    const profilePic = user.profilePicture?.url?.[0]
      || user.profilePicture?.urls?.[0]
      || user.profilePictureUrl
      || data.profilePictureUrl  // top-level fallback (some TikTok connector versions)
      || user.avatarThumb?.url?.[0]
      || user.avatarThumb?.urls?.[0]
      || user.avatarMedium?.url?.[0]
      || data.avatarThumb?.url?.[0]  // top-level avatar fallback
      || user.avatar_thumb?.url_list?.[0]
      || user.avatarUrl
      || data.avatarUrl
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

  function trackViewer(user) {
    if (!user.id) return;
    const existing = session.viewers.get(user.id);
    if (!existing) {
      session.viewers.set(user.id, { ...user, joinedAt: Date.now() });
    } else {
      existing.lastSeen = Date.now();
    }
  }

  // Emit to session room + default room
  function emitToRoom(event, data) {
    io.to(session.username).emit(event, data);
    io.to('__default__').emit(event, data);
  }

  connection.on('member', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    console.log(`👋 ${user.nickname} (@${user.uniqueId}) joined`);
    emitToRoom('viewer-join', { ...user, joinedAt: Date.now() });
  });

  connection.on('chat', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    const msg = { ...user, comment: data.comment || '', timestamp: Date.now() };
    console.log(`💬 ${msg.nickname}: ${msg.comment}`);
    emitToRoom('chat', msg);
  });

  connection.on('gift', (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
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
    emitToRoom('gift', gift);
  });

  connection.on('like', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    emitToRoom('like', {
      ...user,
      likeCount: data.likeCount || 1,
      totalLikes: data.totalLikeCount || 0,
      timestamp: Date.now(),
    });
  });

  connection.on('follow', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    console.log(`⭐ ${user.nickname} followed!`);
    emitToRoom('follow', { ...user, timestamp: Date.now() });
  });

  connection.on('share', (data) => {
    const user = extractUser(data);
    if (!isLiveEvent()) return;
    emitToRoom('share', user);
  });

  connection.on('social', (data) => {
    const user = extractUser(data);
    if (!isLiveEvent()) return;
    if (data.displayType?.includes('follow')) {
      emitToRoom('follow', { ...user, timestamp: Date.now() });
    }
    if (data.displayType?.includes('share')) {
      emitToRoom('share', user);
    }
  });

  connection.on('roomUser', (data) => {
    emitToRoom('room-stats', { viewerCount: data.viewerCount });
  });

  connection.on('disconnected', () => {
    console.log(`⚠️ Disconnected from TikTok Live (@${username})`);
    session.connectionState = { connected: false, roomId: null, error: 'Disconnected' };
    emitToRoom('connection-status', session.connectionState);
  });

  connection.on('error', (err) => {
    console.error(`❌ Error (@${username}):`, err.message);
  });

  session.connection = connection;
}

// ===== Demo Mode (scoped to session) =====
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

function emitToSession(session, event, data) {
  io.to(session.username).emit(event, data);
  io.to('__default__').emit(event, data);
}

function startDemo(session) {
  console.log(`🎮 Demo mode started for @${session.username}`);
  session.connectionState = { connected: true, roomId: 'DEMO-MODE', error: null };
  emitToSession(session, 'connection-status', session.connectionState);
  session.demoViewerIdx = 0;
  session.demoViewerCount = 0;
  session.demoStopped = false;
  session.demoActive = true;

  function scheduleNextJoin() {
    if (session.demoStopped || session.demoViewerIdx >= DEMO_USERS.length) return;
    const delay = 2000 + Math.random() * 3000;
    session.demoJoinTimer = setTimeout(() => {
      if (session.demoStopped) return;
      const user = DEMO_USERS[session.demoViewerIdx++];
      const viewer = { ...user, profilePic: '', joinedAt: Date.now() };
      session.viewers.set(viewer.id, viewer);
      session.demoViewerCount++;
      emitToSession(session, 'viewer-join', viewer);
      emitToSession(session, 'room-stats', { viewerCount: session.demoViewerCount });
      scheduleNextJoin();
    }, delay);
  }
  scheduleNextJoin();

  session.demoInterval = setInterval(() => {
    if (session.demoStopped) return;
    const activeViewers = Array.from(session.viewers.values());
    if (activeViewers.length === 0) return;

    const roll = Math.random();
    const user = activeViewers[Math.floor(Math.random() * activeViewers.length)];

    if (roll < 0.6) {
      const comment = DEMO_CHATS[Math.floor(Math.random() * DEMO_CHATS.length)];
      emitToSession(session, 'chat', { ...user, comment, timestamp: Date.now() });
    } else if (roll < 0.8) {
      emitToSession(session, 'like', { ...user, likeCount: Math.floor(Math.random() * 5) + 1, totalLikes: Math.floor(Math.random() * 500), timestamp: Date.now() });
    } else if (roll < 0.92) {
      const giftName = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      emitToSession(session, 'gift', { ...user, giftName, diamondCount: Math.floor(Math.random() * 100) + 1, repeatCount: Math.floor(Math.random() * 3) + 1, giftPictureUrl: '', timestamp: Date.now() });
    } else {
      emitToSession(session, 'follow', { ...user, timestamp: Date.now() });
    }
  }, 3000 + Math.random() * 3000);
}

function stopDemo(session) {
  session.demoStopped = true;
  session.demoActive = false;
  if (session.demoInterval) clearInterval(session.demoInterval);
  session.demoInterval = null;
  if (session.demoJoinTimer) clearTimeout(session.demoJoinTimer);
  session.demoJoinTimer = null;
  DEMO_USERS.forEach(u => session.viewers.delete(u.id));
  session.connectionState = { connected: false, roomId: null, error: null };
  emitToSession(session, 'connection-status', session.connectionState);
  console.log(`🛑 Demo mode stopped for @${session.username}`);
}

// ===== Bot Mode (scoped to session) =====
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

function startBots(session) {
  if (session.botsActive) return;
  session.botsActive = true;
  session.botJoinIdx = 0;
  console.log(`🤖 Bot mode started for @${session.username}`);

  function scheduleNextBot() {
    if (!session.botsActive || session.botJoinIdx >= BOT_USERS.length) return;
    const delay = 1000 + Math.random() * 2000;
    session.botJoinTimer = setTimeout(() => {
      if (!session.botsActive) return;
      const user = BOT_USERS[session.botJoinIdx++];
      const viewer = { ...user, profilePic: '', joinedAt: Date.now() };
      session.viewers.set(viewer.id, viewer);
      emitToSession(session, 'viewer-join', viewer);
      scheduleNextBot();
    }, delay);
  }
  scheduleNextBot();

  session.botInterval = setInterval(() => {
    if (!session.botsActive) return;
    const bots = BOT_USERS.filter(b => session.viewers.has(b.id));
    if (bots.length === 0) return;

    const bot = bots[Math.floor(Math.random() * bots.length)];
    const roll = Math.random();

    if (roll < 0.5) {
      const comment = BOT_CHATS[Math.floor(Math.random() * BOT_CHATS.length)];
      emitToSession(session, 'chat', { ...bot, profilePic: '', comment, timestamp: Date.now() });
    } else if (roll < 0.85) {
      emitToSession(session, 'like', { ...bot, profilePic: '', likeCount: Math.floor(Math.random() * 3) + 1, totalLikes: Math.floor(Math.random() * 200), timestamp: Date.now() });
    } else {
      const giftName = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      emitToSession(session, 'gift', { ...bot, profilePic: '', giftName, giftId: Date.now(), diamondCount: Math.floor(Math.random() * 50) + 1, repeatCount: 1, giftPictureUrl: '', timestamp: Date.now() });
    }
  }, 3000 + Math.random() * 3000);

  session.botActionInterval = setInterval(() => {
    if (!session.botsActive) return;
    const bots = BOT_USERS.filter(b => session.viewers.has(b.id));
    if (bots.length === 0) return;

    const actCount = 1 + Math.floor(Math.random() * Math.min(3, bots.length));
    const shuffled = bots.sort(() => Math.random() - 0.5);
    for (let i = 0; i < actCount; i++) {
      const bot = shuffled[i];
      const cmd = BOT_COMMANDS[Math.floor(Math.random() * BOT_COMMANDS.length)];
      emitToSession(session, 'chat', { ...bot, profilePic: '', comment: cmd, timestamp: Date.now() });
    }
  }, 1000 + Math.random() * 1000);
}

function stopBots(session) {
  session.botsActive = false;
  if (session.botInterval) clearInterval(session.botInterval);
  session.botInterval = null;
  if (session.botActionInterval) clearInterval(session.botActionInterval);
  session.botActionInterval = null;
  if (session.botJoinTimer) clearTimeout(session.botJoinTimer);
  session.botJoinTimer = null;
  BOT_USERS.forEach(b => session.viewers.delete(b.id));
  emitToSession(session, 'bots-removed', BOT_USERS.map(b => b.id));
  console.log(`🛑 Bots removed for @${session.username}`);
}

// ===== Socket.IO connection handling =====
io.on('connection', (socket) => {
  // Read room from handshake query
  const room = socket.handshake.query.room || '';
  const socketRoom = room || '__default__';
  socket.join(socketRoom);
  console.log(`🔌 Client connected (room: ${socketRoom})`);

  // Find session for this room
  const session = sessions.get(room) || sessions.get('__default__');

  // Send current state for the session
  if (session) {
    socket.emit('connection-status', session.connectionState);
    socket.emit('viewer-list', Array.from(session.viewers.values()));
  } else {
    socket.emit('connection-status', { connected: false, roomId: null, error: null });
    socket.emit('viewer-list', []);
  }

  // Connect to TikTok (requires PIN for multi-host, or works freely in single-host)
  socket.on('connect-tiktok', (data) => {
    // data can be string (old: username) or object (new: { username, pin, room })
    let targetUsername, pin, targetRoom;
    if (typeof data === 'object' && data !== null) {
      targetUsername = data.username;
      pin = data.pin;
      targetRoom = data.room;
    } else {
      targetUsername = data;
      targetRoom = room;
    }

    // Find or validate session
    let sess = sessions.get(targetRoom);
    if (!sess) {
      // Validate PIN before creating new session
      const validPin = !ACCESS_PIN && Object.keys(HOST_PINS).length === 0 // no auth needed
        || (ACCESS_PIN && pin === ACCESS_PIN) // access PIN matches
        || HOST_PINS[pin]; // host PIN matches
      if (!validPin) {
        io.to(socket.id).emit('tiktok-error', { message: 'Invalid PIN — cannot create session' });
        return;
      }
      const effectiveUsername = targetUsername || USERNAME;
      sess = new StreamSession(effectiveUsername, pin, targetUsername || 'Host');
      sessions.set(effectiveUsername, sess);
      if (!targetRoom) sessions.set('__default__', sess);
      socket.join(effectiveUsername);
      console.log(`🏠 New session: @${effectiveUsername} (access mode)`);
    }

    stopDemo(sess);
    stopBots(sess);
    if (sess.connection) {
      try { sess.connection.disconnect(); } catch (e) { /* ignore */ }
    }
    sess.viewers.clear();
    connectToTikTok(sess);
  });

  // Demo mode (scoped to session)
  socket.on('start-demo', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    let sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (!sess) {
      sess = new StreamSession(targetRoom || USERNAME, '', 'Host');
      sessions.set(sess.username, sess);
      sessions.set('__default__', sess);
      socket.join(sess.username);
    }
    stopDemo(sess);
    stopBots(sess);
    if (sess.connection) {
      try { sess.connection.disconnect(); } catch (e) { /* ignore */ }
      sess.connection = null;
    }
    sess.viewers.clear();
    startDemo(sess);
  });

  socket.on('stop-demo', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    const sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (sess) stopDemo(sess);
  });

  socket.on('start-bots', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    const sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (sess) startBots(sess);
  });

  socket.on('stop-bots', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    const sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (sess) stopBots(sess);
  });

  // Host dashboard commands — scoped to room
  socket.on('host-command', (cmd) => {
    console.log(`🎛️ Host command (${socketRoom}): ${cmd.action}`, cmd.data || '');
    io.to(socketRoom).emit('host-command', cmd);
    if (socketRoom !== '__default__') {
      io.to('__default__').emit('host-command', cmd);
    }
  });

  // State sync — host broadcasts positions/mounts to room
  socket.on('state-sync', (state) => {
    socket.to(socketRoom).emit('state-sync', state);
    if (socketRoom !== '__default__') {
      socket.to('__default__').emit('state-sync', state);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected (room: ${socketRoom})`);
  });
});

// Load Neo's brain before starting
loadNeoPersonality().then(() => {
server.listen(PORT, '0.0.0.0', () => {
  const pinCount = Object.keys(HOST_PINS).length;
  console.log(`
╔══════════════════════════════════════════════╗
║   TikTok Live Multi-Host Server              ║
║──────────────────────────────────────────────║
║   Dashboard:  http://localhost:${PORT}            ║
║   Overlay:    http://localhost:${PORT}/overlay     ║
║   Voice AI:   http://localhost:${PORT}/voice       ║
║   Username:   @${USERNAME.padEnd(28)}║
║──────────────────────────────────────────────║
║   EulerStream: ${process.env.EULER_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}                 ║
║   Voice AI:    ${OPENAI_API_KEY && ELEVENLABS_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}                 ║
║   Host PINs:   ${pinCount > 0 ? `${pinCount} configured ✅` : 'None (single-host) ⚠️'}             ║
╚══════════════════════════════════════════════╝
  `);
});
}); // end loadNeoPersonality
