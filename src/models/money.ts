/**
 * All money inside the domain is integer cents. Decimal strings only exist at
 * the edges (provider APIs, JSON views). JS floats never touch amounts.
 */

export function centsToDecimalString(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`amount is not an integer number of cents: ${cents}`);
  }
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const units = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${units}.${rest.toString().padStart(2, "0")}`;
}

export function decimalStringToCents(value: string | number): number {
  const str = typeof value === "number" ? value.toFixed(2) : value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(str);
  if (!match) {
    throw new Error(`cannot parse money value: ${JSON.stringify(value)}`);
  }
  const [, sign, units, decimals = ""] = match;
  const cents = Number(units) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`money value out of safe range: ${JSON.stringify(value)}`);
  }
  return sign === "-" ? -cents : cents;
}
