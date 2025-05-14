import { startTGBot, stopTGBot } from './receiver/telegram';
import { authenticate } from './storage/pocketbase';
import dotenv from 'dotenv';
import { startRealtimeHttpServer, stopRealtimeHttpServer } from "./api/api";
dotenv.config();

async function initServices() {
  try {
    await authenticate(process.env.POCKETBASE_EMAIL!, process.env.POCKETBASE_PASSWORD!);
    await startTGBot();
    await startRealtimeHttpServer();

  } catch (error) {
    console.error('Error during initialization:', error);
  }

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await stopTGBot();
    await stopRealtimeHttpServer()
    process.exit(0);
  });
}

initServices().catch(error => {
  console.error('Error initializing services:', error);
});