declare module 'tweetsodium' {
  export function keyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
  export function seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  export function sealOpen(ciphertext: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
}