/**
 * Чтение изображений и файлов, переданных webview из буфера обмена или перетаскиванием.
 * Используется формой промпта и окном быстрой заметки.
 */
import type { ClipboardImagePayload } from '../../types/messages';

/** Кодирует Blob в base64 без префикса data URL. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read clipboard blob.'));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/** Читает изображения из системного буфера обмена; при недоступности API возвращает пустой список. */
export async function readClipboardImagePayloads(): Promise<ClipboardImagePayload[]> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return [];
  }

  try {
    const items = await navigator.clipboard.read();
    const images: ClipboardImagePayload[] = [];

    for (const item of items) {
      for (const type of item.types) {
        if (!type.startsWith('image/')) {
          continue;
        }

        const blob = await item.getType(type);
        const dataBase64 = await blobToBase64(blob);
        if (!dataBase64) {
          continue;
        }

        images.push({
          mimeType: type,
          dataBase64,
        });
      }
    }

    return images;
  } catch {
    return [];
  }
}
