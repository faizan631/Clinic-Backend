require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const qrcode = require("qrcode");
const { Client, LocalAuth } = require("whatsapp-web.js");
const fs = require("fs").promises;
const path = require("path");
const { type } = require("os");

const HOST = "0.0.0.0";
const PORT = process.env.PORT || 3001;
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "https://clinic-crm-sigma.vercel.app";

const AUTH_FOLDER_PATH = path.join(__dirname, "www_auth");

const app = express();
app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: FRONTEND_ORIGIN, methods: ["GET", "POST"] },
});

// ---------- State ----------
let client = null;
let clientInitialized = false;
let isClientReady = false;
let lastQrDataUrl = null;

// ---------- Helpers ----------

async function clearOldSession() {
  try {
    const folderExists = await fs
      .stat(AUTH_FOLDER_PATH)
      .then(() => true)
      .catch(() => false);

    if (folderExists) {
      console.log("[SYS] Clearing old session folder...");
      await fs.rm(AUTH_FOLDER_PATH, { recursive: true, force: true });
      console.log("[SYS] Old session folder deleted.");
    }
  } catch (err) {
    console.error("[SYS] Error clearing session folder:", err);
  }
}

function setupClientEventHandlers() {
  client.on("qr", async (qr) => {
    console.log("[WA] QR code received");
    try {
      const qrDataUrl = await qrcode.toDataURL(qr);
      lastQrDataUrl = qrDataUrl;
      io.emit("qr", qrDataUrl);
      io.emit("status", "qr_received");
    } catch (err) {
      console.error("[WA] Error generating QR data URL:", err);
    }
  });

  client.on("authenticated", () => {
    console.log("[WA] Authenticated");
    io.emit("status", "authenticated");
    lastQrDataUrl = null; // Clear QR after successful auth
  });

  client.on("ready", async () => {
    console.log("[WA] Client is ready");
    isClientReady = true;
    io.emit("status", "ready");

    setTimeout(async () => {
      try {
        const chats = await getFormattedChats();
        io.emit("chats", chats);
      } catch (err) {
        console.error("[WA] Failed to fetch chats on ready:", err);
      }
    }, 2000); // wait 2s before fetching
  });

  client.on("disconnected", async (reason) => {
    console.warn("[WA] disconnected:", reason);

    try {
      await client.destroy();
    } catch (err) {
      console.error("[WA] Error destroying client:", err);
    }

    client = null;
    isClientReady = false;
    clientInitialized = false;
    lastQrDataUrl = null;

    try {
      await fs.rm(AUTH_FOLDER_PATH, { recursive: true, force: true });
      console.log("[SYS] Session folder deleted.");
    } catch (err) {
      console.error("[SYS] Failed to delete session folder:", err);
    }

    io.emit("status", "disconnected");
    io.emit("logged_out");

    setTimeout(() => {
      createClientInstance();
      initializeClientIfNeeded();
    }, 700);
  });

  client.on("message_ack", (msg, ack) => {
    console.log(
      `[WA] Ack Update: Message ${msg.id._serialized} recieved ack status: ${ack}`
    );

    io.emit("message_ack_update", {
      messageId: msg.id._serialized,
      ack: ack,
    });
  });

  client.on("message_create", async (msg) => {
    if (!isClientReady) return;

    try {
      console.log(
        `[WA] New Message recieved/Sent for chat: ${
          msg.fromMe ? msg.to : msg.from
        }`
      );

      const simplifiedMessage = {
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia,
        type: msg.type,
        ack: msg.ack,
        media: null,
      };

      io.emit("new_message", {
        chatId: msg.fromMe ? msg.to : msg.from,
        message: simplifiedMessage,
      });

      const chats = await getFormattedChats();
      io.emit("chats", chats);
    } catch (error) {
      console.error("[WA] message_create handler error", error);
    }
  });
}

function createClientInstance() {
  client = new Client({
    authStrategy: new LocalAuth({ dataPath: AUTH_FOLDER_PATH }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  setupClientEventHandlers();
}

let isInitializing = false;

async function initializeClientIfNeeded() {
  if (isInitializing) {
    console.log("[WA] Already initializing...");
    return;
  }
  if (!client) createClientInstance();

  if (clientInitialized && isClientReady) {
    console.log("[WA] Client already ready.");
    return;
  }

  try {
    isInitializing = true;
    console.log("[WA] Initializing client...");
    await client.initialize();
    clientInitialized = true;
    console.log("[WA] client.initialize() finished");
  } catch (err) {
    console.error("[WA] Error during client.initialize()", err);
    clientInitialized = false;
    io.emit("error-message", "Failed to initialize WhatsApp client");
  } finally {
    isInitializing = false;
  }
}

// Added retries and delay to avoid puppeteer not ready errors
async function getFormattedChats(retries = 3) {
  if (!isClientReady || !client) return [];

  try {
    const chats = await client.getChats();
    return chats.map((chat) => ({
      id: chat.id._serialized,
      name:
        chat.name ||
        chat.formattedTitle ||
        chat.id?.user ||
        chat.id._serialized,
      isGroup: chat.isGroup || false,
      unreadCount: chat.unreadCount || 0,
      timestamp: chat.timestamp || 0,
      profilePicUrl: null,
      lastMessage:
        chat.lastMessage?.body ||
        (chat.lastMessage?.hasMedia ? "📷 Media" : "") ||
        "",
    }));
  } catch (err) {
    if (String(err.message).includes("Session closed")) {
      console.warn("[WA] getFormattedChats skipped - session already closed.");
      return [];
    }
    if (retries > 0) {
      await new Promise((res) => setTimeout(res, 1000));
      return getFormattedChats(retries - 1);
    }
    console.error("[WA] getFormattedChats error", err);
    return [];
  }
}

// -----------------
// Startup logic
// -----------------
(async () => {
  // Commented out to preserve session on restart
  // await clearOldSession();

  createClientInstance();
  await initializeClientIfNeeded();
})();

// ---------- Socket.IO ----------

io.on("connection", (socket) => {
  console.log("[IO] frontend connected", socket.id);

  // Immediately emit current status & QR on connect
  if (isClientReady) {
    socket.emit("status", "ready");
  } else if (lastQrDataUrl) {
    socket.emit("qr", lastQrDataUrl);
    socket.emit("status", "qr_received");
  } else {
    socket.emit("status", "disconnected");
  }

  socket.on("request-initial-status", async () => {
    console.log("[IO] received request-initial-status from", socket.id);
    if (isClientReady) {
      try {
        const chats = await getFormattedChats();
        socket.emit("initial-status", { ready: true, chats });
      } catch (err) {
        console.error("[IO] Error fetching chats for initial status", err);
        socket.emit("initial-status", { ready: true, chats: [] });
      }
    } else {
      socket.emit("initial-status", { ready: false, qr: lastQrDataUrl });
    }
  });

  socket.on("start-session", async () => {
    console.log("[IO] start-session requested by", socket.id);
    await initializeClientIfNeeded();
  });

  socket.on("get-chats", async () => {
    console.log("[IO] get-chats requested");
    if (!isClientReady) {
      socket.emit("error-message", "WhatsApp client not ready yet");
      return;
    }
    try {
      const chats = await getFormattedChats();
      socket.emit("chats", chats);
    } catch (err) {
      console.error("[IO] get-chats error", err);
      socket.emit("chats", []);
    }
  });

  socket.on("get-chat-messages", async (chatId) => {
    console.log("[IO] get-chat-messages", chatId);
    if (!isClientReady) {
      socket.emit("error-message", "WhatsApp client not ready yet");
      return;
    }
    try {
      const chat = await client.getChatById(chatId);
      if (!chat) {
        socket.emit("chat-messages", { chatId, messages: [] });
        return;
      }
      const msgs = await chat.fetchMessages({ limit: 100 });
      const simplified = msgs
        .map((m) => ({
          id: m.id?._serialized || `${m.timestamp}-${Math.random()}`,
          body: m.body,
          fromMe: !!m.fromMe,
          timestamp: m.timestamp || Math.floor(Date.now() / 1000),
          hasMedia: m.hasMedia || false,
          type: m.type || null,
          ack: m.ack,
        }))
        .filter((m) => m.type !== "revoked");
      socket.emit("chat-messages", { chatId, messages: simplified });
    } catch (err) {
      console.error("[IO] get-chat-messages error", err);
      socket.emit("chat-messages", { chatId, messages: [] });
    }
  });

  socket.on("get-message-media", async ({ chatId, messageId }) => {
    console.log(`[IO] get-message-media for msg ${messageId}`);
    if (!isClientReady) return;

    try {
      const chat = await client.getChatById(chatId);
      if (!chat) {
        console.warn(`[WA] Chat not found for media request: ${chatId}`);
        socket.emit("message-media-failed", { messageId });
        return;
      }
      // Fetch more messages to find media message
      const messages = await chat.fetchMessages({ limit: 200 });
      const messageToDownload = messages.find(
        (m) => m.id._serialized === messageId
      );

      if (messageToDownload && messageToDownload.hasMedia) {
        const media = await messageToDownload.downloadMedia();
        if (media && media.mimetype && media.data) {
          socket.emit("message-media-data", {
            messageId,
            media: {
              mimetype: media.mimetype,
              data: media.data,
              filename: media.filename,
            },
          });
        } else {
          console.warn(`[WA] downloadMedia failed for message ${messageId}`);
          socket.emit("message-media-failed", { messageId });
        }
      } else {
        console.warn(`[WA] Media message not found for ${messageId}`);
        socket.emit("message-media-failed", { messageId });
      }
    } catch (err) {
      console.error(`[WA] Error getting media for message ${messageId}:`, err);
      socket.emit("message-media-failed", { messageId });
    }
  });

  socket.on("send-message", async (data) => {
    try {
      // 1. Destructure all the data sent from the frontend, including the temporary ID.
      const { chatId, message, tempId } = data;

      if (!isClientReady || !client) {
        console.warn("[WA] Send message attempt when client not ready.");
        // Optionally, you can emit an error back to this specific client
        socket.emit("send_message_error", {
          tempId,
          error: "WhatsApp client not ready.",
        });
        return;
      }

      // 2. Send the message using the library. This returns the final Message object.
      const sentMessage = await client.sendMessage(chatId, message);

      // 3. Create a clean, simplified payload with all necessary info for the UI.
      const confirmationPayload = {
        id: sentMessage.id._serialized,
        body: sentMessage.body,
        fromMe: sentMessage.fromMe,
        timestamp: sentMessage.timestamp,
        hasMedia: sentMessage.hasMedia,
        type: sentMessage.type,
        ack: sentMessage.ack, // This will be the initial 'sent' status (ack: 1)
      };

      // 4. Emit a confirmation event *back to the sender* (using socket.emit).
      //    Include the original tempId so the frontend knows which optimistic message to replace.
      socket.emit("message_sent_confirmation", {
        tempId: tempId,
        message: confirmationPayload,
      });

      console.log(`[WA] Sent message to ${chatId}: ${message}`);
    } catch (err) {
      console.error("[WA] Error sending message:", err);
      // If sending fails, we can also notify the frontend
      // Note: 'data.tempId' is available here from the initial destructuring
      socket.emit("send_message_error", {
        tempId: data.tempId,
        error: "Failed to send message.",
      });
    }
  });

  socket.on("logout", async () => {
    try {
      if (client) await client.destroy();
      await fs.rm(AUTH_FOLDER_PATH, { recursive: true, force: true });
      console.log("[SYS] Session folder deleted on manual logout.");
    } catch (err) {
      console.error("[SYS] Error during manual logout:", err);
    }
    client = null;
    isClientReady = false;
    clientInitialized = false;
    lastQrDataUrl = null;

    io.emit("logged_out");
    io.emit("status", "disconnected");

    setTimeout(() => {
      createClientInstance();
      initializeClientIfNeeded();
    }, 700);
  });

  socket.on("disconnect", () => {
    console.log("[IO] socket disconnected", socket.id);
  });
});

// Graceful shutdown
async function shutdown() {
  console.log("[SYS] Shutdown initiated...");
  if (client) {
    try {
      await client.destroy();
    } catch (err) {
      console.error("[SYS] Error destroying client during shutdown:", err);
    }
  }
  process.exit();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  console.log(`[SYS] Server listening on port ${PORT}`);
});

// // server.js
// const express = require('express');
// const http = require('http');
// const { Server } = require('socket.io');
// const cors = require('cors');
// const qrcode = require('qrcode');
// const { Client, LocalAuth } = require('whatsapp-web.js');

// const app = express();
// app.use(cors());
// app.use(express.json());

// const server = http.createServer(app);
// const io = new Server(server, {
//   cors: {
//     origin: ['http://localhost:5173', 'http://localhost:3000'], // multiple origins support
//     methods: ['GET', 'POST'],
//     credentials: true,
//   },
// });

// let client = null;
// let clientInitialized = false;
// let isClientReady = false;
// let lastQrDataUrl = null;
// let isInitializing = false; // prevent multiple initializations

// function createClientInstance() {
//   if (client) {
//     try {
//       client.destroy();
//     } catch (e) {
//       console.warn('Error destroying previous client:', e);
//     }
//   }

//   client = new Client({
//     authStrategy: new LocalAuth(),
//     puppeteer: {
//       headless: true,
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-dev-shm-usage',
//         '--disable-accelerated-2d-canvas',
//         '--no-first-run',
//         '--no-zygote',
//         '--single-process',
//         '--disable-gpu'
//       ],
//     },
//   });

//   // QR event - CRITICAL FIX
//   client.on('qr', async (qr) => {
//     try {
//       console.log('QR received, generating data URL...');
//       const qrDataUrl = await qrcode.toDataURL(qr, {
//         width: 256,
//         margin: 2,
//         color: {
//           dark: '#000000',
//           light: '#FFFFFF'
//         }
//       });
//       lastQrDataUrl = qrDataUrl;
//       console.log('QR generated successfully, emitting to all clients');
//       io.emit('qr', qrDataUrl);
//     } catch (err) {
//       console.error('Failed to convert QR to DataURL:', err);
//       io.emit('error-message', 'Failed to generate QR code');
//     }
//   });

//   client.on('authenticated', (auth) => {
//     console.log('WhatsApp authenticated successfully');
//     lastQrDataUrl = null;
//     isClientReady = false; // not ready yet, wait for 'ready' event
//     io.emit('authenticated', 'WhatsApp authenticated successfully');
//   });

//   client.on('ready', async () => {
//     console.log('WhatsApp client is ready');
//     isClientReady = true;
//     lastQrDataUrl = null;
//     io.emit('ready');

//     // Fetch chats after a delay to ensure session is fully synced
//     setTimeout(async () => {
//       try {
//         const chats = await client.getChats();
//         const simplified = chats.slice(0, 50).map(c => ({ // limit to 50 chats
//           id: c.id._serialized,
//           name: c.name || c.formattedTitle || c.id.user || 'Unknown',
//           isGroup: c.isGroup || false,
//         }));
//         io.emit('chats', simplified);
//         console.log(`Chats fetched and emitted: ${simplified.length}`);
//       } catch (err) {
//         console.error('Error fetching chats after ready:', err);
//         io.emit('chats', []);
//       }
//     }, 2000);
//   });

//   client.on('auth_failure', (msg) => {
//     console.error('Authentication failed:', msg);
//     isClientReady = false;
//     clientInitialized = false;
//     isInitializing = false;
//     io.emit('error-message', 'Authentication failed. Please try scanning again.');
//   });

//   client.on('disconnected', (reason) => {
//     console.warn('WhatsApp client disconnected:', reason);
//     isClientReady = false;
//     clientInitialized = false;
//     isInitializing = false;
//     io.emit('whatsapp-status', 'WhatsApp disconnected. Please reconnect.');
//   });

//   client.on('message', (msg) => {
//     try {
//       const payload = {
//         id: msg.id?._serialized || `${msg.timestamp}-${Math.random()}`,
//         from: msg.from,
//         body: msg.body || msg.caption || '',
//         fromMe: !!msg.fromMe,
//         timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
//       };
//       io.emit('message', payload);
//     } catch (err) {
//       console.error('Error handling message event:', err);
//     }
//   });

//   clientInitialized = false;
// }

// async function initializeClientIfNeeded() {
//   if (isInitializing) {
//     console.log('Client already initializing, skipping...');
//     return;
//   }

//   if (!client) {
//     console.log('Creating new client instance...');
//     createClientInstance();
//   }

//   if (clientInitialized) {
//     console.log('Client already initialized');
//     return;
//   }

//   try {
//     isInitializing = true;
//     console.log('Initializing WhatsApp client...');
//     await client.initialize();
//     clientInitialized = true;
//     isInitializing = false;
//     console.log('WhatsApp client initialized successfully');
//   } catch (err) {
//     console.error('Error initializing WhatsApp client:', err);
//     isInitializing = false;
//     clientInitialized = false;
//     io.emit('error-message', 'Failed to initialize WhatsApp client. Please try again.');
//   }
// }

// // Create initial instance but don't initialize
// createClientInstance();

// // Socket connection handling
// io.on('connection', (socket) => {
//   console.log(`Client connected: ${socket.id}`);

//   // Send current status to newly connected client
//   socket.emit('client-status', { ready: isClientReady });

//   // If we have a QR code and client isn't ready, send it
//   if (lastQrDataUrl && !isClientReady) {
//     console.log('Sending existing QR to new client');
//     socket.emit('qr', lastQrDataUrl);
//   }

//   socket.on('start-session', async () => {
//     console.log('start-session requested by client');
//     try {
//       await initializeClientIfNeeded();
//     } catch (err) {
//       console.error('Error in start-session:', err);
//       socket.emit('error-message', 'Failed to start WhatsApp session');
//     }
//   });

//   socket.on('get-chats', async () => {
//     console.log('get-chats requested');
//     if (!isClientReady) {
//       socket.emit('error-message', 'WhatsApp client not ready yet');
//       return;
//     }
//     try {
//       const chats = await client.getChats();
//       const simplified = chats.slice(0, 50).map(chat => ({
//         id: chat.id._serialized,
//         name: chat.name || chat.formattedTitle || chat.id.user || 'Unknown',
//         isGroup: chat.isGroup || false,
//       }));
//       socket.emit('chats', simplified);
//     } catch (err) {
//       console.error('Error fetching chats:', err);
//       socket.emit('chats', []);
//     }
//   });

//   socket.on('get-chat-messages', async (chatId) => {
//     console.log('get-chat-messages requested for:', chatId);
//     if (!isClientReady) {
//       socket.emit('error-message', 'WhatsApp client not ready yet');
//       return;
//     }
//     try {
//       const chat = await client.getChatById(chatId);
//       const msgs = await chat.fetchMessages({ limit: 50 });
//       const simplified = msgs.map(m => ({
//         id: m.id?._serialized || `${m.timestamp}-${Math.random()}`,
//         body: m.body || m.caption || '',
//         fromMe: !!m.fromMe,
//         timestamp: m.timestamp || Math.floor(Date.now() / 1000),
//       }));
//       socket.emit('chat-messages', { chatId, messages: simplified });
//     } catch (err) {
//       console.error('Error fetching chat messages:', err);
//       socket.emit('chat-messages', { chatId, messages: [] });
//     }
//   });

//   socket.on('send-message', async (data) => {
//     const { chatId, message } = data || {};
//     console.log('send-message requested:', { chatId, message });
//     if (!isClientReady) {
//       socket.emit('error-message', 'WhatsApp client not ready yet');
//       return;
//     }
//     if (!chatId || !message?.trim()) {
//       socket.emit('error-message', 'Invalid message data');
//       return;
//     }
//     try {
//       const sent = await client.sendMessage(chatId, message.trim());
//       socket.emit('message-sent', { chatId, message, id: sent?.id?._serialized });
//     } catch (err) {
//       console.error('Error sending message:', err);
//       socket.emit('error-message', 'Failed to send message');
//     }
//   });

//   socket.on('logout', async () => {
//     console.log('logout requested');
//     try {
//       if (client) {
//         await client.logout();
//         await client.destroy();
//       }
//     } catch (err) {
//       console.warn('Error during logout:', err);
//     } finally {
//       // Reset all state
//       client = null;
//       clientInitialized = false;
//       isClientReady = false;
//       lastQrDataUrl = null;
//       isInitializing = false;

//       // Create fresh instance
//       createClientInstance();

//       socket.emit('whatsapp-status', 'Logged out successfully. Scan QR to reconnect.');
//     }
//   });

//   socket.on('disconnect', () => {
//     console.log('Client disconnected:', socket.id);
//   });
// });

// // Error handling
// process.on('unhandledRejection', (err) => {
//   console.error('Unhandled Promise Rejection:', err);
// });

// process.on('uncaughtException', (err) => {
//   console.error('Uncaught Exception:', err);
// });

// const PORT = process.env.PORT || 3001;
// server.listen(PORT, () => {
//   console.log(`🚀 Server running on http://localhost:${PORT}`);
// });
