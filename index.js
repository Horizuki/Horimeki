// =======================================================================
// ===                    HORIMEKI - STAY VOICE BOT                    ===
// ===                         VERSION 3.6                             ===
// =======================================================================

const { Client } = require('discord.js-selfbot-v13');
const { joinVoiceChannel,entersState,VoiceConnectionStatus } = require('@discordjs/voice');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const MAX_RECONNECT = 10;
const DISCONNECTED_GRACE_MS = 5000;
const READY_TIMEOUT_MS = 15000;

const STICKY_TARGET = true;
const STICKY_DEBOUNCE_MS = 800;
const STICKY_COOLDOWN_MS = 5000;

const client = new Client({ checkUpdate: false });

let connection = null;
let targetGuildId = null;
let targetChannelId = null;

let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnecting = false;
let reconnectGen = 0;
let permanentBlockReason = null;
let lastReadyAt = 0;

let stickyTimer = null;
let lastStickyPullAt = 0;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

const q = (prompt) => new Promise((res) => rl.question(prompt, res));

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);
const err = (...a) => console.error(...a);


/** Xóa bỏ mọi timer đang chờ kết nối lại. */
function clearReconnect() {
  reconnecting = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/** Dừng vĩnh viễn việc kết nối lại và reset mục tiêu. */
function stopReconnectPermanently(reason, note) {
  permanentBlockReason = reason;
  clearReconnect();
  targetGuildId = null;
  targetChannelId = null;
  warn(`[✕] Dừng reconnect vĩnh viễn: ${reason}${note ? ' - ' + note : ''}`);
  log('[ℹ] Dùng lệnh "join" để chọn kênh khác.');
}


function isVoiceLike(ch) {
  return (
    //  discord.js v13
    ch?.type === 2 || ch?.type === 13 ||

    // discord.js v14
    ch?.type === 'GUILD_VOICE' || ch?.type === 'GUILD_STAGE_VOICE' || 
    
    ch?.isVoice?.() === true
  );
}

function canViewAndConnect(ch) {
  try {
    const me = ch.guild?.members?.cache?.get(client.user.id);
    if (!me) return false;
    const perms = ch.permissionsFor(me);
    return perms?.has?.(['ViewChannel', 'Connect']) ?? false;
  } catch {
    return true;
  }
}

/**
 * Cố gắng kết nối lại vào kênh thoại mục tiêu với độ trễ tăng dần.
 * @param {string} source Nguồn gọi hàm (để debug).
 */
function attemptReconnect(source = 'unknown') {
  if (permanentBlockReason) {
    log(`[↻] Bỏ qua reconnect (${source}) vì lỗi vĩnh viễn: ${permanentBlockReason}`);
    return;
  }
  if (!targetGuildId || !targetChannelId) return;
  if (reconnecting) return;

  if (reconnectAttempts >= MAX_RECONNECT) {
    warn(`[!] Dừng thử kết nối sau ${MAX_RECONNECT} lần.`);
    return;
  }

  reconnecting = true;

  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
  reconnectAttempts++;
  const myGen = ++reconnectGen;

  log(`[↻] Thử kết nối lại lần ${reconnectAttempts}/${MAX_RECONNECT} sau ${Math.round(delay/1000)}s... (src=${source}, gen=${myGen})`);
  
  if (reconnectTimer) clearTimeout(reconnectTimer);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = false;
    if (myGen !== reconnectGen) return;

    const guild = client.guilds.cache.get(targetGuildId);
    if (!guild) return stopReconnectPermanently('CHANNEL_NOT_FOUND', '(guild)');
    const ch = guild.channels.cache.get(targetChannelId);
    if (!ch) return stopReconnectPermanently('CHANNEL_NOT_FOUND', `(channel ${targetChannelId})`);
    if (!isVoiceLike(ch)) return stopReconnectPermanently('CHANNEL_NOT_FOUND', '(not voice)');
    if (!canViewAndConnect(ch)) return stopReconnectPermanently('MISSING_PERMISSIONS', ch.name);

    joinVC(targetGuildId, targetChannelId);
  }, delay);
}

/**
 * Hàm chính để tham gia hoặc chuyển kênh thoại.
 * @param {string} guildId
 * @param {string} channelId
 */
async function joinVC(guildId, channelId) {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) throw new Error('Server không tồn tại');
    const ch = guild.channels.cache.get(channelId);
    if (!ch) {
      stopReconnectPermanently('CHANNEL_NOT_FOUND', `(ID: ${channelId})`);
      return;
    }
    if (!isVoiceLike(ch)) throw new Error('Đây không phải kênh thoại');
    if (!canViewAndConnect(ch)) {
      stopReconnectPermanently('MISSING_PERMISSIONS', ch.name);
      return;
    }

    targetGuildId = guildId;
    targetChannelId = channelId;
    permanentBlockReason = null;

    clearReconnect();
    reconnectGen++;

  
    if (connection) {
      try {
        connection.removeAllListeners();
        connection.destroy();
      } catch {}
      connection = null;
    }

    log(`[↻] Đang tham gia kênh: ${ch.name}...`);
    connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

  
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    log(`[+] Đã tham gia thành công: ${ch.name} (${channelId})`);
    
  
    reconnectAttempts = 0;
    clearReconnect();
    lastReadyAt = Date.now();

  
    connection.on('stateChange', async (oldS, newS) => {
      if (newS.status === VoiceConnectionStatus.Disconnected) {
      
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, DISCONNECTED_GRACE_MS),
            entersState(connection, VoiceConnectionStatus.Connecting, DISCONNECTED_GRACE_MS),
          ]);
        } catch {
          warn('[!] Mất kết nối voice. Đang thử kết nối lại...');
          attemptReconnect('stateChange');
        }
      } else if (newS.status === VoiceConnectionStatus.Destroyed) {
      
        if (targetGuildId && targetChannelId && !permanentBlockReason) {
          attemptReconnect('destroyed');
        }
      } else if (newS.status === VoiceConnectionStatus.Ready) {
      
        reconnectAttempts = 0;
        clearReconnect();
        lastReadyAt = Date.now();
      }
    });

    connection.on('error', (e) => {
      err('[!] Voice connection error:', e.message);
      attemptReconnect('conn-error');
    });

  } catch (e) {
    err(`[!] Lỗi khi tham gia voice: ${e.message}`);
    attemptReconnect('join-error');
  }
}

/** Rời khỏi kênh thoại và hủy mọi tiến trình reconnect. */
function leaveVC() {
  stopReconnectPermanently('USER_COMMAND', 'Lệnh leave được gọi');
  if (connection) {
    try {
      connection.removeAllListeners();
      connection.destroy();
    } catch {}
    connection = null;
  }
  log('[✓] Đã rời voice channel');
}


client.on('ready', () => {
  console.log(`[✓] Đăng nhập thành công với tài khoản: ${client.user.tag}`);
  console.log(`[✓] ID: ${client.user.id}`);
  console.log('-----------------------------------------');
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (client.user?.id !== newState.id) return;
  if (Date.now() - lastReadyAt < 2000) return;


  if (
    STICKY_TARGET &&
    targetGuildId && targetChannelId &&
    newState.guild.id === targetGuildId &&
    newState.channelId && newState.channelId !== targetChannelId
  ) {
    if (Date.now() - lastStickyPullAt < STICKY_COOLDOWN_MS) {
      log('[sticky] Đang trong thời gian cooldown, bỏ qua lần move này.');
      return;
    }
    if (stickyTimer) clearTimeout(stickyTimer);

    stickyTimer = setTimeout(() => {
      stickyTimer = null;
      if (!targetGuildId || !targetChannelId) return;

      const currentChannel = newState.guild?.members?.me?.voice?.channelId;
      if (currentChannel === targetChannelId) return;

      warn(`[sticky] Bị di chuyển sang kênh "${newState.channel?.name || newState.channelId}". Đang kéo về...`);
      lastStickyPullAt = Date.now();
      joinVC(targetGuildId, targetChannelId);
    }, STICKY_DEBOUNCE_MS);
  }
});



/** Vòng lặp chính để nhận lệnh từ người dùng. */
async function commandLoop() {
  const cmd = (await q('\nNhập lệnh (join/leave/exit): ')).trim().toLowerCase();
  switch (cmd) {
    case 'join': {
      const guildId = (await q('   Nhập GUILD ID: ')).trim();
      const channelId = (await q('   Nhập VOICE CHANNEL ID: ')).trim();
      if (guildId && channelId) {
        await joinVC(guildId, channelId);
      } else {
        warn('[!] GUILD ID và VOICE CHANNEL ID không được để trống.');
      }
      break;
    }
    case 'leave':
      leaveVC();
      break;
    case 'exit':
      log('[×] Đang thoát...');
      cleanExit(0);
      return;
    default:
      warn('[!] Lệnh không hợp lệ. Các lệnh có sẵn: join, leave, exit');
      break;
  }
}

/** Dọn dẹp tài nguyên và thoát ứng dụng một cách an toàn. */
function cleanExit(code = 0) {
  try { rl.close(); } catch {}
  clearReconnect();
  if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null; }
  if (connection) {
      try { connection.removeAllListeners(); connection.destroy(); } catch {}
  }
  if (client) { try { client.destroy?.(); } catch {} }
  process.exit(code);
}

process.on('SIGINT', () => {
  console.log();
  warn('[×] Nhận tín hiệu SIGINT, đang thoát...');
  cleanExit(0);
});


const CONFIG_PATH = path.join(process.cwd(), 'config.json');

function loadTokenFromFile() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return config.Token || null;
    }
  } catch (error) {
    err('[!] Lỗi đọc file cấu hình:', error.message);
  }
  return null;
}

function saveTokenToFile(token) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ Token: token }, null, 2));
    log(`[✓] Đã lưu token vào ${CONFIG_PATH}`);
  } catch (error) {
    err('[!] Không thể lưu token:', error.message);
  }
}

/**
 * Hàm chính của chương trình (Main Function).
 * Chịu trách nhiệm cho luồng thực thi chính: đăng nhập và bắt đầu vòng lặp lệnh.
 */
async function main() {
  log('-----------------------------------------');
  log('      Horimeki - Stay Voice Bot v3.6     ');
  log('-----------------------------------------');

  let tokenToLogin = null;
  const savedToken = loadTokenFromFile();

  if (savedToken) {
    const answer = await q('Phát hiện token đã lưu. Bạn có muốn sử dụng? (y/n): ');
    if (answer.toLowerCase() === 'y') {
      tokenToLogin = savedToken;
    }
  }
  

  while (!client.token) {
    try {
      if (!tokenToLogin) {
        tokenToLogin = await q('\nNhập token Discord của bạn: ');
        if (!tokenToLogin) {
          warn('[!] Token không được để trống!');
          continue;
        }
      }
      log('[↻] Đang đăng nhập...');
      await client.login(tokenToLogin);
    } catch (e) {
      err(`[!] Lỗi đăng nhập: ${e.message}`);
      warn('[!] Vui lòng kiểm tra lại token.');
      tokenToLogin = null;
    }
  }


  if (!savedToken || savedToken !== client.token) {
      const saveAnswer = await q('Bạn có muốn lưu token này để sử dụng lần sau? (y/n): ');
      if (saveAnswer.toLowerCase() === 'y') {
          saveTokenToFile(client.token);
      }
  }
  

  while (true) {
    await commandLoop();
  }
}

main();