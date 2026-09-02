import { ContinualBenchmarkProtocolReleaseSchema, ContinualBenchIssuePacketSchema, type ContinualBenchmarkProtocolRelease, type ContinualBenchIssuePacket } from "./schema.js";
import { contentHash } from "./hash.js";

export function sealProtocol(input: Omit<ContinualBenchmarkProtocolRelease, "contentHash">): ContinualBenchmarkProtocolRelease {
  return ContinualBenchmarkProtocolReleaseSchema.parse({ ...input, contentHash: contentHash(input) });
}

export function verifyProtocol(protocol: ContinualBenchmarkProtocolRelease): boolean {
  const parsed = ContinualBenchmarkProtocolReleaseSchema.parse(protocol);
  const { contentHash: declared, ...release } = parsed;
  return declared === contentHash(release);
}

export function sealIssuePacket(input: Omit<ContinualBenchIssuePacket, "contentHash">): ContinualBenchIssuePacket {
  return ContinualBenchIssuePacketSchema.parse({ ...input, contentHash: contentHash(input) });
}

export function verifyIssuePacket(packet: ContinualBenchIssuePacket): boolean {
  const parsed = ContinualBenchIssuePacketSchema.parse(packet);
  const { contentHash: declared, ...release } = parsed;
  return declared === contentHash(release);
}
