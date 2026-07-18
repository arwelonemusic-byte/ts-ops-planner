const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

export function isValidCode(code: string): boolean {
  return /^[A-Z0-9]{1,16}$/.test(code);
}
