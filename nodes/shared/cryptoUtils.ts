import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 16;
const IV_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Encrypts a string using a key derived from the provided secret.
 * Output format: SALT:IV:AUTH_TAG:CIPHERTEXT (all hex-encoded).
 */
export function encryptToken(text: string, secret: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);
    const key = scryptSync(secret, salt, KEY_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv);

    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `${salt.toString('hex')}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string produced by encryptToken using the same secret.
 * Throws on tampered data, wrong secret, or malformed input.
 */
export function decryptToken(encryptedText: string, secret: string): string {
    const parts = encryptedText.split(':');
    if (parts.length !== 4) {
        throw new Error('Invalid encrypted token format');
    }
    const [saltHex, ivHex, tagHex, dataHex] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const key = scryptSync(secret, salt, KEY_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

/**
 * Returns a SHA-256 hex digest of the given value, suitable for use as a
 * privacy-preserving cache key.  Never store the raw PII value.
 */
export function hashForCacheKey(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

/**
 * Decodes the payload of a JWT (without verification) and returns the `sub`
 * claim.  Returns undefined if the token is malformed or has no `sub`.
 */
export function extractJwtSubject(token: string): string | undefined {
    try {
        const parts = token.split('.');
        if (parts.length < 2) return undefined;
        const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
        const claims = JSON.parse(payload) as Record<string, unknown>;
        return typeof claims.sub === 'string' ? claims.sub : undefined;
    } catch {
        return undefined;
    }
}