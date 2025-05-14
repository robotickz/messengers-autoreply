# Messenger AutoReply

## О проекте
Сервис для автоматизации ответов в мессенджерах с единым API и админ-панелью. Поддерживает Telegram и Instagram (через Brevo).

## Возможности
- Единый интерфейс для управления сообщениями из разных мессенджеров
- Автоматические ответы на входящие сообщения
- Поддержка текстовых, голосовых сообщений и изображений
- API для интеграции с внешними системами
- Реалтайм мониторинг сообщений и чатов

## Установка

```bash
# Клонирование репозитория
git clone https://github.com/yourusername/messenger_autoreply.git
cd messenger_autoreply

# Установка зависимостей
bun install

# Запуск приложения
bun dev
```

## Конфигурация

Создайте файл `.env` со следующими переменными:

```
# PocketBase
POCKET_BASE_URL=http://localhost:8090
POCKETBASE_EMAIL=admin@example.com
POCKETBASE_PASSWORD=password

# Telegram
TELEGRAM_TOKEN=your-telegram-bot-token

# Brevo (для Instagram)
BREVO_API_KEY=your-brevo-api-key
BREVO_AGENT_ID=agent-id

# OpenAI (для автоответчика)
OPENAI_API_KEY=your-openai-key
OPENAI_ASSISTANT_ID=assistant-id
OPENAI_VISION_MODEL=gpt-4-vision
OPENAI_AUDIO_MODEL=whisper-1

# API Server
SERVER_PORT=3000
API_KEY=somekey
```

## API Endpoints

### Сообщения
- `POST /api/messages` - Отправка сообщения через API
- `GET /api/chats` - Получение списка чатов
- `GET /api/chats/:chatId/messages` - Получение сообщений чата
- `PATCH /api/chats/:chatId/autoMode` - Включение/отключение автоответчика
- `GET /api/stream` - SSE поток для получения реалтайм-обновлений

## Интеграция в другие приложения

Для отправки сообщений через API:

```bash
curl -X POST http://localhost:3002/api/messages \
  -H "X-API-Key: your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "platformChatId": "chat-id",
    "source": "telegram",
    "text": "Текст сообщения",
    "visitorId": "id",
    "senderName": "Бот"
  }'
```
## Настройка PocketBase

### Настройка коллекций

Если у вас еще нет необходимых коллекций, создайте их с следующей структурой:

#### Коллекция `chats`
- `platformChatId` (text, required, unique)
- `source` (text, required)
- `name` (text)
- `updated` (date)
- `openAIThreadId` (text)
- `autoMode` (boolean)

#### Коллекция `messages`
- `platformMessageId` (text, required)
- `source` (text, required)
- `chatId` (relation:chats, required)
- `type` (text, required)
- `content` (text)
- `mediaFileId` (relation:media)
- `isIncoming` (boolean, required)
- `timestamp` (date, required)
- `senderId` (text, required)
- `senderName` (text)
- `responseMode` (text)

#### Коллекция `media`
- `file` (file, required)
- `platform` (text, required)

### Настройка правил доступа

Рекомендуется настроить следующие правила доступа для коллекций:

#### Коллекция `chats`
```json
{
  "listRule": "@request.auth.id != ''",
  "viewRule": "@request.auth.id != ''",
  "createRule": "@request.auth.id != ''",
  "updateRule": "@request.auth.id != ''",
  "deleteRule": "@request.auth.id != '' && @request.auth.type = 'admin'"
}
```

#### Коллекция `messages`
```json
{
  "listRule": "@request.auth.id != ''",
  "viewRule": "@request.auth.id != ''",
  "createRule": "@request.auth.id != ''",
  "updateRule": "@request.auth.id != ''",
  "deleteRule": "@request.auth.id != '' && @request.auth.type = 'admin'"
}
```

#### Коллекция `media`
```json
{
  "listRule": "@request.auth.id != ''",
  "viewRule": "@request.auth.id != ''",
  "createRule": "@request.auth.id != ''",
  "updateRule": "@request.auth.id != ''",
  "deleteRule": "@request.auth.id != '' && @request.auth.type = 'admin'"
}
```
## Реалтайм функциональность

Сервис поддерживает получение сообщений и обновлений чатов в реальном времени через SSE (Server-Sent Events).

### Подключение к потоку событий

```javascript
// Подключение к потоку обновлений для конкретного чата
const eventSource = new EventSource('/api/stream?chatId=CHAT_ID', {
  headers: { 'X-API-Key': 'ваш-ключ-api' }
});

// Обработка получаемых событий
eventSource.addEventListener('update', (event) => {
  const data = JSON.parse(event.data);
  
  if (data.type === 'message') {
    // Новое сообщение
    console.log(`Получено сообщение: ${data.record.content}`);
    
    // Добавляем сообщение в интерфейс
    addMessageToUI(data.record);
  } else if (data.type === 'chat') {
    // Обновление чата
    console.log(`Обновлен чат: ${data.record.name}`);
    updateChatList(data.record);
  }
});

// Обработка ошибок и повторное подключение
eventSource.addEventListener('error', () => {
  eventSource.close();
  setTimeout(() => connectToStream(), 5000);
});
```

Вы можете фильтровать поток по `chatId` или `source` (например, `telegram` или `instagram`).

## Лицензия

MIT