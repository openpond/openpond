import {
  ManagedTrainingClientConfigSchema,
  TrainingBundleManifestSchema,
  type TrainingBundleManifest,
} from "@openpond/contracts";

export type ManagedTrainingAuth = () => Promise<string | null>;
export type ManagedTrainingFetch = typeof fetch;

export class OpenPondManagedTrainingClient {
  private readonly config;

  constructor(input: {
    config: unknown;
    authToken: ManagedTrainingAuth;
    fetch?: ManagedTrainingFetch;
  }) {
    this.config = ManagedTrainingClientConfigSchema.parse(input.config);
    this.authToken = input.authToken;
    this.fetchImpl = input.fetch ?? fetch;
  }

  private readonly authToken: ManagedTrainingAuth;
  private readonly fetchImpl: ManagedTrainingFetch;

  async createUpload(manifestInput: TrainingBundleManifest): Promise<unknown> {
    const manifest = TrainingBundleManifestSchema.parse(manifestInput);
    return this.request("/v1/managed-training/uploads", { method: "POST", body: JSON.stringify({ manifest }) });
  }

  async completeUpload(uploadId: string, payload: unknown): Promise<unknown> {
    return this.request(`/v1/managed-training/uploads/${encodeURIComponent(uploadId)}/complete`, { method: "POST", body: JSON.stringify(payload) });
  }

  async quote(payload: unknown): Promise<unknown> { return this.request("/v1/managed-training/quotes", { method: "POST", body: JSON.stringify(payload) }); }
  async approveQuote(quoteId: string, payload: unknown): Promise<unknown> { return this.request(`/v1/managed-training/quotes/${encodeURIComponent(quoteId)}/approve`, { method: "POST", body: JSON.stringify(payload) }); }
  async launch(payload: unknown): Promise<unknown> { return this.request("/v1/managed-training/executions", { method: "POST", body: JSON.stringify(payload) }); }
  async execution(id: string): Promise<unknown> { return this.request(`/v1/managed-training/executions/${encodeURIComponent(id)}`); }
  async events(id: string): Promise<unknown> { return this.request(`/v1/managed-training/executions/${encodeURIComponent(id)}/events`); }
  async artifacts(id: string): Promise<unknown> { return this.request(`/v1/managed-training/executions/${encodeURIComponent(id)}/artifacts`); }
  async cancel(id: string): Promise<unknown> { return this.request(`/v1/managed-training/executions/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" }); }
  async delete(id: string): Promise<unknown> { return this.request(`/v1/managed-training/executions/${encodeURIComponent(id)}/delete`, { method: "POST", body: "{}" }); }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.config.enabled) throw new Error("OpenPond Managed is not enabled. No bundle was uploaded.");
    const token = await this.authToken();
    if (!token) throw new Error("OpenPond Managed requires an authenticated OpenPond account.");
    const response = await this.fetchImpl(new URL(path, this.config.endpoint), {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
    });
    if (!response.ok) throw new Error(`OpenPond Managed request failed (${response.status}): ${(await response.text()).slice(0, 2_000)}`);
    return response.status === 204 ? null : response.json();
  }
}
