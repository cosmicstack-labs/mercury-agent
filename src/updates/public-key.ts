/**
 * The key that signs Mercury's update manifest and Mercury Desktop's update
 * packages (minisign, as `tauri signer` makes it). The same string is
 * `plugins.updater.pubkey` in apps/desktop/src-tauri/tauri.conf.json; a
 * test keeps the two equal. The private key never lives in this repository.
 */
export const UPDATE_PUBLIC_KEY =
  'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEVCNjg5RDJCNTMzMzc5RDYKUldUV2VUTlRLNTFvNjFKY2NMR2RRQXVjcXRIbVNiN2tYNkNQSUprMWJVM0NjeHRmL045Q3RUSDYK';
