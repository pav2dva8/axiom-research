/**
 * Derive a pump.fun token's "pair" (bonding curve PDA) from its mint.
 *
 * The pair Axiom uses for a pre-migration pump.fun token is the bonding-curve
 * program-derived address:
 *
 *   findProgramAddress([b"bonding-curve", mint], 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)
 *
 * Verified against:
 *   2eCCtb16cJkQs3LbCXRG1p97KKSv1c9cNHZUZVchpump -> Amk61ySm6z9hWSRSEsCKiMMb3i1G8ph89wNP9FzhBzsN
 *   DDiGq2FZNmiKFgALGKg5JQBfXqYz6awvNojGYGyrpump -> AEHwGx7ycZKKXD9egXx4ASWUUx5QtwPBgNyYkj1hnUbs
 *
 * Once a token migrates, Axiom may show a different AMM pool address. The
 * no-auth path cannot infer that Axiom-specific pair from only the mint; paste
 * the full Axiom link when a specific pair address is required.
 */

import { PublicKey } from '@solana/web3.js';

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export function isPumpCa(input: string): boolean {
  return /pump$/i.test(input.trim());
}

export function derivePumpPair(mint: string): string | null {
  try {
    const m = new PublicKey(mint.trim());
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), m.toBuffer()],
      PUMP_PROGRAM,
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}
