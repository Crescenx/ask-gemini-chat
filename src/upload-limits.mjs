export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILE_BASE64 = Math.ceil(MAX_FILE_BYTES / 3) * 4;
export const MAX_UPLOAD_BODY = MAX_FILE_BASE64 + 4096;

export function validFileBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_FILE_BASE64 || value.length % 4) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding <= MAX_FILE_BYTES && !/[^A-Za-z0-9+/]/.test(value.slice(0, value.length - padding));
}
