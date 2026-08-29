import { randomInt } from "node:crypto";
import { z } from "zod";

const defaultSymbols = "!@#$%^&*-_=+";
const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const lowercase = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";
const defaultLength = 20;

export const passwordPolicySchema = z.object({
  allowedSymbols: z.string().min(1).max(40).optional(),
  maxLength: z.number().int().min(8).max(64).optional(),
  minLength: z.number().int().min(8).max(64).optional(),
  requireDigit: z.boolean().optional(),
  requireLowercase: z.boolean().optional(),
  requireSymbol: z.boolean().optional(),
  requireUppercase: z.boolean().optional(),
});

export type PasswordPolicy = z.infer<typeof passwordPolicySchema>;

/** Unbiased password that satisfies the structural rules read off a signup form. */
export function generatePassword(policy: PasswordPolicy = {}) {
  const minLength = policy.minLength ?? defaultLength;
  const maxLength = policy.maxLength ?? Math.max(minLength, defaultLength);
  const length = Math.min(Math.max(minLength, defaultLength), maxLength);
  const symbols = sanitizeSymbols(policy.allowedSymbols ?? defaultSymbols);
  const requireUppercase = policy.requireUppercase !== false;
  const requireLowercase = policy.requireLowercase !== false;
  const requireDigit = policy.requireDigit !== false;
  const requireSymbol = policy.requireSymbol !== false;

  const alphabet = [
    ...(requireUppercase ? uppercase : ""),
    ...(requireLowercase ? lowercase : ""),
    ...(requireDigit ? digits : ""),
    ...(requireSymbol ? symbols : ""),
  ].join("");
  if (alphabet.length === 0) {
    throw new Error("Password policy left no allowed character classes.");
  }

  const required: string[] = [];
  if (requireUppercase) required.push(pick(uppercase));
  if (requireLowercase) required.push(pick(lowercase));
  if (requireDigit) required.push(pick(digits));
  if (requireSymbol) required.push(pick(symbols));

  const chars = [...required];
  while (chars.length < length) {
    chars.push(pick(alphabet));
  }
  shuffle(chars);
  return chars.join("");
}

function sanitizeSymbols(value: string) {
  const allowed = value.replaceAll(/[^!@#$%^&*\-_=+]/gu, "");
  return allowed.length > 0 ? allowed : defaultSymbols;
}

function pick(source: string) {
  return source[randomInt(source.length)] ?? source[0] ?? "x";
}

function shuffle(values: string[]) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    const current = values[index];
    const other = values[swap];
    if (current === undefined || other === undefined) continue;
    values[index] = other;
    values[swap] = current;
  }
}
