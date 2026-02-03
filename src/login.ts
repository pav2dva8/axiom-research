import {
  getOrCreateWallet,
  loadWalletFromPrivateKey,
  authenticate,
  saveTokensToEnv,
} from './auth';

async function main() {
  console.log('=== Axiom Login ===\n');

  // Check for private key in environment or args
  const privateKey = process.env.SOLANA_PRIVATE_KEY || process.argv[2];

  let wallet;
  if (privateKey) {
    console.log('[Login] Using provided private key');
    wallet = loadWalletFromPrivateKey(privateKey);
  } else {
    // Generate or load wallet from file
    wallet = getOrCreateWallet();
  }

  console.log('[Login] Wallet address:', wallet.publicKey);
  console.log('');

  try {
    // Authenticate with Axiom
    const tokens = await authenticate(wallet);

    // Save tokens to .env file
    saveTokensToEnv(tokens);

    console.log('\n=== Login Successful! ===');
    console.log('Cookies have been saved to .env file');
    console.log('You can now run: npm run dev');
  } catch (error) {
    console.error('\n[Login] Authentication failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
