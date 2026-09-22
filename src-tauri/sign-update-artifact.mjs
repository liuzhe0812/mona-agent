import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { loadReleaseSigningEnv, verifyReleaseSignature } from "./release-signing.mjs";

const verifyOnly = process.argv.includes("--verify-only");
const artifactArg = process.argv.find((arg, index) => index >= 2 && arg !== "--verify-only");
const artifact = resolve(artifactArg || "");
if (!artifact || !existsSync(artifact)) throw new Error(`安装包不存在: ${artifact}`);

const signingEnv = loadReleaseSigningEnv();
const privateKey = signingEnv.TAURI_SIGNING_PRIVATE_KEY;
const publicKeys = signingEnv.MONA_UPDATE_PUBLIC_KEYS.split(",");
if (!verifyOnly) {
  const signerEnv = { ...signingEnv };
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
  const signing = spawnSync(
    "cargo",
    ["tauri", "signer", "sign", "--private-key-path", privateKey, artifact],
    { env: signerEnv, stdio: "inherit", shell: false },
  );
  if (signing.error) throw signing.error;
  if (signing.status !== 0) process.exit(signing.status || 1);
}

const signaturePath = `${artifact}.sig`;
if (!existsSync(signaturePath) || statSync(signaturePath).size === 0) {
  throw new Error(`安装包签名文件缺失: ${signaturePath}`);
}
const signature = await verifyReleaseSignature(artifact, readFileSync(signaturePath, "utf8"), publicKeys);
if (!verifyOnly) writeFileSync(signaturePath, `${signature}\n`, "utf8");
console.log(`OK: Ed25519 signature verified: ${signaturePath}`);

