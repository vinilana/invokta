import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const algorithm = "scrypt";
const cost = 32_768;
const blockSize = 8;
const parallelization = 1;
const keyLength = 32;
const saltLength = 16;
const maximumMemory = 64 * 1024 * 1024;
const minimumPasswordLength = 12;
const maximumPasswordBytes = 1_024;

function validatePassword(password: string): void {
  if (password.length < minimumPasswordLength) {
    throw new Error("The password must contain at least 12 characters.");
  }
  if (Buffer.byteLength(password, "utf8") > maximumPasswordBytes) {
    throw new Error("The password is too long.");
  }
}

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: cost, r: blockSize, p: parallelization, maxmem: maximumMemory },
      (error, result) => {
        if (error === null) resolve(result);
        else reject(error);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(saltLength);
  const hash = await derive(password, salt);
  return [
    algorithm,
    String(cost),
    String(blockSize),
    String(parallelization),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > maximumPasswordBytes) return false;
  const [
    name,
    costText,
    blockSizeText,
    parallelizationText,
    saltText,
    hashText,
  ] = encoded.split("$");
  if (
    name !== algorithm ||
    costText !== String(cost) ||
    blockSizeText !== String(blockSize) ||
    parallelizationText !== String(parallelization) ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return false;
  }
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltText, "base64url");
    expected = Buffer.from(hashText, "base64url");
  } catch {
    return false;
  }
  if (salt.length !== saltLength || expected.length !== keyLength) return false;
  const received = await derive(password, salt);
  return timingSafeEqual(expected, received);
}
