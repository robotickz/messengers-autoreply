import { Bot, Context, GrammyError, HttpError } from 'grammy';
import dotenv from 'dotenv';
import { findOrCreateChat, saveMediaFile, saveMessage } from "../storage/pocketbase";
import { Message } from '../models';
import { getAIResponse } from "../responder/openai";

dotenv.config();
const bot = new Bot(process.env.TELEGRAM_TOKEN!);

export async function startTGBot() {
  setupHandlers();
  setupErrorHandling();
  await bot.start();
}

function setupHandlers() {
  bot.on('message:text', async (ctx) => {
    await handleTgTextMessage(ctx);
  });

  bot.on('message:photo', async (ctx) => {
    await handleTgPhotoMessage(ctx);
  });

  bot.on('message:voice', async (ctx) => {
    await handleTgVoiceMessage(ctx);
  });
  console.log("Telegram bot is started");
}

function setupErrorHandling() {
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      console.error("Telegram API Error:", e.description);
    } else if (e instanceof HttpError) {
      console.error("HTTP Error:", e);
    } else {
      console.error("Unknown Error:", e);
    }
  });
}

export async function handleTgTextMessage(ctx: Context) {
  if (!ctx.message || !ctx.message.text) return;

  const platformChatId = String(ctx.chat?.id);
  const chat = await findOrCreateChat(platformChatId, "telegram");

  let msg: Message = {
    source: "telegram",
    platformMessageId: String(ctx.message.message_id),
    chatId: chat!.id!,
    type: "text",
    content: ctx.message.text,
    isIncoming: true,
    timestamp: new Date(ctx.message.date * 1000),
    senderId: String(ctx.from?.id),
    senderName: ctx.from?.first_name || "Unknown",
    responseMode: "manual"
  };

  await saveMessage(msg);

  if (chat?.autoMode) {
    await handleOpenAI(msg, platformChatId, chat!.openAIThreadId!);
  }
}

export async function handleTgPhotoMessage(ctx: Context) {
  if (!ctx.message?.photo || !ctx.chat?.id) return;

  try {
    const photoArray = ctx.message.photo;
    const bestPhoto = photoArray[photoArray.length - 1];
    const botToken = bot.token;
    const file = await ctx.api.getFile(bestPhoto.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
    const fileResponse = await fetch(fileUrl);

    if (!fileResponse.ok) {
      throw new Error(`Failed to download file: ${fileResponse.status} ${fileResponse.statusText}`);
    }

    const fileBlob = await fileResponse.blob();
    const fileId = await saveMediaFile(fileBlob, `tg_photo_${bestPhoto.file_unique_id}.jpg`, "image/jpeg", "telegram");
    const platformChatId = String(ctx.chat.id);
    const chat = await findOrCreateChat(platformChatId, "telegram");

    let msg: Message = {
      source: "telegram",
      platformMessageId: String(ctx.message.message_id),
      chatId: chat!.id!,
      type: "image",
      content: ctx.message.caption || "",
      mediaFileId: fileId,
      isIncoming: true,
      timestamp: new Date(ctx.message.date * 1000),
      senderId: String(ctx.from?.id),
      senderName: ctx.from?.first_name || "Unknown",
      responseMode: "manual"
    };

    await saveMessage(msg);

    if (chat?.autoMode) {
      await handleOpenAI(msg, platformChatId, chat!.openAIThreadId!);
    }

  } catch (error) {
    console.error("Error processing photo message:", error);
  }
}

export async function handleTgVoiceMessage(ctx: Context) {
  if (!ctx.message?.voice || !ctx.chat?.id) return;

  try {
    const botToken = bot.token;
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      throw new Error(`Failed to download file: ${fileResponse.status} ${fileResponse.statusText}`);
    }

    const fileBlob = await fileResponse.blob();
    const fileId = await saveMediaFile(fileBlob, `tg_voice_${ctx.message.voice.file_unique_id}.ogg`, "audio/ogg", "telegram");
    const platformChatId = String(ctx.chat.id);
    const chat = await findOrCreateChat(platformChatId, "telegram");

    const msg: Message = {
      source: "telegram",
      platformMessageId: String(ctx.message.message_id),
      chatId: chat!.id!,
      type: "audio",
      content: "Voice message",
      ...(fileId && { mediaFileId: fileId }),
      isIncoming: true,
      timestamp: new Date(ctx.message.date * 1000),
      senderId: String(ctx.from?.id),
      senderName: ctx.from?.first_name || "Unknown",
      responseMode: "manual"
    };

    await saveMessage(msg);

    if (chat?.autoMode && msg.isIncoming) {
      await handleOpenAI(msg, platformChatId, chat!.openAIThreadId!);
    }
  } catch (error) {
    console.error("Error processing voice message:", error);
  }
}

async function handleOpenAI(message: Message, platformChatId: string, threadId: string): Promise<void> {
  try {
    const res = await getAIResponse(message, threadId);
    let msg: Message = {
      source: "telegram",
      platformMessageId: `auto_${Date.now()}`,
      chatId: message.chatId,
      type: "text",
      content: res,
      isIncoming: false,
      timestamp: new Date(),
      senderId: process.env.OPENAI_ASSISTANT_ID ?? "OpenAI",
      senderName: "OpenAI Assistant",
      responseMode: "auto"
    };

    await saveMessage(msg);
    await sendTelegramMessage(platformChatId, res);
    console.log(`Sent auto response to Telegram chat ${platformChatId}`);
  } catch (error) {
    console.error("Error processing message:", error);
  }
}

export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text);
  } catch (error) {
    console.error("Error sending Telegram message:", error);
    throw error;
  }
}

export async function stopTGBot() {
  console.log("Stopping Telegram bot...");
  await bot.stop();
}
