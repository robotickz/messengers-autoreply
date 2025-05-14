import OpenAI from 'openai';
import { Message } from '../models';
import { convertAudioInMemory } from '../utils/oggToMP3';
import dotenv from 'dotenv';
import { getChatById, getFileToken, getFileUrl, getMediaRecord, saveChat } from "../storage/pocketbase";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY не установлен в переменных окружения');
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

export async function getAIResponse(message: Message, threadId?: string): Promise<string> {
  try {

    if (message.type === "voice" || message.type === "audio") {
      console.log("Processing audio message");
      return await handleAudioMessage(message);
    } else if (message.type === "image") {
      console.log("Processing image message");
      return await handleImageMessage(message);
    }

    return await handleTextMessage(message, threadId!);
  } catch (error) {
    console.error("OpenAI Assistants API error:", error);
    return "Извините, произошла ошибка при обработке запроса.";
  }
}

async function handleTextMessage(message: Message, openAIThreadId?: string): Promise<string> {
  const assistantId = process.env.OPENAI_ASSISTANT_ID;

  if (!assistantId) {
    throw new Error("OPENAI_ASSISTANT_ID is not defined in environment");
  }

  let threadId = openAIThreadId!;

  if (!threadId) {
    const thread = await client.beta.threads.create();
    threadId = thread.id;
    let chat = await getChatById(message.chatId);
    chat!.openAIThreadId = threadId;
    await saveChat(chat!);
    console.log(`Created new thread ${threadId} for chat ${chat!.id}`);
  }

  await client.beta.threads.messages.create(threadId, {
    role: "user",
    content: message.content
  });

  const run = await client.beta.threads.runs.create(threadId, {
    assistant_id: assistantId
  });

  let runStatus = await client.beta.threads.runs.retrieve(threadId, run.id);

  const startTime = Date.now();
  const timeout = 30000;

  while (runStatus.status !== "completed") {
    if (["failed", "cancelled", "expired"].includes(runStatus.status)) {
      throw new Error(`Run ${run.id} failed with status ${runStatus.status}`);
    }

    if (Date.now() - startTime > timeout) {
      throw new Error("Response timed out after 30 seconds");
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    runStatus = await client.beta.threads.runs.retrieve(threadId, run.id);
  }

  const messages = await client.beta.threads.messages.list(threadId, {
    order: "desc",
    limit: 1
  });

  if (messages.data.length === 0 || messages.data[0].role !== "assistant") {
    throw new Error("No assistant response found");
  }

  const content = messages.data[0].content[0];
  if (content.type !== "text") {
    throw new Error(`Unexpected content type: ${content.type}`);
  }

  return content.text.value;
}

async function handleImageMessage(message: Message): Promise<string> {
  try {
    if (!message.mediaFileId) {
      return "Изображение не найдено.";
    }

    try {
      const fileToken = await getFileToken();
      const mediaRecord = await getMediaRecord(message.mediaFileId);
      const url = await getFileUrl(mediaRecord, mediaRecord.file, { 'token': fileToken });
      const response = await fetch(url);

      if (!response.ok) {
        console.log(`Download failed: ${response.status} ${response.statusText}`);
        return "Ошибка доступа к файлу.";
      }

      const contentType = response.headers.get('content-type');
      const arrayBuffer = await response.arrayBuffer();
      const base64Image = Buffer.from(arrayBuffer).toString('base64');
      const dataUrl = `data:${contentType || 'image/jpeg'};base64,${base64Image}`;

      const visionResponse = await client.chat.completions.create({
        model: process.env.OPENAI_VISION_MODEL!,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: message.content || "Что на этом изображении?"
              },
              {
                type: "image_url",
                image_url: {
                  url: dataUrl
                }
              }
            ]
          }
        ],
        max_tokens: 500
      });

      const imageDescription = visionResponse.choices[0].message.content || "Не удалось проанализировать изображение.";

      const contextualContent = message.content
        ? `${message.content}\n\n[Содержание изображения: ${imageDescription}]`
        : `[Содержание изображения: ${imageDescription}]`;

      const textMessage: Message = {
        ...message,
        content: contextualContent,
        type: "text"
      };

      const assistantResponse = await handleTextMessage(textMessage);

      return `📷 Описание изображения: "${imageDescription}"\n\n🤖 Ответ: ${assistantResponse}`;

    } catch (error) {
      console.error("Error getting image from PocketBase:", error);
      return "Не удалось получить изображение из хранилища.";
    }
  } catch (error) {
    console.error("Error in handleImageMessage:", error);
    throw error;
  }
}

async function handleAudioMessage(message: Message): Promise<string> {
  try {
    if (!message.mediaFileId) {
      return "Аудиофайл не найден.";
    }

    try {
      const fileToken = await getFileToken()
      const mediaRecord = await getMediaRecord(message.mediaFileId);
      const url = await getFileUrl(mediaRecord, mediaRecord.file, { 'token': fileToken });

      const response = await fetch(url);
      if (!response.ok) {
        console.log(`Download failed: ${response.status} ${response.statusText}`);
        return "Ошибка доступа к аудиофайлу.";
      }

      const originalBuffer = Buffer.from(await response.arrayBuffer());
      const formData = new FormData();
      let model = process.env.OPENAI_AUDIO_MODEL! ?? 'whisper-1';
      formData.append('model', model);
      let audioBlob = new Blob([originalBuffer], { type: 'audio/mp4' });

      if (message.source === "telegram") {
        const mp3Buffer = await convertAudioInMemory(originalBuffer);
        audioBlob = new Blob([mp3Buffer], { type: 'audio/mp3' });
        formData.append('file', audioBlob, 'audio.mp3');
      } else {
        formData.append('file', audioBlob, 'audio.mp4');
      }

      const transcriptionResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: formData
      });

      if (!transcriptionResponse.ok) {
        const errorText = await transcriptionResponse.text();
        console.error("Transcription error:", errorText);
        return "Не удалось распознать аудио.";
      }

      const transcriptionResult = await transcriptionResponse.json();
      const transcribedText = transcriptionResult.text;

      if (!transcribedText || transcribedText.trim() === "") {
        return "Не удалось распознать текст в аудиосообщении.";
      }

      const textMessage = {
        ...message,
        content: transcribedText,
        type: "text"
      } as Message;

      const assistantResponse = await handleTextMessage(textMessage);
      return `📝 Распознанный текст: "${transcribedText}"\n\n🤖 Ответ: ${assistantResponse}`;

    } catch (error) {
      console.error("Error processing audio from PocketBase:", error);
      return "Произошла ошибка при обработке аудиосообщения.";
    }
  } catch (error) {
    console.error("Error in handleAudioMessage:", error);
    throw error;
  }
}