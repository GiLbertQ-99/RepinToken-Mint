/**
 * check_metadata.js
 * Usage: node solana-mint/check_metadata.js <MINT_ADDRESS>
 *
 * Fetches and decodes on-chain Metaplex token metadata for a given mint.
 * Fix: uses CommonJS require() to avoid ESM named-export error with
 *      @metaplex-foundation/mpl-token-metadata.
 */

const { Connection, PublicKey, clusterApiUrl } = require("@solana/web3.js");
const mplTokenMetadata = require("@metaplex-foundation/mpl-token-metadata");
const fetch = require("node-fetch");

// Support both old and new package shapes
const Metadata = mplTokenMetadata.Metadata || mplTokenMetadata.default?.Metadata;
const METADATA_PROGRAM_ID =
  mplTokenMetadata.PROGRAM_ID ||
  mplTokenMetadata.default?.PROGRAM_ID ||
  new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

// --- Config ---
const SOLANA_ENV = process.env.SOLANA_ENV || "mainnet";
const RPC_URL =
  SOLANA_ENV === "mainnet"
    ? clusterApiUrl("mainnet-beta")
    : clusterApiUrl("devnet");

const mintArg = process.argv[2];
if (!mintArg) {
  console.error("Usage: node solana-mint/check_metadata.js <MINT_ADDRESS>");
  process.exit(1);
}

async function main() {
  const mintPubkey = new PublicKey(mintArg);
  const connection = new Connection(RPC_URL, "confirmed");

  console.log(`\nNetwork : ${SOLANA_ENV} (${RPC_URL})`);
  console.log(`Mint    : ${mintPubkey.toBase58()}\n`);

  // Derive Metadata PDA
  const [metadataPDA] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mintPubkey.toBuffer(),
    ],
    METADATA_PROGRAM_ID
  );
  console.log(`Metadata PDA : ${metadataPDA.toBase58()}`);

  // Fetch on-chain account
  const accountInfo = await connection.getAccountInfo(metadataPDA);
  if (!accountInfo) {
    console.error("No metadata account found on-chain for this mint.");
    process.exit(1);
  }

  // Decode with Metaplex
  let decoded;
  try {
    decoded = Metadata.deserialize(accountInfo.data)[0];
  } catch (e) {
    console.error("Failed to deserialize metadata:", e.message);
    console.log("Raw account data (hex, first 256 bytes):");
    console.log(accountInfo.data.slice(0, 256).toString("hex"));
    process.exit(1);
  }

  const data = decoded.data;
  console.log("\n=== On-Chain Metadata ===");
  console.log("Name       :", data.name.replace(/\0/g, "").trim());
  console.log("Symbol     :", data.symbol.replace(/\0/g, "").trim());
  console.log("URI        :", data.uri.replace(/\0/g, "").trim());
  console.log("Seller fee :", data.sellerFeeBasisPoints, "bps");
  if (data.creators && data.creators.length > 0) {
    console.log("Creators   :");
    data.creators.forEach((c) => {
      console.log(`  ${c.address.toBase58()}  share=${c.share}%  verified=${c.verified}`);
    });
  }
  console.log("isMutable  :", decoded.isMutable);
  console.log("Update Auth:", decoded.updateAuthority.toBase58());

  // Fetch off-chain JSON metadata
  const uri = data.uri.replace(/\0/g, "").trim();
  if (uri) {
    console.log("\n=== Fetching off-chain JSON from URI ===");
    console.log("URI:", uri);

    // Try multiple Arweave gateways if the primary fails
    const gateways = [
      uri,
      uri.replace("https://arweave.net/", "https://gateway.irys.xyz/"),
      uri.replace("https://arweave.net/", "https://ar-io.dev/"),
    ];

    let fetched = false;
    for (const url of gateways) {
      try {
        console.log(`\nTrying: ${url}`);
        const res = await fetch(url, {
          timeout: 15000,
          headers: { Accept: "application/json, */*" },
        });
        console.log(`Status  : ${res.status} ${res.statusText}`);
        console.log(`Content-Type: ${res.headers.get("content-type")}`);

        const rawBuf = await res.buffer();
        const rawText = rawBuf.toString("utf8");
        console.log(`Body (first 500 chars): ${rawText.slice(0, 500)}`);

        // Try to parse as JSON
        try {
          const json = JSON.parse(rawText);
          console.log("\n=== Off-Chain Metadata (parsed) ===");
          console.log(JSON.stringify(json, null, 2));
          if (json.image) {
            console.log("\n=== Image URI ===");
            console.log(json.image);
          }
          fetched = true;
          break;
        } catch {
          console.log(
            "\n  ^ Not valid JSON — raw hex (first 64 bytes):",
            rawBuf.slice(0, 64).toString("hex")
          );
        }
      } catch (fetchErr) {
        console.error(`  Fetch error: ${fetchErr.message}`);
      }
    }

    if (!fetched) {
      console.log(
        "\nAll gateways failed or returned non-JSON. The Arweave upload may be corrupt or the wrong content type."
      );
      console.log("Recommendation: re-upload your metadata JSON to Arweave and update the on-chain URI.");
    }
  } else {
    console.log("\n(No off-chain URI set on this token)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
