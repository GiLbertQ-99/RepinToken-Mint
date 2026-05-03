/**
 * update_metadata_uri.js
 *
 * Updates the off-chain metadata URI for a Solana SPL token using
 * the Metaplex Token Metadata program (updateMetadataAccountV2).
 *
 * Usage:
 *   SOLANA_ENV=mainnet node solana-mint/update_metadata_uri.js \
 *     <MINT_ADDRESS> \
 *     <NEW_ARWEAVE_URI>
 *
 * Example:
 *   SOLANA_ENV=mainnet node solana-mint/update_metadata_uri.js \
 *     HbKeBFeLmMYZuWFCm2CvnN66XBL8fx5Sf6Mk7s9KeXFj \
 *     https://arweave.net/<YOUR_NEW_TX_ID>
 *
 * Requirements:
 *   - solana-mint/wallet.json must contain the update authority keypair
 *   - The wallet must match the updateAuthority stored on-chain
 */

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const mpl = require("@metaplex-foundation/mpl-token-metadata");
const {
  createUpdateMetadataAccountV2Instruction,
  Metadata,
  PROGRAM_ID: METADATA_PROGRAM_ID,
} = mpl;

// ─── CLI args ────────────────────────────────────────────────────────────────
const [, , mintArg, newUriArg] = process.argv;

if (!mintArg || !newUriArg) {
  console.error(
    "Usage: SOLANA_ENV=mainnet node solana-mint/update_metadata_uri.js <MINT> <NEW_URI>"
  );
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────
const SOLANA_ENV = process.env.SOLANA_ENV || "mainnet";
const RPC_URL =
  SOLANA_ENV === "mainnet"
    ? clusterApiUrl("mainnet-beta")
    : clusterApiUrl("devnet");

const WALLET_PATH = path.join(__dirname, "wallet.json");

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  // Load wallet
  if (!fs.existsSync(WALLET_PATH)) {
    console.error(`Wallet not found at: ${WALLET_PATH}`);
    console.error("Make sure solana-mint/wallet.json is present.");
    process.exit(1);
  }
  const rawWallet = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(rawWallet));
  console.log("Wallet loaded:", payer.publicKey.toBase58());

  const mintPubkey = new PublicKey(mintArg);
  const newUri = newUriArg.trim();

  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`\nNetwork : ${SOLANA_ENV} (${RPC_URL})`);
  console.log(`Mint    : ${mintPubkey.toBase58()}`);
  console.log(`New URI : ${newUri}\n`);

  // ── Derive metadata PDA ───────────────────────────────────────────────────
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
  console.log("Metadata PDA:", metadataPDA.toBase58());

  // ── Fetch current on-chain metadata ──────────────────────────────────────
  const accountInfo = await connection.getAccountInfo(metadataPDA);
  if (!accountInfo) {
    console.error("No metadata account found on-chain for this mint.");
    process.exit(1);
  }

  const [decoded] = Metadata.deserialize(accountInfo.data);
  const currentData = decoded.data;

  const name = currentData.name.replace(/\0/g, "").trim();
  const symbol = currentData.symbol.replace(/\0/g, "").trim();
  const oldUri = currentData.uri.replace(/\0/g, "").trim();
  const sellerFeeBasisPoints = currentData.sellerFeeBasisPoints;
  const creators = currentData.creators ?? null;

  console.log("\n=== Current On-Chain Metadata ===");
  console.log("Name       :", name);
  console.log("Symbol     :", symbol);
  console.log("Old URI    :", oldUri);
  console.log("Seller fee :", sellerFeeBasisPoints, "bps");
  console.log("isMutable  :", decoded.isMutable);
  console.log("Update Auth:", decoded.updateAuthority.toBase58());

  // Verify our wallet is the update authority
  if (decoded.updateAuthority.toBase58() !== payer.publicKey.toBase58()) {
    console.error("\nERROR: Your wallet is NOT the update authority.");
    console.error(
      `  On-chain authority : ${decoded.updateAuthority.toBase58()}`
    );
    console.error(`  Your wallet        : ${payer.publicKey.toBase58()}`);
    console.error(
      "Make sure you are using the correct wallet.json for this token."
    );
    process.exit(1);
  }

  // ── Build the update instruction ─────────────────────────────────────────
  const updateInstruction = createUpdateMetadataAccountV2Instruction(
    {
      metadata: metadataPDA,
      updateAuthority: payer.publicKey,
    },
    {
      updateMetadataAccountArgsV2: {
        data: {
          name,
          symbol,
          uri: newUri,
          sellerFeeBasisPoints,
          creators,
          collection: currentData.collection ?? null,
          uses: currentData.uses ?? null,
        },
        updateAuthority: decoded.updateAuthority,
        primarySaleHappened: decoded.primarySaleHappened,
        isMutable: decoded.isMutable,
      },
    }
  );

  // ── Send transaction ──────────────────────────────────────────────────────
  const tx = new Transaction().add(updateInstruction);

  console.log("\nSending update transaction...");
  let sig;
  try {
    sig = await sendAndConfirmTransaction(connection, tx, [payer], {
      commitment: "confirmed",
    });
  } catch (err) {
    console.error("\nTransaction failed:", err.message);
    if (err.logs) {
      console.error("Program logs:");
      err.logs.forEach((l) => console.error(" ", l));
    }
    process.exit(1);
  }

  console.log("\n✓ Metadata URI updated successfully!");
  console.log("Signature:", sig);
  console.log(
    `Explorer : https://explorer.solana.com/tx/${sig}${
      SOLANA_ENV !== "mainnet" ? "?cluster=devnet" : ""
    }`
  );

  // ── Verify the update ─────────────────────────────────────────────────────
  console.log("\nVerifying update on-chain...");
  const updatedAccount = await connection.getAccountInfo(metadataPDA);
  const [updatedMeta] = Metadata.deserialize(updatedAccount.data);
  const updatedUri = updatedMeta.data.uri.replace(/\0/g, "").trim();

  if (updatedUri === newUri) {
    console.log("✓ Verified — new URI matches on-chain:", updatedUri);
  } else {
    console.warn("⚠ On-chain URI after update:", updatedUri);
    console.warn("  Expected:", newUri);
    console.warn("  (May need to wait for confirmation to propagate)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
