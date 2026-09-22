import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
import { join } from "node:path";

function minisignText(value) {
  const text = value.trim();
  return text.startsWith("untrusted comment:")
    ? text
    : Buffer.from(text, "base64").toString("utf8").trim();
}

export function normalizePublicKey(value) {
  const content = existsSync(value) ? readFileSync(value, "utf8") : value;
  const raw = Buffer.from(content.trim(), "base64");
  const key = raw.length === 42
    ? raw
    : Buffer.from(minisignText(content).split(/\r?\n/)[1] || "", "base64");
  if (key.length !== 42 || key[0] !== 0x45 || ![0x44, 0x64].includes(key[1])) {
    throw new Error("无效的 Tauri/Minisign 公钥");
  }
  return key.toString("base64");
}

export function loadReleaseSigningEnv(env = process.env) {
  const result = { ...env };
  const keyDir = env.MONA_RELEASE_KEY_DIR?.trim()
    || (env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Mona", "release-keys"));
  const defaultKey = keyDir && join(keyDir, "mona-update.key");
  if (!result.TAURI_SIGNING_PRIVATE_KEY?.trim() && defaultKey && existsSync(defaultKey)) {
    result.TAURI_SIGNING_PRIVATE_KEY = defaultKey;
  }
  const privateKey = result.TAURI_SIGNING_PRIVATE_KEY?.trim();
  if (!privateKey) throw new Error("未找到 Mona 更新私钥；恢复固定密钥，禁止自动重建");
  let publicKeys = result.MONA_UPDATE_PUBLIC_KEYS?.trim();
  if (!publicKeys && existsSync(privateKey) && existsSync(`${privateKey}.pub`)) {
    publicKeys = `${privateKey}.pub`;
  }
  if (!publicKeys) throw new Error("未找到 Mona 更新公钥");
  result.MONA_UPDATE_PUBLIC_KEYS = publicKeys.split(/[;,]/).map((key) => normalizePublicKey(key.trim())).join(",");
  if (result.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    result.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = existsSync(privateKey) && existsSync(`${privateKey}.password`)
      ? readFileSync(`${privateKey}.password`, "utf8").trim()
      : "";
  }
  return result;
}

export async function verifyReleaseSignature(artifact, signature, publicKeys) {
  const lines = minisignText(signature).split(/\r?\n/);
  const packet = Buffer.from(lines[1] || "", "base64");
  if (packet.length !== 74 || !lines[2]?.startsWith("trusted comment: ")) {
    throw new Error("无效的 Minisign 签名格式");
  }
  const algorithm = packet.subarray(0, 2).toString("ascii");
  if (!["Ed", "ED"].includes(algorithm)) throw new Error("不支持的 Minisign 签名算法");
  let message;
  if (algorithm === "ED") {
    const hash = createHash("blake2b512");
    for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    message = hash.digest();
  } else {
    message = readFileSync(artifact);
  }
  const publicKey = publicKeys.map((key) => Buffer.from(normalizePublicKey(key), "base64"))
    .find((key) => key.subarray(2, 10).equals(packet.subarray(2, 10)));
  if (!publicKey) throw new Error("签名密钥与 Mona 发布公钥不匹配");
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.subarray(10)]),
    format: "der",
    type: "spki",
  });
  const detached = packet.subarray(10);
  const commentMessage = Buffer.concat([detached, Buffer.from(lines[2].slice("trusted comment: ".length))]);
  if (!verify(null, message, key, detached)
    || !verify(null, commentMessage, key, Buffer.from(lines[3] || "", "base64"))) {
    throw new Error("安装包或签名已损坏，验签失败");
  }
  return minisignText(signature);
}

