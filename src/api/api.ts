import { Hono } from 'hono';
import { cors } from 'hono/cors'
import { serve } from 'bun';
import { sendTelegramMessage } from '../receiver/telegram';
import { processAgentMessage, processBrevoMessage, sendBrevoMessage } from '../receiver/brevo';
import { getChatById, getChats, pb, refreshAuthentication } from '../storage/pocketbase';
import { streamSSE } from 'hono/streaming';
import dotenv from 'dotenv';
import { Message } from '../models';

dotenv.config();

const app = new Hono();
const API_KEY = process.env.API_KEY;
const PORT = process.env.SERVER_PORT || 3000;
const processedMessages = new Map<string, number>();
const corsUrl = process.env.CORS_ORIGIN_REMOTE;

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
  if (c.req.path === '/health' || c.req.path === '/brevohook') {
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

app.post('/brevohook', async (c) => {
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
      source: source,
      platformMessageId: `api_${Date.now()}`,
      chatId: chatId,
      type: type,
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

  } catch (error) {
    console.error('Error processing message:', error);
    return c.json({
      success: false,
      message: error || 'Internal server error'
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
      // Проверяем, нужна ли повторная аутентификация
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

app.get('/api/stream', async (c) => {
  const chatId = c.req.query('chatId');
  const source = c.req.query('source');

  return streamSSE(c, async (stream) => {
    let unsubscribeChats: Function;
    let unsubscribeMessages: Function;

    try {
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected' }),
        event: 'connection'
      });

      try {
        unsubscribeChats = await pb.collection('chats').subscribe('*', async (data) => {
          if (source && data.record.source !== source) return;

          await stream.writeSSE({
            data: JSON.stringify({
              type: 'chat',
              action: data.action,
              record: data.record
            }),
            event: 'update'
          });
        });
      } catch (error: any) {
        if (error.status === 403) {
          await refreshAuthentication();
          unsubscribeChats = await pb.collection('chats').subscribe('*', async (data) => {
            if (source && data.record.source !== source) return;

            await stream.writeSSE({
              data: JSON.stringify({
                type: 'chat',
                action: data.action,
                record: data.record
              }),
              event: 'update'
            });
          });
        } else {
          console.error('Error subscribing to chats:', error);
          await stream.writeSSE({
            data: JSON.stringify({ type: 'error', message: 'Failed to subscribe to chats' }),
            event: 'error'
          });
        }
      }

      const messageFilter = chatId ? `chatId="${chatId}"` : '';
      try {
        unsubscribeMessages = await pb.collection('messages').subscribe(messageFilter, async (data) => {
          if (chatId && data.record.chatId !== chatId) return;

          await stream.writeSSE({
            data: JSON.stringify({
              type: 'message',
              action: data.action,
              record: data.record
            }),
            event: 'update'
          });
        });
      } catch (error: any) {
        if (error.status === 403) {
          await refreshAuthentication();
          unsubscribeMessages = await pb.collection('messages').subscribe(messageFilter, async (data) => {
            if (chatId && data.record.chatId !== chatId) return;

            await stream.writeSSE({
              data: JSON.stringify({
                type: 'message',
                action: data.action,
                record: data.record
              }),
              event: 'update'
            });
          });
        } else {
          console.error('Error subscribing to messages:', error);
          await stream.writeSSE({
            data: JSON.stringify({ type: 'error', message: 'Failed to subscribe to messages' }),
            event: 'error'
          });
        }
      }

      const keepAliveInterval = setInterval(async () => {
        await stream.writeSSE({
          data: JSON.stringify({ type: 'ping' }),
          event: 'ping'
        });
      }, 30000);

      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(keepAliveInterval);
        if (unsubscribeChats) unsubscribeChats();
        if (unsubscribeMessages) unsubscribeMessages();
        console.log('Client disconnected from SSE stream');
      });
    } catch (error) {
      console.error('SSE stream error:', error);
      await stream.writeSSE({
        data: JSON.stringify({ type: 'error', message: 'Stream error occurred' }),
        event: 'error'
      });
    }
  });
});

const httpServer = serve({
  port: PORT,
  fetch: app.fetch
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
