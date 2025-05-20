import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { sendTelegramMessage } from '../receiver/telegram';
import { processAgentMessage, processBrevoMessage, sendBrevoMessage } from '../receiver/brevo';
import { getChatById, getChats, getFileToken, getFileUrl, getMediaRecord, pb, refreshAuthentication } from '../storage/pocketbase';
import { Message, MessageSource } from '../models';
import { serve } from 'bun';

import dotenv from 'dotenv';


dotenv.config();

const app = new Hono();
const API_KEY = process.env.API_KEY;
const PORT = parseInt(process.env.SERVER_PORT || '3000');
const processedMessages = new Map<string, number>();
const corsUrl = process.env.CORS_ORIGIN_REMOTE;
const hookSecret = process.env.BREVO_WEBHOOK_SECRET;

// Очистка старых обработанных сообщений
setInterval(() => {
  const now = Date.now();
  for (const [id, timestamp] of processedMessages.entries()) {
    if (now - timestamp > 3600000) {
      processedMessages.delete(id);
    }
  }
}, 600000);

app.use('*', cors({
  origin: ['http://localhost:3000', corsUrl!],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  exposeHeaders: ['Content-Length'],
  maxAge: 86400,
  credentials: true,
}));

async function authMiddleware(c: any, next: any) {
  const apiKey = c.req.header('X-API-Key');

  if (!apiKey || apiKey !== API_KEY) {
    return c.json({ error: 'Unauthorized: Invalid API key' }, 401);
  }

  await next();
}

app.use('*', async (c, next) => {
  if (c.req.path === '/health' || c.req.path === `/brevohook/${hookSecret!}` || c.req.path.startsWith('/api/files/')) {
    return next();
  }
  return authMiddleware(c, next);
});

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'pocketbase-realtime',
    database: pb && pb.authStore.isValid ? 'connected' : 'disconnected'
  });
});

app.post(`/brevohook/${hookSecret!}`, async (c) => {
  const body = await c.req.json();
  console.log('Received webhook:', body);

  const message = body.message || (body.messages && body.messages[0]);

  if (!message) {
    return c.text('No message found in webhook', 200);
  }

  if (processedMessages.has(message.id)) {
    console.log(`Skipping duplicate message ID: ${message.id} (already processed)`);
    return c.text('Duplicate message skipped', 200);
  }

  processedMessages.set(message.id, Date.now());

  if ((body.message?.type === 'agent' || (body.messages && body.messages[0]?.type === 'agent'))) {
    await processAgentMessage(body);
  }

  if (body.eventName === 'conversationFragment' && body.messages && body.messages.length > 0) {
    const message = body.messages[0];
    if (message.type === 'visitor') {
      await processBrevoMessage(
        body.visitor,
        message,
        body.visitor.source,
        true
      );
    }
  }

  if (body.eventName === 'conversationStarted' && body.message) {
    const message = body.message;
    if (message.type === 'visitor') {
      await processBrevoMessage(
        body.visitor,
        message,
        body.visitor.source,
        true
      );
    }
  }

  return c.text('Webhook received successfully', 200);
});

app.post('/api/messages', async (c) => {
  try {
    const body = await c.req.json();
    console.log('Received message request:', body);

    const { chatId, platformChatId, source, text, type, visitorId = 'text', senderName } = body;

    if (!platformChatId || !source || !text || !visitorId) {
      return c.json({
        success: false,
        message: 'Missing required fields: platformChatId, source, visitorId or text'
      }, 400);
    }

    const msg: Message = {
      source: source as MessageSource,
      platformMessageId: `api_${Date.now()}`,
      chatId: chatId,
      type: type || 'text',
      content: text,
      isIncoming: false,
      timestamp: new Date(),
      senderId: 'api_client',
      senderName: senderName || 'API Client',
      responseMode: 'manual'
    };

    let externalResult;
    if (source === 'telegram') {
      await sendTelegramMessage(platformChatId, text);
      externalResult = { platform: 'telegram' };
    } else if (['instagram', 'whatsapp', 'brevo'].includes(source)) {
      const msgId = await sendBrevoMessage(visitorId, text);
      externalResult = { platform: source, messageId: msgId };
    } else {
      return c.json({
        success: false,
        message: `Unsupported source: ${source}`
      }, 400);
    }

    return c.json({
      success: true,
      message: `Message sent via ${source}`,
      external: externalResult
    });

  } catch (error: any) {
    console.error('Error processing message:', error);
    return c.json({
      success: false,
      message: error?.message || 'Internal server error'
    }, 500);
  }
});

app.get('/api/chats', async (c) => {
  try {
    const limit = Number(c.req.query('limit')) || 50;
    const source = c.req.query('source');
    let chats = await getChats(source!, limit);

    return c.json({
      success: true,
      total: chats.totalItems,
      chats: chats.items
    });
  } catch (error: any) {
    console.error('Error fetching chats:', error);
    if (error.status === 403) {
      await refreshAuthentication();
      try {
        const limit = Number(c.req.query('limit')) || 50;
        const source = c.req.query('source');
        let chats = await getChats(source!, limit);

        return c.json({
          success: true,
          total: chats.totalItems,
          chats: chats.items
        });
      } catch (retryError) {
        console.error('Error after re-authentication:', retryError);
        return c.json({
          success: false,
          message: 'Failed to fetch chats after re-authentication'
        }, 500);
      }
    }

    return c.json({
      success: false,
      message: error?.message || 'Failed to fetch chats'
    }, error?.status || 500);
  }
});

app.get('/api/chats/:chatId/messages', async (c) => {
  try {
    const chatId = c.req.param('chatId');
    const limit = Number(c.req.query('limit')) || 100;

    const chat = await getChatById(chatId);
    if (!chat) {
      return c.json({
        success: false,
        message: `Chat with ID ${chatId} not found`
      }, 404);
    }

    try {
      const messages = await pb.collection('messages').getList(1, limit, {
        filter: `chatId="${chatId}"`,
        sort: 'timestamp'
      });

      return c.json({
        success: true,
        chatId,
        total: messages.totalItems,
        messages: messages.items
      });
    } catch (messagesError: any) {
      if (messagesError.status === 403) {
        await refreshAuthentication();
        const messages = await pb.collection('messages').getList(1, limit, {
          filter: `chatId="${chatId}"`,
          sort: 'timestamp'
        });

        return c.json({
          success: true,
          chatId,
          total: messages.totalItems,
          messages: messages.items
        });
      }
      throw messagesError;
    }
  } catch (error: any) {
    console.error('Error fetching messages:', error);
    return c.json({
      success: false,
      message: error?.message || 'Failed to fetch messages'
    }, error?.status || 500);
  }
});

app.patch('/api/chats/:chatId/autoMode', async (c) => {
  try {
    const chatId = c.req.param('chatId');
    const body = await c.req.json();

    if (body.autoMode === undefined) {
      return c.json({
        success: false,
        message: 'Missing required field: autoMode'
      }, 400);
    }

    const chat = await getChatById(chatId);
    if (!chat) {
      return c.json({
        success: false,
        message: `Chat with ID ${chatId} not found`
      }, 404);
    }

    try {
      await pb.collection('chats').update(chatId, {
        autoMode: body.autoMode
      });
    } catch (updateError: any) {
      if (updateError.status === 403) {
        await refreshAuthentication();
        await pb.collection('chats').update(chatId, {
          autoMode: body.autoMode
        });
      } else {
        throw updateError;
      }
    }

    return c.json({
      success: true,
      chatId,
      autoMode: body.autoMode
    });
  } catch (error: any) {
    console.error('Error updating chat auto mode:', error);
    return c.json({
      success: false,
      message: error?.message || 'Failed to update chat auto mode'
    }, error?.status || 500);
  }
});

app.get('/api/media/:mediaFileId/url', async (c) => {
  try {
    const mediaFileId = c.req.param('mediaFileId');


    if (!mediaFileId) {
      return c.json({
        success: false,
        message: 'Missing required parameter: mediaFileId'
      }, 400);
    }

    try {
      const fileToken = await getFileToken();
      const mediaRecord = await getMediaRecord(mediaFileId);

      if (!mediaRecord) {
        return c.json({
          success: false,
          message: `Media record with ID ${mediaFileId} not found`
        }, 404);
      }

      const url = await getFileUrl(mediaRecord, mediaRecord.file, { 'token': fileToken });
      const urlObj = new URL(url);
      const relativePath = urlObj.pathname + urlObj.search;

      return c.json({
        success: true,
        url: relativePath
      });
    } catch (mediaError: any) {
      if (mediaError.status === 403) {
        await refreshAuthentication();
        const fileToken = await getFileToken();
        const mediaRecord = await getMediaRecord(mediaFileId);

        if (!mediaRecord) {
          return c.json({
            success: false,
            message: `Media record with ID ${mediaFileId} not found`
          }, 404);
        }

        const url = await getFileUrl(mediaRecord, mediaRecord.file, { 'token': fileToken });
        const urlObj = new URL(url);
        const relativePath = urlObj.pathname + urlObj.search;

        return c.json({
          success: true,
          url: relativePath
        });
      }
      throw mediaError;
    }
  } catch (error: any) {
    console.error('Error getting media URL:', error);
    return c.json({
      success: false,
      message: error?.message || 'Failed to get media URL'
    }, error?.status || 500);
  }
});

app.get('/pb-hook/:chatId', async (c) => {
  try{
    const id = c.req.param('chatId');
    httpServer.publish("event", id);
    return c.json({
          success: true
        });
  }
  catch(e){
  }
});

const httpServer = serve({
  port: PORT,
  fetch: (req, server) => {
    const url = new URL(req.url);
    if (url.pathname === '/api/ws') {
      const apiKey = url.searchParams.get('apiKey');
      if (apiKey !== API_KEY) {
        return new Response('Unauthorized: Invalid API key', { status: 401 });
      }

      const chatId = url.searchParams.get('chatId');
      const source = url.searchParams.get('source');

      const success = server.upgrade(req, {
        data: { chatId, source }
      });

      return success
        ? undefined
        : new Response('WebSocket upgrade failed', { status: 500 });
    }

    return app.fetch(req);
  },
  websocket: {
     open(ws) {
      ws.subscribe("event");
    },
    message(ws, message) {
    },
    close(ws) {
      ws.unsubscribe("event");
    },
  }
});

export async function startRealtimeHttpServer() {
  try {
    console.log(`Realtime HTTP server started on port: ${httpServer.port}`);
    return httpServer;
  } catch (error) {
    console.error('Error starting Realtime HTTP server:', error);
    throw error;
  }
}

export async function stopRealtimeHttpServer() {
  await httpServer.stop();
  console.log(`Realtime HTTP server stopped on port: ${httpServer.port}`);
}
