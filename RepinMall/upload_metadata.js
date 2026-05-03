/**
 * upload_metadata.js
 *
 * Uploads token metadata (and optionally an image) to Arweave via Irys,
 * funded by your Solana wallet. Files are uploaded with the correct
 * Content-Type so wallets and explorers can read them.
 *
 * Usage (image + metadata):
 *   SOLANA_ENV=mainnet node solana-mint/upload_metadata.js \
 *     --name "RepinMall" \
 *     --symbol "RPM" \
 *     --description "Your description here" \
 *     --image /path/to/image.png
 *
 * Usage (metadata only, you already have an image URI):
 *   SOLANA_ENV=mainnet node solana-mint/upload_metadata.js \
 *     --name "RepinMall" \
 *     --symbol "RPM" \
 *     --description "Your description here" \
 *     --image-uri https://arweave.net/<existing-image-tx>
 *
 * Usage (use existing JSON file):
 *   SOLANA_ENV=mainnet node solana-mint/upload_metadata.js \
 *     --json-file /path/to/metadata.json
 *
 * Flags:
 *   --name          Token name
 *   --symbol        Token symbol
 *   --description   Token description
 *   --image         Path to a local image file to upload first
 *   --image-uri     Already-hosted image URI (skip image upload)
 *   --json-file     Path to a pre-built JSON file to upload directly
 *   --attributes    JSON string of attributes array, e.g. '[{"trait_type":"Tier","value":"Gold"}]'
 *   --dry-run       Print the metadata JSON and cost estimate, but do NOT upload
 *
 * After running, copy the printed "Metadata URI" and use it with:
 *   SOLANA_ENV=mainnet node update_metadata_uri.js <MINT> <METADATA_URI>
 */

const { NodeIrys } = require("@irys/sdk");
const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");

// ─── Parse CLI args ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const isDryRun = args.includes("--dry-run");
const nameArg = getArg("--name");
const symbolArg = getArg("--symbol");
const descArg = getArg("--description") || "";
const imageFileArg = getArg("--image");
const imageUriArg = getArg("--image-uri");
const jsonFileArg = getArg("--json-file");
const attributesArg = getArg("--attributes");

if (!jsonFileArg && !nameArg) {
  console.error(
    "Provide either --json-file <path> or at least --name and --symbol.\n"
  );
  console.error(
    "Usage: node solana-mint/upload_metadata.js --name <NAME> --symbol <SYM> [options]"
  );
  process.exit(1);
}

// ─── Config ──────────────────────────────────────────────────────────────────
const SOLANA_ENV = process.env.SOLANA_ENV || "mainnet";
const IRYS_URL =
  SOLANA_ENV === "mainnet"
    ? "https://node1.irys.xyz"
    : "https://devnet.irys.xyz";

const WALLET_PATH = path.join(__dirname, "wallet.json");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function loadWallet() {
  if (!fs.existsSync(WALLET_PATH)) {
    console.error(`Wallet not found at: ${WALLET_PATH}`);
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, "utf8"));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

async function getIrys(keypair) {
  // NodeIrys for Solana expects the secret key as a JSON array (same format as wallet.json)
  const keyArray = Array.from(keypair.secretKey);
  const irys = new NodeIrys({
    url: IRYS_URL,
    token: "solana",
    key: keyArray,
    config: {
      providerUrl:
        SOLANA_ENV === "mainnet"
          ? "https://api.mainnet-beta.solana.com"
          : "https://api.devnet.solana.com",
    },
  });
  await irys.ready();
  return irys;
}

function formatLamports(lamports) {
  return `${(Number(lamports) / 1e9).toFixed(9)} SOL`;
}

async function uploadFile(irys, filePath, contentType) {
  const data = fs.readFileSync(filePath);
  const size = data.length;
  const price = await irys.getPrice(size);
  console.log(
    `  Uploading ${path.basename(filePath)} (${size} bytes) — cost: ${formatLamports(price)}`
  );

  // Auto-fund if balance is short
  const balance = await irys.getLoadedBalance();
  if (balance.lt(price)) {
    const needed = price.minus(balance);
    console.log(`  Funding Irys node with ${formatLamports(needed)}...`);
    await irys.fund(needed);
  }

  const receipt = await irys.uploadFile(filePath, {
    tags: [{ name: "Content-Type", value: contentType }],
  });
  return `https://arweave.net/${receipt.id}`;
}

async function uploadJson(irys, jsonObj) {
  const jsonStr = JSON.stringify(jsonObj, null, 2);
  const data = Buffer.from(jsonStr, "utf8");
  const size = data.length;
  const price = await irys.getPrice(size);
  console.log(`  Uploading metadata JSON (${size} bytes) — cost: ${formatLamports(price)}`);

  // Auto-fund if balance is short
  const balance = await irys.getLoadedBalance();
  if (balance.lt(price)) {
    const needed = price.minus(balance);
    console.log(`  Funding Irys node with ${formatLamports(needed)}...`);
    await irys.fund(needed);
  }

  const receipt = await irys.upload(data, {
    tags: [
      { name: "Content-Type", value: "application/json" },
      { name: "App-Name", value: "Solana-Token-Metadata" },
    ],
  });
  return `https://arweave.net/${receipt.id}`;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const keypair = loadWallet();
  console.log("Wallet :", keypair.publicKey.toBase58());
  console.log("Network:", SOLANA_ENV, `(Irys: ${IRYS_URL})\n`);

  // ── Case 1: raw JSON file provided ───────────────────────────────────────
  if (jsonFileArg) {
    if (!fs.existsSync(jsonFileArg)) {
      console.error("JSON file not found:", jsonFileArg);
      process.exit(1);
    }
    const jsonObj = JSON.parse(fs.readFileSync(jsonFileArg, "utf8"));
    console.log("=== Metadata to upload ===");
    console.log(JSON.stringify(jsonObj, null, 2));

    if (isDryRun) {
      const size = Buffer.byteLength(JSON.stringify(jsonObj, null, 2));
      const irys = await getIrys(keypair);
      const price = await irys.getPrice(size);
      console.log(`\n[dry-run] Would cost ~${formatLamports(price)} to upload.`);
      return;
    }

    const irys = await getIrys(keypair);
    console.log("\nUploading JSON...");
    const uri = await uploadJson(irys, jsonObj);
    console.log("\n✓ Metadata uploaded!");
    console.log("Metadata URI:", uri);
    console.log("\nNext step — update your on-chain URI:");
    console.log(
      `  SOLANA_ENV=mainnet node update_metadata_uri.js <MINT> "${uri}"`
    );
    return;
  }

  // ── Case 2: build metadata from flags ────────────────────────────────────
  let attributes = [];
  if (attributesArg) {
    try {
      attributes = JSON.parse(attributesArg);
    } catch {
      console.error("--attributes must be a valid JSON array string.");
      process.exit(1);
    }
  }

  let imageUri = imageUriArg || null;

  // Upload image if a local file was provided
  if (imageFileArg) {
    if (!fs.existsSync(imageFileArg)) {
      console.error("Image file not found:", imageFileArg);
      process.exit(1);
    }
    const ext = path.extname(imageFileArg).toLowerCase();
    const mimeMap = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".webp": "image/webp",
    };
    const contentType = mimeMap[ext] || "image/png";

    const size = fs.statSync(imageFileArg).size;

    if (isDryRun) {
      const irys = await getIrys(keypair);
      const price = await irys.getPrice(size);
      console.log(
        `[dry-run] Image upload would cost ~${formatLamports(price)}`
      );
    } else {
      console.log("Uploading image to Arweave...");
      const irys = await getIrys(keypair);
      imageUri = await uploadFile(irys, imageFileArg, contentType);
      console.log("✓ Image URI:", imageUri);
    }
  }

  // Build metadata JSON
  const metadata = {
    name: nameArg,
    symbol: symbolArg,
    description: descArg,
    image: imageUri || "",
    attributes,
    properties: {
      files: imageUri
        ? [
            {
              uri: imageUri,
              type:
                imageFileArg
                  ? (() => {
                      const ext = path.extname(imageFileArg).toLowerCase();
                      return (
                        { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[ext] || "image/png"
                      );
                    })()
                  : "image/png",
            },
          ]
        : [],
      category: "image",
    },
  };

  console.log("\n=== Metadata JSON to upload ===");
  console.log(JSON.stringify(metadata, null, 2));

  if (isDryRun) {
    const size = Buffer.byteLength(JSON.stringify(metadata, null, 2));
    const irys = await getIrys(keypair);
    const price = await irys.getPrice(size);
    console.log(`\n[dry-run] JSON upload would cost ~${formatLamports(price)}`);
    console.log("Remove --dry-run to actually upload.");
    return;
  }

  console.log("\nUploading metadata JSON to Arweave...");
  const irys = await getIrys(keypair);
  const metadataUri = await uploadJson(irys, metadata);

  console.log("\n✓ Metadata uploaded successfully!");
  console.log("Metadata URI:", metadataUri);
  console.log("\nNext step — update your on-chain URI:");
  console.log(
    `  SOLANA_ENV=mainnet node update_metadata_uri.js HbKeBFeLmMYZuWFCm2CvnN66XBL8fx5Sf6Mk7s9KeXFj "${metadataUri}"`
  );
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  if (err.message && err.message.includes("Not enough funds")) {
    console.error(
      "\nYour Irys balance is too low. Fund it with:\n" +
        "  node -e \"const Irys = require('@irys/sdk'); /* see docs */\"\n" +
        "Or send a small amount of SOL to your wallet and re-run."
    );
  }
  process.exit(1);
});
