import {
  getOrCreateWallet,
  loadWalletFromPrivateKey,
  login,
  signup,
  saveTokensToEnv,
} from './auth';

async function main() {
  // Check for --signup flag
  const isSignup = process.argv.includes('--signup');
  const mode = isSignup ? 'Signup' : 'Login';

  console.log(`=== Axiom ${mode} ===\n`);

  // Check for private key in environment or args (filter out flags)
  const args = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  const privateKey = process.env.SOLANA_PRIVATE_KEY || args[0];

  let wallet;
  if (privateKey) {
    console.log(`[${mode}] Using provided private key`);
    wallet = loadWalletFromPrivateKey(privateKey);
  } else {
    // Generate or load wallet from file
    wallet = getOrCreateWallet();
  }

  console.log(`[${mode}] Wallet address:`, wallet.publicKey);
  console.log('');

  try {
    // Authenticate with Axiom
    const tokens = isSignup ? await signup(wallet) : await login(wallet);

    // Save tokens to .env file
    saveTokensToEnv(tokens);

    console.log(`\n=== ${mode} Successful! ===`);
    console.log('Cookies have been saved to .env file');
    console.log('You can now run: npm run dev');
  } catch (error) {
    console.error(`\n[${mode}] Authentication failed:`, error);

    if (!isSignup) {
      console.log('\nHint: If this is a new wallet, try: npm run signup');
    } else {
      console.log('\nHint: If signup is rate-limited, try:');
      console.log('  1. Use VPN to change region');
      console.log('  2. Use an existing wallet: SOLANA_PRIVATE_KEY=your_key npm run login');
      console.log('  3. Copy cookies from browser manually');
    }

    process.exit(1);
  }
}

main().catch(console.error);
