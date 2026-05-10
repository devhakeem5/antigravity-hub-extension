/**
 * Protobuf Utilities
 * 
 * Provides manual encoding for Protocol Buffer messages.
 * This eliminates the need for large protobuf generation libraries,
 * specifically tailored for injecting tokens into state.vscdb.
 */

export class ProtobufUtils {
  // --- Array Merge ---
  private static concatBytes(...parts: Uint8Array[]): Uint8Array {
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    return merged;
  }

  // --- Varint Encoding (Wire Type 0) ---
  static encodeVarint(value: number): Uint8Array {
    const buf: number[] = [];
    let val = BigInt(value);
    while (val >= 128n) {
      buf.push(Number((val & 127n) | 128n));
      val >>= 7n;
    }
    buf.push(Number(val));
    return new Uint8Array(buf);
  }

  // --- Varint Field Encoding ---
  static encodeVarintField(fieldNum: number, value: number): Uint8Array {
    const tag = (fieldNum << 3) | 0; // wireType 0
    const tagBytes = this.encodeVarint(tag);
    const valueBytes = this.encodeVarint(value);
    return this.concatBytes(tagBytes, valueBytes);
  }

  // --- Length-Delimited General Field (Wire Type 2) ---
  static encodeLenDelimField(fieldNum: number, data: Uint8Array): Uint8Array {
    const tag = (fieldNum << 3) | 2; // wireType 2
    const tagBytes = this.encodeVarint(tag);
    const lenBytes = this.encodeVarint(data.length);
    const result = new Uint8Array(tagBytes.length + lenBytes.length + data.length);
    result.set(tagBytes, 0);
    result.set(lenBytes, tagBytes.length);
    result.set(data, tagBytes.length + lenBytes.length);
    return result;
  }

  // --- String Field Encoding ---
  static encodeStringField(fieldNum: number, value: string): Uint8Array {
    const utf8Encode = new TextEncoder();
    const bytes = utf8Encode.encode(value);
    return this.encodeLenDelimField(fieldNum, bytes);
  }

  // ─── DOMAIN SPECIFIC BUILDERS ───────────────────────────────────────────────────

  /**
   * Builds the inner OAuthInfo message.
   * Field 1: access_token
   * Field 2: token_type ("Bearer")
   * Field 3: refresh_token
   * Field 4: expiry (Timestamp Submessage: Field 1 = seconds)
   * Field 5: id_token (optional)
   * Field 6: is_gcp_tos (varint 1, only when true)
   * 
   * Auto-corrects isGcpTos to false for personal email domains.
   */
  static createOAuthInfo(
    accessToken: string,
    refreshToken: string,
    expirySeconds: number,
    isGcpTos = false,
    idToken?: string,
    email?: string,
  ): Uint8Array {
    // Auto-correction: personal emails should never have is_gcp_tos = true
    if (isGcpTos && email) {
      const { PERSONAL_EMAIL_DOMAINS } = require('../../core/constants/app.constants');
      const lowerEmail = email.toLowerCase();
      const isPersonal = PERSONAL_EMAIL_DOMAINS.some((domain: string) => lowerEmail.endsWith(domain));
      if (isPersonal) {
        isGcpTos = false;
      }
    }

    const field1 = this.encodeStringField(1, accessToken);
    const field2 = this.encodeStringField(2, 'Bearer');
    const field3 = this.encodeStringField(3, refreshToken);

    // Build Timestamp (submessage)
    const timestampTag = (1 << 3) | 0; // Field 1, wireType 0
    const tagBytes = this.encodeVarint(timestampTag);
    const secondsBytes = this.encodeVarint(expirySeconds);
    const timestampMsg = new Uint8Array(tagBytes.length + secondsBytes.length);
    timestampMsg.set(tagBytes, 0);
    timestampMsg.set(secondsBytes, tagBytes.length);
    const field4 = this.encodeLenDelimField(4, timestampMsg);

    const field5 = idToken ? this.encodeStringField(5, idToken) : new Uint8Array();
    const field6 = isGcpTos ? this.encodeVarintField(6, 1) : new Uint8Array();

    return this.concatBytes(field1, field2, field3, field4, field5, field6);
  }

  /**
   * Wraps any payload in the Unified State Topic structure.
   */
  static createUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string {
    // 1. Encode payload to Base64 and place in Field 1 of Row
    const payloadBase64 = Buffer.from(payload).toString('base64');
    const row = this.encodeStringField(1, payloadBase64);

    // 2. Build DataEntry: Field 1 = sentinelKey, Field 2 = row
    const dataEntry = this.concatBytes(
      this.encodeStringField(1, sentinelKey),
      this.encodeLenDelimField(2, row)
    );

    // 3. Wrap DataEntry in Topic: Field 1 = dataEntry
    const topic = this.encodeLenDelimField(1, dataEntry);

    // 4. Return as Base64 string for the DB
    return Buffer.from(topic).toString('base64');
  }

  /**
   * Builds a single DataEntry (sentinelKey + row with value) as raw bytes.
   * Used internally to compose multi-entry Topics.
   */
  private static buildDataEntryBytes(sentinelKey: string, value: string): Uint8Array {
    const row = this.encodeStringField(1, value);
    return this.concatBytes(
      this.encodeStringField(1, sentinelKey),
      this.encodeLenDelimField(2, row)
    );
  }

  /**
   * Creates a Topic protobuf with multiple DataEntry entries.
   * Returns base64-encoded string ready for state.vscdb.
   */
  static createMultiEntryTopic(entries: Array<{ sentinelKey: string; value: string }>): string {
    const entryParts = entries.map(e =>
      this.encodeLenDelimField(1, this.buildDataEntryBytes(e.sentinelKey, e.value))
    );
    const topic = this.concatBytes(...entryParts);
    return Buffer.from(topic).toString('base64');
  }

  /**
   * Convenience method to build the final OAuthToken Topic for state.vscdb.
   *
   * Matches the reference app structure:
   * A single unified state entry with 'oauthTokenInfoSentinelKey' containing the Protobuf OAuthInfo.
   */
  static createUnifiedOAuthToken(
    accessToken: string,
    refreshToken: string,
    expirySeconds: number,
    isGcpTos = false,
    idToken?: string,
    email?: string,
  ): string {
    // 1. Build the OAuthInfo protobuf (actual tokens)
    const oauthInfo = this.createOAuthInfo(accessToken, refreshToken, expirySeconds, isGcpTos, idToken, email);
    
    // 2. Create the unified state entry
    return this.createUnifiedStateEntry('oauthTokenInfoSentinelKey', oauthInfo);
  }

  /**
   * Builds the minimal UserStatus payload for state.vscdb.
   */
  static createMinimalUserStatusPayload(email: string): Uint8Array {
    return this.concatBytes(
      this.encodeStringField(3, email),
      this.encodeStringField(7, email)
    );
  }

  /**
   * Builds a simple string payload (used for Enterprise Project ID).
   */
  static createStringValuePayload(value: string): Uint8Array {
    return this.encodeStringField(3, value);
  }
}
