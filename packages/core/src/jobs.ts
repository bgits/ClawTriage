export interface IngestPrJobPayload {
  deliveryId: string;
  installationId: number;
  repoId: number;
  owner: string;
  repo: string;
  prNumber: number;
  prId: number;
  headSha: string;
  action: string;
}

export function buildIngestPrJobId(payload: IngestPrJobPayload): string {
  return `ingest-pr-${payload.repoId}-${payload.prId}-${payload.headSha}`;
}
