import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const PREFIX = 'enc:v1:';

export function isEncryptedSecret(value?: string | null): boolean {
  return Boolean(value?.startsWith(PREFIX));
}

export function encryptSecret(value: string, secret: string): string {
  const key = encryptionKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  return `${PREFIX}${iv.toString('base64url')}:${cipher
    .getAuthTag()
    .toString('base64url')}:${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value: string, secret: string): string {
  if (!isEncryptedSecret(value)) return value;
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3)
    throw new Error('Formato de secreto cifrado inválido.');
  const [iv, tag, ciphertext] = parts.map((part) =>
    Buffer.from(part, 'base64url'),
  );
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

function encryptionKey(secret: string): Buffer {
  if (secret.length < 32) {
    throw new Error(
      'AI_SETTINGS_ENCRYPTION_KEY debe tener al menos 32 caracteres.',
    );
  }
  return createHash('sha256').update(secret).digest();
}
