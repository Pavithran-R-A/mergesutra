export interface RegistryResult {
  readonly status: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: { readonly message?: string };
}

export interface PublishCheckOptions {
  readonly spec: string;
  readonly version: string;
  readonly head: string;
  readonly npm: (args: string[], options?: { inherit?: boolean }) => RegistryResult;
  readonly out?: (text: string) => void;
  readonly err?: (text: string) => void;
  readonly wait?: () => void;
}

export function preflightPublish(options: PublishCheckOptions): {
  readonly code: number;
  readonly publishRequired: boolean;
};

export function verifyPublished(options: PublishCheckOptions): number;
