import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { PassThrough } from "node:stream";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// конвертация с использованием диска
export async function convertAudioForWhisper(buf: Buffer): Promise<Buffer> {
  const tempDir = os.tmpdir();
  const tempFileIn = path.join(tempDir, `input_${Date.now()}.ogg`);
  const tempFileOut = path.join(tempDir, `output_${Date.now()}.mp3`);

  try {
    await fs.writeFile(tempFileIn, buf);

    await new Promise((resolve, reject) => {
      ffmpeg(tempFileIn)
        .output(tempFileOut)
        .format('mp3')
        .audioChannels(1)
        .audioFrequency(16000)
        .audioBitrate('64k')
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    return await fs.readFile(tempFileOut);
  } finally {
    try {
      await fs.unlink(tempFileIn).catch(() => { });
      await fs.unlink(tempFileOut).catch(() => { });
    } catch (e) {
      console.error("Error cleaning up temp files:", e);
    }
  }
}

// Конвертация в памяти без использования диска
export async function convertAudioInMemory(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const inputStream = new PassThrough();
    inputStream.end(buf);

    ffmpeg(inputStream)
      .inputFormat('ogg')
      .outputFormat('mp3')
      .audioChannels(1)       // моно
      .audioFrequency(16000)  // 16 кГц
      .audioBitrate('64k')    // битрейт для речи
      .pipe()
      .on('data', chunk => chunks.push(chunk))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}
