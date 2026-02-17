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

export interface PublicPrScanJobPayload {
  owner: string;
  repo: string;
  snapshot: string;
  maxOpenPrs?: number;
}

export function buildIngestPrJobId(payload: IngestPrJobPayload): string {
  return `ingest-pr-${payload.repoId}-${payload.prId}-${payload.headSha}`;
}

export function buildPublicPrScanJobId(payload: PublicPrScanJobPayload): string {
  return `public-pr-scan-${payload.owner}-${payload.repo}-${payload.snapshot}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
}
