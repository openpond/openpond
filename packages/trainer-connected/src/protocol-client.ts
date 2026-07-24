import {
  WorkerHandshakeResponseSchema,
  WorkerLeaseSchema,
  type AdapterValidationReceipt,
  type LearningSignalBatch,
  type ResolvedTrainingPlan,
  type TrainingArtifacts,
  type TrainingEngineCapabilities,
  type TrainingExecutionRef,
  type TrainingExecutionStatus,
  type WorkerArtifactChunk,
  type WorkerEvent,
  type WorkerHandshakeRequest,
  type WorkerHandshakeResponse,
  type WorkerLease,
  type WorkerLogPage,
  type WorkerResolvedBundle,
} from "@openpond/contracts";

export interface ConnectedWorkerTransport {
  handshake(
    request: WorkerHandshakeRequest,
    secretLeaseRef: string,
  ): Promise<WorkerHandshakeResponse>;
  acquireLease(input: {
    runId: string;
    durationSeconds: number;
  }): Promise<WorkerLease>;
  heartbeat(leaseId: string): Promise<WorkerLease>;
  capabilities(): Promise<TrainingEngineCapabilities>;
  stageBundle(
    bundle: WorkerResolvedBundle,
    leaseId: string,
  ): Promise<WorkerResolvedBundle>;
  validate(plan: ResolvedTrainingPlan): Promise<AdapterValidationReceipt>;
  launch(input: {
    leaseId: string;
    plan: ResolvedTrainingPlan;
    resolvedBundle: WorkerResolvedBundle;
  }): Promise<TrainingExecutionRef>;
  sendSignals(
    ref: TrainingExecutionRef,
    batch: LearningSignalBatch,
  ): Promise<void>;
  status(ref: TrainingExecutionRef): Promise<TrainingExecutionStatus>;
  events(ref: TrainingExecutionRef, afterSequence: number): Promise<WorkerEvent[]>;
  logs(ref: TrainingExecutionRef, cursor?: string): Promise<WorkerLogPage>;
  cancel(ref: TrainingExecutionRef): Promise<void>;
  artifacts(ref: TrainingExecutionRef): Promise<TrainingArtifacts>;
  downloadArtifact(input: {
    ref: TrainingExecutionRef;
    objectRef: string;
    offset: number;
  }): Promise<WorkerArtifactChunk>;
  releaseLease(leaseId: string): Promise<void>;
}

export interface WorkerIdentityVerifier {
  verifyNonce(input: {
    nonce: string;
    signature: string;
    workerId: string;
  }): Promise<boolean>;
}

export class AuthenticatedConnectedWorker {
  private handshake: WorkerHandshakeResponse | null = null;

  constructor(
    readonly transport: ConnectedWorkerTransport,
    private readonly verifier: WorkerIdentityVerifier,
    private readonly connection: {
      clientRelease: string;
      expectedWorkerImageDigest: string;
      secretLeaseRef: string;
      nonce: () => string;
    },
  ) {}

  async connect(): Promise<WorkerHandshakeResponse> {
    if (this.handshake) return this.handshake;
    const nonce = this.connection.nonce();
    const response = WorkerHandshakeResponseSchema.parse(
      await this.transport.handshake(
        {
          protocolVersion: "openpond.connectedWorker.v1",
          clientRelease: this.connection.clientRelease,
          nonce,
          expectedWorkerImageDigest:
            this.connection.expectedWorkerImageDigest,
        },
        this.connection.secretLeaseRef,
      ),
    );
    if (
      response.workerImageDigest !==
      this.connection.expectedWorkerImageDigest
    ) {
      throw new Error("Connected worker image digest does not match the catalog.");
    }
    if (
      !(await this.verifier.verifyNonce({
        nonce,
        signature: response.nonceSignature,
        workerId: response.workerId,
      }))
    ) {
      throw new Error("Connected worker identity verification failed.");
    }
    this.handshake = response;
    return response;
  }

  async acquireLease(input: {
    runId: string;
    durationSeconds: number;
  }): Promise<WorkerLease> {
    await this.connect();
    return WorkerLeaseSchema.parse(await this.transport.acquireLease(input));
  }

  async heartbeat(lease: WorkerLease): Promise<WorkerLease> {
    return WorkerLeaseSchema.parse(
      await this.transport.heartbeat(lease.id),
    );
  }
}
