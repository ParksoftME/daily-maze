/**
 * Supabase PKCE (S256) requires crypto.subtle.digest('SHA-256').
 * Import this file once at app entry, before any Supabase client import.
 */
import "react-native-get-random-values";
import "react-native-url-polyfill/auto";
import { polyfillWebCrypto } from "expo-standard-web-crypto";
import * as ExpoCrypto from "expo-crypto";

polyfillWebCrypto();

type GlobalWithCrypto = typeof globalThis & {
  crypto?: Crypto & { subtle?: SubtleCrypto };
  window?: { crypto?: Crypto };
};

const g = globalThis as GlobalWithCrypto;

function ensureCryptoRoot(): Crypto {
  if (g.crypto) return g.crypto;
  const c = {} as Crypto;
  g.crypto = c;
  if (typeof g.window !== "undefined") {
    g.window.crypto = c;
  }
  return c;
}

function installSubtleDigest(cryptoRef: Crypto) {
  if (typeof cryptoRef.subtle?.digest === "function") return;

  const subtle = {
    async digest(
      algorithm: AlgorithmIdentifier,
      data: BufferSource,
    ): Promise<ArrayBuffer> {
      const name =
        typeof algorithm === "string" ? algorithm : (algorithm as Algorithm).name;
      if (name !== "SHA-256") {
        throw new Error(`[crypto-polyfill] unsupported algorithm: ${name}`);
      }

      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

      return ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, bytes);
    },
  } as SubtleCrypto;

  Object.defineProperty(cryptoRef, "subtle", {
    value: subtle,
    configurable: true,
    enumerable: true,
    writable: false,
  });
}

const cryptoRef = ensureCryptoRoot();
installSubtleDigest(cryptoRef);

const pkceReady =
  typeof globalThis.crypto !== "undefined" &&
  typeof globalThis.crypto.subtle !== "undefined" &&
  typeof globalThis.crypto.subtle.digest === "function" &&
  typeof TextEncoder !== "undefined";

console.log("[crypto-polyfill] PKCE sha256 ready:", pkceReady);

export {};
