import { randomBytes } from "node:crypto";

// Generates a base64-encoded 32-byte key suitable for TOKEN_ENCRYPTION_KEY.
process.stdout.write(`${randomBytes(32).toString("base64")}\n`);
