import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
} from './secret-cipher';

describe('AI settings authenticated encryption', () => {
  const key = 'test-only-encryption-key-with-at-least-32-characters';

  it('round-trips a provider key without exposing plaintext', () => {
    const encrypted = encryptSecret('sk-provider-secret', key);

    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain('sk-provider-secret');
    expect(isEncryptedSecret(encrypted)).toBe(true);
    expect(decryptSecret(encrypted, key)).toBe('sk-provider-secret');
  });

  it('detects tampering through the GCM authentication tag', () => {
    const encrypted = encryptSecret('sk-provider-secret', key);
    const parts = encrypted.split(':');
    const ciphertext = Buffer.from(parts[4], 'base64url');
    ciphertext[0] ^= 1;
    parts[4] = ciphertext.toString('base64url');
    const tampered = parts.join(':');

    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('rejects weak encryption keys', () => {
    expect(() => encryptSecret('secret', 'too-short')).toThrow(
      'AI_SETTINGS_ENCRYPTION_KEY debe tener al menos 32 caracteres.',
    );
  });
});
