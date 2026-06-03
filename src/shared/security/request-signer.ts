/**
 * RequestSigner — HMAC-SHA256 request signing
 * 
 * Signs every API request with:
 *   message = "{timestamp}:{METHOD}:{path}:{sha256(body)}"
 *   signature = HMAC-SHA256(enrollment_secret, message)
 */

export class RequestSigner {
  private secret: string | null = null;

  setSecret(secret: string): void {
    this.secret = secret;
  }

  clearSecret(): void {
    this.secret = null;
  }

  /**
   * Sign an API request
   */
  async sign(method: string, path: string, body?: string): Promise<SignedHeaders> {
    if (!this.secret) {
      throw new Error('RequestSigner: No enrollment secret available');
    }

    const timestamp = Date.now().toString();
    const bodyHash = body ? await this.sha256(body) : await this.sha256('');
    const message = `${timestamp}:${method.toUpperCase()}:${path}:${bodyHash}`;
    const signature = await this.hmacSha256(this.secret, message);

    return {
      'X-Timestamp': timestamp,
      'X-Signature': signature,
      'X-Extension-Id': chrome.runtime.id,
    };
  }

  private async sha256(text: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return this.bufferToHex(hash);
  }

  private async hmacSha256(secret: string, message: string): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const messageData = encoder.encode(message);

    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await crypto.subtle.sign('HMAC', key, messageData);
    return this.bufferToHex(signature);
  }

  private bufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

export interface SignedHeaders {
  'X-Timestamp': string;
  'X-Signature': string;
  'X-Extension-Id': string;
}

export const requestSigner = new RequestSigner();
