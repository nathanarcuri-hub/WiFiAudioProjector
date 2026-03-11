import { networkInterfaces } from "node:os";

export function getLanAddresses(): string[] {
  const interfaces = networkInterfaces();
  const addresses = new Set<string>();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.add(entry.address);
      }
    }
  }

  return [...addresses].sort((left, right) => {
    const rankDifference = rankAddress(left) - rankAddress(right);
    if (rankDifference !== 0) {
      return rankDifference;
    }

    return compareIpv4(left, right);
  });
}

function rankAddress(address: string): number {
  if (address.startsWith("192.168.")) {
    return 0;
  }

  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) {
    return 1;
  }

  if (address.startsWith("10.")) {
    return 2;
  }

  if (address.startsWith("169.254.")) {
    return 9;
  }

  return 5;
}

function compareIpv4(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));

  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
