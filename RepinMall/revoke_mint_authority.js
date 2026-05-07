/**
 * revoke_mint_authority.js
 *
 * Permanently revokes the mint authority on the RPM token.
 * After this runs, the supply is locked at 1,000,000,000 RPM forever.
 * THIS ACTION IS IRREVERSIBLE.
 *
 * Usage:
 *   SOLANA_ENV=mainnet node RepinMall/revoke_mint_authority.js
 *
 * Requirements:
 *   - RepinMall/wallet.json must be the current mint authority
 */

const {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} = require("@solana/web3.js");
const {
  setAuthority,
  AuthorityType,
  getMint,
} = require("@solana/spl-token");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ─── Config ──────────────────────────────────────────────────────────────────
const MINT_ADDRESS = "HbKeBFeLmMYZuWFCm2CvnN66XBL8fx5Sf6Mk7s9KeXFj";
const SOLANA_ENV   = process.env.SOLANA_ENV || "mainnet";
const RPC_URL      = SOLANA_ENV === "mainnet"
  ? clusterApiUrl("mainnet-beta")
  : clusterApiUrl("devnet");
const WALLET_PATH  = path.join(__dirname, "wallet.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Load wallet
  if (!fs.existsSync(WALLET_PATH)) {
    console.error(`Wallet not found at: ${WALLET_PATH}`);
    console.error("Upload RepinMall/wallet.json before running this script.");
    process.exit(1);
  }
  const raw     = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
  const payer   = Keypair.fromSecretKey(new Uint8Array(raw));
  const mint    = new PublicKey(MINT_ADDRESS);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log("\n================================================");
  console.log("  REVOKE MINT AUTHORITY — IRREVERSIBLE ACTION");
  console.log("================================================");
  console.log(`Network     : ${SOLANA_ENV}`);
  console.log(`Mint        : ${MINT_ADDRESS}`);
  console.log(`Wallet      : ${payer.publicKey.toBase58()}`);

  // Fetch current mint info
  const mintInfo = await getMint(connection, mint);
  const supply   = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

  console.log(`\nCurrent supply      : ${supply.toLocaleString()} RPM`);
  console.log(`Current mint auth   : ${mintInfo.mintAuthority?.toBase58() ?? "None (already revoked)"}`);
  console.log(`Current freeze auth : ${mintInfo.freezeAuthority?.toBase58() ?? "None"}`);
  console.log(`Decimals            : ${mintInfo.decimals}`);

  // Already revoked?
  if (!mintInfo.mintAuthority) {
    console.log("\n✓ Mint authority is already revoked. Nothing to do.");
    process.exit(0);
  }

  // Confirm the wallet is the mint authority
  if (mintInfo.mintAuthority.toBase58() !== payer.publicKey.toBase58()) {
    console.error("\nERROR: Your wallet is NOT the current mint authority.");
    console.error(`  On-chain mint authority : ${mintInfo.mintAuthority.toBase58()}`);
    console.error(`  Your wallet             : ${payer.publicKey.toBase58()}`);
    process.exit(1);
  }

  // Final confirmation prompt
  console.log("\n⚠️  WARNING: This will PERMANENTLY lock the supply at");
  console.log(`   ${supply.toLocaleString()} RPM. No one can ever mint more RPM.`);
  const answer = await ask('\nType "REVOKE" to confirm, or anything else to cancel: ');

  if (answer !== "REVOKE") {
    console.log("\nCancelled. No changes made.");
    process.exit(0);
  }

  // Revoke mint authority (set to null)
  console.log("\nSending transaction to revoke mint authority...");
  const sig = await setAuthority(
    connection,
    payer,                        // payer & signer
    mint,                         // mint account
    payer.publicKey,              // current authority
    AuthorityType.MintTokens,     // authority type to revoke
    null,                         // new authority = null = revoked
    [],                           // multisig signers (none)
    { commitment: "confirmed" }
  );

  console.log("\n✓ Mint authority revoked successfully!");
  console.log(`Signature : ${sig}`);
  console.log(`Explorer  : https://explorer.solana.com/tx/${sig}`);

  // Verify
  console.log("\nVerifying on-chain...");
  const updated = await getMint(connection, mint);
  if (!updated.mintAuthority) {
    console.log("✓ Confirmed — mintAuthority is now null (locked forever).");
    console.log(`  Supply locked at: ${(Number(updated.supply) / Math.pow(10, updated.decimals)).toLocaleString()} RPM`);
  } else {
    console.warn("⚠ Unexpected — mintAuthority still shows:", updated.mintAuthority.toBase58());
  }
}

main().catch(err => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
