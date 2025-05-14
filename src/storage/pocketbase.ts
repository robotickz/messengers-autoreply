import PocketBase, { FileOptions, RecordModel } from 'pocketbase';
import { Message, Chat, MessageSource } from '../models';


const EMAIL = process.env.POCKET_BASE_EMAIL;
const PASSWORD = process.env.POCKET_BASE_PASSWORD;
let authRetryInProgress = false;

export const pb = new PocketBase(process.env.POCKETBASE_URL);

export async function authenticate(email: string = EMAIL!, password: string = PASSWORD!, silent: boolean = false) {
  try {
    await pb.collection('_superusers').authWithPassword(email, password);
    if (!silent) {
      console.log('PocketBase: Authentication successful');
    } else {
      console.log('PocketBase: Re-authentication successful');
    }
    return true;
  } catch (error) {
    if (!silent) {
      console.error('PocketBase: Authentication failed', error);
    } else {
      console.error('PocketBase: Silent re-authentication failed', error);
    }
    throw error;
  }
}

export async function handleAuthError(error: any) {
  if (error?.status === 403 && error?.response?.message?.includes("perform this action") && !authRetryInProgress) {
    try {
      authRetryInProgress = true;
      console.log('PocketBase: Auth token expired, attempting re-authentication');
      await authenticate(EMAIL!, PASSWORD!, true);
      authRetryInProgress = false;
      return true;
    } catch (authError) {
      console.error('PocketBase: Re-authentication failed', authError);
      authRetryInProgress = false;
      return false;
    }
  }
  return false;
}

export async function saveMessage(msg: Message): Promise<Message> {
  try {
    const result = await pb.collection('messages').create(msg);
    return {
      id: result.id,
      platformMessageId: result.platformMessageId,
      source: result.source as MessageSource,
      chatId: result.chatId,
      type: result.type,
      content: result.content,
      mediaFileId: result.mediaFileId,
      isIncoming: result.isIncoming,
      timestamp: new Date(result.timestamp),
      senderId: result.senderId,
      senderName: result.senderName,
      responseMode: result.responseMode
    };
  } catch (err: any) {
    if (err.status === 400) {
      console.log("Unable to save message");
    }
    throw err;
  }
}

export async function saveMediaFile(fileData: Blob, filename: string, contentType: string, platform: string): Promise<string> {
  try {
    const formData = new FormData();
    formData.append('file', fileData, filename);
    formData.append('platform', platform);

    const result = await pb.collection('media').create(formData);
    return result.id;
  } catch (err: any) {
    if (err.status === 400 || err.status === 404) {
      console.log("Unable to save file");
    }
    throw err;
  }
}

export async function getMessageById(platformMessageId: string, senderId: string): Promise<String | null> {
  try {
    const result = await pb.collection('messages').getFirstListItem(`platformMessageId="${platformMessageId}" && senderId="${senderId}"`);
    return result.id;
  }
  
  catch (err: any) {
    if (err.status === 403 && await handleAuthError(err)) {
      return getMessageById(platformMessageId, senderId);
    }
    if (err.status === 400 || err.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function saveChat(chat: Chat): Promise<Chat> {
  try {
    let result: RecordModel;

    if (chat.id) {
      result = await pb.collection('chats').update(chat.id, chat);
    } else {
      result = await pb.collection('chats').create(chat);
    }

    return {
      id: result.id,
      platformChatId: result.platformChatId,
      source: result.source as MessageSource,
      name: result.name,
      updated: new Date(result.updated),
      openAIThreadId: result.openAIThreadId,
      autoMode: result.autoMode
    };
  } catch (err: any) {
    if (err.status === 403 && await handleAuthError(err)) {
      return saveChat(chat);
    }
    if (err.status === 400 || err.status === 404) {
      console.log("Unable to save chat");
    }
    throw err;
  }
}

export async function updateResponseMode(chatId: string, autoMode: boolean): Promise<void> {
  try {
    await pb.collection('chats').update(chatId, { autoMode });
  } catch (error) {
    console.error('Failed to update response mode:', error);
    throw error;
  }
}

export async function findOrCreateChat(
  id: string, source?: MessageSource, name?: string): Promise<Chat | null> {
  try {
    const options = { requestKey: `findchat_${id}`, timeout: 5000 };

    try {
      const result = await pb.collection('chats').getFirstListItem(`platformChatId="${id}"`, options);

      return {
        id: result.id,
        platformChatId: result.platformChatId,
        source: result.source,
        name: result.name,
        autoMode: result.autoMode,
        openAIThreadId: result.openAIThreadId,
        updated: new Date(result.updated)
      };

    } catch (err: any) {
      if (err.status === 403 && await handleAuthError(err)) {
        return findOrCreateChat(id, source, name);
      }
      if (err.status === 400 || err.status === 404) {
        const chat: Chat = {
          platformChatId: id,
          source: source!,
          name: name || "Unknown",
          openAIThreadId: "",
          updated: new Date(),
          autoMode: false
        };

        const savedChat = await saveChat(chat);
        if (!savedChat) {
          throw new Error(`Failed to create chat for ${source} sourceId: ${id}`);
        }
        return savedChat;
      }

      throw err;
    }
  } catch (error) {
    console.error(`Error in find chat for ${source} sourceId ${id}:`, error);
    return null;
  }
}

export async function getChats(source: string, limit: number): Promise<any> {
  try {
    let filter = '';
    if (source) {
      filter = `source="${source}"`;
    }
    const chats = await pb.collection('chats').getList(1, limit, {
      sort: '-updated',
      filter
    });
    return chats;

  } catch (error: any) {
    if (error.status === 403 && await handleAuthError(error)) {
        return getChats(source, limit);
    }
    throw error;
  }
}

export async function getChatById(chatId: string): Promise<any> {
  try {
    return await pb.collection('chats').getOne(chatId);
  } catch (error: any) {
     if (error.status === 403 && await handleAuthError(error)) {
      return getChatById(chatId);
    }
    console.error(`Failed to get chat: ${chatId}`);
    return null;
  }
}

export async function getMediaRecord(mediaId: string): Promise<any> {
  try {
    return await pb.collection('media').getOne(mediaId);
  } catch (error) {
    console.error(`Failed to get media record for ${mediaId}`);
  }
}

export async function getFileUrl(record: { [key: string]: any },
  filename: string,
  queryParams: FileOptions = {}): Promise<string> {
  try {
    return pb.files.getUrl(record, filename, queryParams!);
  } catch (error) {
    return "no media record found.";
  }
}

export async function getFileToken(): Promise<string> {
  try {
    return pb.files.getToken();
  }
  catch (error) {
    return `Failed to get file token: ${error}`;
  }
}
