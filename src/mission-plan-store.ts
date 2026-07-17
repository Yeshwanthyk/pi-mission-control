import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withOwnedLocks } from "./atomic.ts";
import { MissionOperationStore } from "./mission-operation-store.ts";
import { createStorePaths, type StorePaths } from "./paths.ts";
import type {
  MissionEvidenceLink,
  MissionExecutionBinding,
  MissionGeneration,
  MissionGenerationPointer,
  MissionOperation,
  MissionOperationKind,
  MissionPlan,
  MissionSessionAttribution,
  MissionSessionBinding,
  MissionSessionBindingHistoryEntry,
} from "./mission-types.ts";
import {
  MissionContractError,
  assertMissionTransition,
  normalizedRequestDigest,
  parseEvidenceLink,
  parseExecutionBinding,
  parseGenerationPointer,
  parseMissionGeneration,
  parseMissionPlan,
  parseSessionAttribution,
  parseSessionBinding,
  storageKey,
} from "./mission-validation.ts";
import { asJsonValue } from "./validation.ts";
import { MissionStore } from "./store.ts";
import { runMission } from "./runtime.ts";

interface GenerationPatch {
  readonly plan?: MissionPlan;
  readonly session?: MissionSessionAttribution;
  readonly binding?: MissionSessionBinding;
  readonly bindingHistory?: MissionSessionBindingHistoryEntry;
  readonly execution?: MissionExecutionBinding;
  readonly evidence?: MissionEvidenceLink;
  readonly contextToken?: string;
  readonly eventId?: string;
}

interface OperationRequest {
  readonly missionId: string;
  readonly itemId?: string;
  readonly kind: MissionOperationKind;
  readonly idempotencyKey: string;
  readonly value: unknown;
  readonly mirrorMissionId?: string;
  readonly bindingSessionId?: string;
  readonly mutate: (
    generation: MissionGeneration | undefined,
    operation: MissionOperation,
  ) => Promise<GenerationPatch>;
}

export interface BindingMutationInput {
  readonly sessionId: string;
  readonly missionId?: string;
  readonly itemId?: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly changedBy?: "operator" | "explicit-fork";
}

export class MissionPlanStore {
  readonly paths: StorePaths;
  readonly operations: MissionOperationStore;

  constructor(root?: string) {
    this.paths = createStorePaths(root);
    this.operations = new MissionOperationStore(root);
  }

  async initialize(): Promise<void> {
    const directories = [
      this.paths.root,
      this.paths.plans,
      this.paths.missionGenerations,
      this.paths.missionCurrent,
      this.paths.missionSessions,
      this.paths.sessionBindings,
      this.paths.bindingHistory,
      this.paths.missionLinks,
      this.paths.missionOperations,
      this.paths.migrations,
      this.paths.locks,
    ];
    await Promise.all(
      directories.map((directory) => mkdir(directory, { recursive: true })),
    );
    try {
      await readFile(this.paths.manifest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await writeAtomic(
        this.paths.manifest,
        stringify({ schema: "pi.mission-store-manifest/v1" }),
      );
    }
  }

  async createPlan(
    planValue: MissionPlan | unknown,
    idempotencyKey: string,
  ): Promise<MissionPlan> {
    const plan = parseMissionPlan(planValue);
    if (plan.revision !== 0)
      throw new MissionContractError(
        "INVALID_PLAN_REVISION",
        "new plan revision must be 0",
      );
    await this.transact({
      missionId: plan.missionId,
      kind: "plan-create",
      idempotencyKey,
      value: plan,
      mutate: async (generation) => {
        if (
          generation?.planRevision !== null &&
          generation?.planRevision !== undefined
        ) {
          const existing = await this.readPlanFromGeneration(generation);
          if (existing && stringify(existing) === stringify(plan))
            return { plan: existing };
          throw new MissionContractError("PLAN_EXISTS", plan.missionId);
        }
        return { plan };
      },
    });
    return plan;
  }

  async replacePlan(
    planValue: MissionPlan | unknown,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<MissionPlan> {
    const plan = parseMissionPlan(planValue);
    if (plan.revision !== expectedRevision + 1) {
      throw new MissionContractError(
        "INVALID_PLAN_REVISION",
        "replacement revision must increment expected revision",
      );
    }
    await this.transact({
      missionId: plan.missionId,
      kind: "plan-mutate",
      idempotencyKey,
      value: { plan, expectedRevision },
      mutate: async (generation) => {
        if (!generation || generation.planRevision !== expectedRevision) {
          throw new MissionContractError(
            "STALE_PLAN_REVISION",
            `expected ${expectedRevision}`,
          );
        }
        const current = await this.readPlanFromGeneration(generation);
        if (!current) {
          throw new MissionContractError("PLAN_NOT_FOUND", plan.missionId);
        }
        assertMissionTransition(current.state, plan.state);
        const nextById = new Map(plan.items.map((item) => [item.itemId, item]));
        for (const item of current.items) {
          const next = nextById.get(item.itemId);
          if (!next) {
            throw new MissionContractError(
              "ITEM_REMOVAL_FORBIDDEN",
              item.itemId,
            );
          }
          assertMissionTransition(item.state, next.state);
        }
        return { plan };
      },
    });
    return plan;
  }

  async upsertSession(
    value: MissionSessionAttribution | unknown,
    expectedRevision: number | null,
    idempotencyKey: string,
  ): Promise<MissionSessionAttribution> {
    const session = parseSessionAttribution(value);
    await this.transact({
      missionId: session.missionId,
      kind: "session-upsert",
      idempotencyKey,
      value: { session, expectedRevision },
      mutate: async (generation) => {
        const current = generation
          ? await this.findSession(generation, session.sessionId)
          : undefined;
        if (
          (current?.revision ?? null) !== expectedRevision ||
          session.revision !== (expectedRevision ?? -1) + 1
        ) {
          throw new MissionContractError(
            "STALE_SESSION_REVISION",
            session.sessionId,
          );
        }
        return { session };
      },
    });
    return session;
  }

  async setBinding(
    input: BindingMutationInput,
  ): Promise<MissionSessionBinding> {
    await this.initialize();
    const existing = await this.getBinding(input.sessionId);
    const recovered = await this.operations.findByIdempotencyKey(
      input.idempotencyKey,
      "binding-set",
      normalizedRequestDigest(asJsonValue(input)),
    );
    const targetMissionId = input.missionId;
    const operationMissionId =
      targetMissionId ?? existing?.missionId ?? recovered?.missionId;
    const recoveredMirror = recovered?.resultRef?.startsWith("mirror:")
      ? recovered.resultRef.slice("mirror:".length)
      : undefined;
    const mirrorMissionId =
      existing?.missionId && existing.missionId !== operationMissionId
        ? existing.missionId
        : recoveredMirror;
    if (!operationMissionId) {
      throw new MissionContractError(
        "UNBOUND_NO_MISSION",
        "clear requires an existing binding",
      );
    }
    const lockMissionIds = [
      existing?.missionId,
      targetMissionId,
      operationMissionId,
      mirrorMissionId,
    ].filter((value): value is string => value !== undefined);
    return withOwnedLocks(
      lockMissionIds.map((missionId) => this.missionLock(missionId)),
      async () => {
        const before = await this.getBinding(input.sessionId);
        const operationId = this.operations.operationId(
          operationMissionId,
          input.idempotencyKey,
        );
        await this.transactUnlocked({
          missionId: operationMissionId,
          kind: "binding-set",
          idempotencyKey: input.idempotencyKey,
          value: input,
          ...defined("mirrorMissionId", mirrorMissionId),
          bindingSessionId: input.sessionId,
          mutate: async (_generation, operation) => {
            if ((before?.revision ?? 0) !== input.expectedRevision) {
              throw new MissionContractError(
                "STALE_BINDING_REVISION",
                input.sessionId,
              );
            }
            if (targetMissionId && input.itemId) {
              const generation =
                await this.readGenerationOwned(targetMissionId);
              const plan = generation
                ? await this.readPlanFromGeneration(generation)
                : undefined;
              if (!plan?.items.some((item) => item.itemId === input.itemId)) {
                throw new MissionContractError("UNKNOWN_ITEM", input.itemId);
              }
              if (
                !generation ||
                !(await this.findSession(generation, input.sessionId))
              ) {
                throw new MissionContractError(
                  "SESSION_NOT_MEMBER",
                  input.sessionId,
                );
              }
            } else if (targetMissionId || input.itemId) {
              throw new MissionContractError(
                "INVALID_BINDING",
                "missionId and itemId must be supplied together",
              );
            }
            const changedAt = operation.createdAt;
            const binding: MissionSessionBinding =
              targetMissionId && input.itemId
                ? {
                    schema: "pi.mission-session-binding/v1",
                    sessionId: input.sessionId,
                    revision: input.expectedRevision + 1,
                    state: "bound",
                    missionId: targetMissionId,
                    itemId: input.itemId,
                    changedAt,
                    changedBy: input.changedBy ?? "operator",
                    previousRevision: input.expectedRevision,
                  }
                : {
                    schema: "pi.mission-session-binding/v1",
                    sessionId: input.sessionId,
                    revision: input.expectedRevision + 1,
                    state: "unbound",
                    changedAt,
                    changedBy: input.changedBy ?? "operator",
                    previousRevision: input.expectedRevision,
                  };
            parseSessionBinding(binding);
            const history: MissionSessionBindingHistoryEntry = {
              schema: "pi.mission-session-binding-history/v1",
              sessionId: input.sessionId,
              revision: binding.revision,
              operationId,
              before: before ?? null,
              after: binding,
              recordedAt: changedAt,
            };
            return { binding, bindingHistory: history };
          },
        });
        const binding = await this.getBinding(input.sessionId);
        if (!binding) {
          throw new MissionContractError(
            "CORRUPT_COMMITTED_OPERATION",
            operationId,
          );
        }
        return binding;
      },
    );
  }

  async forkBinding(
    fromSessionId: string,
    toSessionId: string,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<MissionSessionBinding> {
    const source = await this.getBinding(fromSessionId);
    if (
      !source ||
      source.state !== "bound" ||
      !source.missionId ||
      !source.itemId
    )
      throw new MissionContractError("SOURCE_UNBOUND", fromSessionId);
    return this.setBinding({
      sessionId: toSessionId,
      missionId: source.missionId,
      itemId: source.itemId,
      expectedRevision,
      idempotencyKey,
      changedBy: "explicit-fork",
    });
  }

  async getBinding(
    sessionId: string,
  ): Promise<MissionSessionBinding | undefined> {
    const sessionKey = storageKey("session", sessionId);
    let pointers;
    try {
      pointers = await import("node:fs/promises").then(({ readdir }) =>
        readdir(this.paths.missionCurrent, { withFileTypes: true }),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const candidates: Array<{
      readonly revision: number;
      readonly key: string;
    }> = [];
    for (const entry of pointers) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const pointer = parseGenerationPointer(
        JSON.parse(
          await readFile(
            path.join(this.paths.missionCurrent, entry.name),
            "utf8",
          ),
        ),
      );
      const generation = await this.readGenerationOwned(pointer.missionId);
      const key = generation?.bindingKeys.find((value) =>
        value.startsWith(`${sessionKey}/`),
      );
      if (!key) continue;
      const revisionText = /\/(\d+)\.json$/.exec(key)?.[1];
      if (revisionText)
        candidates.push({ revision: Number(revisionText), key });
    }
    const latest = candidates.sort(
      (left, right) => right.revision - left.revision,
    )[0];
    if (!latest) return undefined;
    const binding = parseSessionBinding(
      JSON.parse(
        await readFile(
          path.join(this.paths.sessionBindings, latest.key),
          "utf8",
        ),
      ),
    );
    if (
      binding.sessionId !== sessionId ||
      latest.key !==
        `${storageKey("session", binding.sessionId)}/${binding.revision}.json`
    )
      throw new MissionContractError("STORAGE_KEY_MISMATCH", latest.key);
    return binding;
  }

  async bindExecution(
    value: MissionExecutionBinding | unknown,
    idempotencyKey: string,
  ): Promise<MissionExecutionBinding> {
    const binding = parseExecutionBinding(value);
    await this.transact({
      missionId: binding.missionId,
      itemId: binding.itemId,
      kind: "execution-bind",
      idempotencyKey,
      value: binding,
      mutate: async (generation) => {
        await this.assertAssociation(
          generation,
          binding.itemId,
          binding.sessionId,
          binding.parentContextToken,
        );
        let prior: MissionExecutionBinding | undefined;
        if (generation) {
          for (const key of generation.executionLinkKeys) {
            const existing = await this.readExecutionKey(
              binding.missionId,
              key,
            );
            if (existing.bindingId === binding.bindingId) prior = existing;
            if (
              existing.bindingId !== binding.bindingId &&
              existing.canonicalIdentity === binding.canonicalIdentity
            )
              throw new MissionContractError(
                "DUPLICATE_EXTERNAL_IDENTITY",
                binding.canonicalIdentity,
              );
            if (
              existing.bindingId !== binding.bindingId &&
              existing.sessionId === binding.sessionId &&
              existing.toolCallId === binding.toolCallId
            )
              throw new MissionContractError(
                "DUPLICATE_TOOL_CALL",
                binding.toolCallId,
              );
          }
        }
        this.assertExecutionRevision(prior, binding);
        if (binding.childContextToken) {
          const legacy = new MissionStore(this.paths.root);
          const child = await runMission(
            legacy.getContext(binding.childContextToken),
          );
          if (
            !child ||
            child.missionId !== binding.missionId ||
            child.parentSessionId !== binding.sessionId ||
            child.parentContextToken !== binding.parentContextToken
          ) {
            throw new MissionContractError(
              "INVALID_CHILD_ANCESTRY",
              binding.childContextToken,
            );
          }
        }
        return { execution: binding, contextToken: binding.parentContextToken };
      },
    });
    return binding;
  }

  private assertExecutionRevision(
    prior: MissionExecutionBinding | undefined,
    next: MissionExecutionBinding,
  ): void {
    if (!prior) {
      if (next.revision !== 0 || next.state !== "intent")
        throw new MissionContractError(
          "INVALID_EXECUTION_REVISION",
          "new execution must start at intent revision 0",
        );
      return;
    }
    const immutable = [
      "missionId",
      "itemId",
      "sessionId",
      "parentContextToken",
      "toolCallId",
      "canonicalIdentity",
      "createdAt",
    ] as const;
    for (const field of immutable) {
      if (prior[field] !== next[field])
        throw new MissionContractError(
          "EXECUTION_IDENTITY_CHANGED",
          `${next.bindingId}.${field}`,
        );
    }
    if (stringify(prior.externalRef) !== stringify(next.externalRef))
      throw new MissionContractError(
        "EXECUTION_IDENTITY_CHANGED",
        `${next.bindingId}.externalRef`,
      );
    if (next.revision !== prior.revision + 1)
      throw new MissionContractError(
        "STALE_EXECUTION_REVISION",
        next.bindingId,
      );
    const terminal = new Set(["completed", "failed", "cancelled"]);
    const allowed =
      prior.state === "intent"
        ? next.state === "bound"
        : prior.state === "bound"
          ? terminal.has(next.state)
          : false;
    if (!allowed)
      throw new MissionContractError(
        terminal.has(prior.state)
          ? "TERMINAL_EXECUTION_REGRESSION"
          : "INVALID_EXECUTION_TRANSITION",
        `${prior.state} -> ${next.state}`,
      );
    if (
      prior.childContextToken &&
      next.childContextToken !== prior.childContextToken
    )
      throw new MissionContractError(
        "EXECUTION_IDENTITY_CHANGED",
        `${next.bindingId}.childContextToken`,
      );
  }

  async linkEvidence(
    value: MissionEvidenceLink | unknown,
    idempotencyKey: string,
  ): Promise<MissionEvidenceLink> {
    return this.linkEvidenceInternal(value, idempotencyKey, false);
  }

  /** Caller must hold missionLockPath(link.missionId). */
  async linkEvidenceOwned(
    value: MissionEvidenceLink | unknown,
    idempotencyKey: string,
    operation?: {
      readonly kind: "evidence-link" | "evidence-record-link";
      readonly value: unknown;
    },
  ): Promise<MissionEvidenceLink> {
    return this.linkEvidenceInternal(value, idempotencyKey, true, operation);
  }

  private async linkEvidenceInternal(
    value: MissionEvidenceLink | unknown,
    idempotencyKey: string,
    owned: boolean,
    operation?: {
      readonly kind: "evidence-link" | "evidence-record-link";
      readonly value: unknown;
    },
  ): Promise<MissionEvidenceLink> {
    const link = parseEvidenceLink(value);
    const request: OperationRequest = {
      missionId: link.missionId,
      itemId: link.itemId,
      kind: operation?.kind ?? "evidence-link",
      idempotencyKey,
      value: operation?.value ?? link,
      mutate: async (generation) => {
        await this.assertAssociation(generation, link.itemId, link.sessionId);
        const legacy = new MissionStore(this.paths.root);
        const receipt = await runMission(legacy.getReceipt(link.eventId));
        if (!receipt)
          throw new MissionContractError("MISSING_RECEIPT", link.eventId);
        const context = await runMission(
          legacy.getContext(receipt.contextToken),
        );
        if (!context || context.missionId !== link.missionId)
          throw new MissionContractError(
            "CONTEXT_MISSION_MISMATCH",
            link.eventId,
          );
        if (context.parentSessionId !== link.sessionId)
          throw new MissionContractError(
            "CONTEXT_SESSION_MISMATCH",
            link.eventId,
          );
        if (
          receipt.producer.sessionId &&
          receipt.producer.sessionId !== link.sessionId
        )
          throw new MissionContractError(
            "CONTEXT_SESSION_MISMATCH",
            link.eventId,
          );
        await this.validateChangeStats(link, receipt);
        if (link.stateEffect.kind !== "none")
          throw new MissionContractError(
            "UNAUTHORIZED_STATE_EFFECT",
            link.linkId,
          );
        if (generation) {
          for (const key of generation.evidenceLinkKeys) {
            const existing = await this.readEvidenceKey(link.missionId, key);
            if (
              existing.missionId === link.missionId &&
              existing.itemId === link.itemId &&
              existing.eventId === link.eventId
            ) {
              if (stringify(existing) === stringify(link))
                return {
                  evidence: existing,
                  eventId: existing.eventId,
                  contextToken: receipt.contextToken,
                };
              throw new MissionContractError(
                "EVIDENCE_LINK_CONFLICT",
                link.eventId,
              );
            }
          }
        }
        return {
          evidence: link,
          eventId: link.eventId,
          contextToken: receipt.contextToken,
        };
      },
    };
    if (owned) {
      await this.initialize();
      await this.transactUnlocked(request);
    } else {
      await this.transact(request);
    }
    return link;
  }

  private async validateChangeStats(
    link: MissionEvidenceLink,
    receipt: import("./types.ts").EvidenceReceipt,
  ): Promise<void> {
    for (const stat of link.changeStats) {
      const artifact = receipt.artifacts.find(
        (candidate) => candidate.artifactId === stat.provenance.artifactId,
      );
      if (!artifact || artifact.sha256 !== stat.provenance.sha256)
        throw new MissionContractError(
          "CHANGE_PROVENANCE_MISMATCH",
          stat.provenance.artifactId,
        );
      if (stat.provenance.parser !== "unified-diff/v1") continue;
      if (artifact.role !== "diff" && artifact.role !== "patch")
        throw new MissionContractError(
          "CHANGE_PARSER_MISMATCH",
          artifact.artifactId,
        );
      if (artifact.size > 8 * 1024 * 1024)
        throw new MissionContractError(
          "CHANGE_ARTIFACT_TOO_LARGE",
          artifact.artifactId,
        );
      const bytes = await readFile(artifact.path);
      if (
        bytes.byteLength !== artifact.size ||
        sha256(bytes) !== artifact.sha256
      )
        throw new MissionContractError(
          "IMMUTABLE_HASH_MISMATCH",
          artifact.artifactId,
        );
      const parsed = parseUnifiedDiffStats(bytes.toString("utf8"));
      if (
        parsed.additions !== stat.additions ||
        parsed.deletions !== stat.deletions
      )
        throw new MissionContractError(
          "CHANGE_STATS_MISMATCH",
          artifact.artifactId,
        );
    }
  }

  async indexContext(
    missionId: string,
    contextToken: string,
    idempotencyKey: string,
  ): Promise<MissionGeneration> {
    const legacy = new MissionStore(this.paths.root);
    const context = await runMission(legacy.getContext(contextToken));
    if (!context || context.missionId !== missionId) {
      throw new MissionContractError("CONTEXT_MISSION_MISMATCH", contextToken);
    }
    return this.transact({
      missionId,
      kind: "migration-index",
      idempotencyKey,
      value: { missionId, contextToken },
      mutate: async () => ({ contextToken }),
    });
  }

  async readCurrentGeneration(
    missionId: string,
  ): Promise<MissionGeneration | undefined> {
    await this.initialize();
    return withOwnedLocks([this.missionLock(missionId)], () =>
      this.readGenerationOwned(missionId),
    );
  }

  private async transact(
    request: OperationRequest,
  ): Promise<MissionGeneration> {
    await this.initialize();
    return withOwnedLocks([this.missionLock(request.missionId)], () =>
      this.transactUnlocked(request),
    );
  }

  private async transactUnlocked(
    request: OperationRequest,
  ): Promise<MissionGeneration> {
    const requestDigest = normalizedRequestDigest(asJsonValue(request.value));
    const operationId = this.operations.operationId(
      request.missionId,
      request.idempotencyKey,
    );
    const existing = await this.operations.getById(
      request.missionId,
      operationId,
    );
    const current = await this.readGenerationOwned(request.missionId);
    if (existing) {
      this.operations.assertCompatible(existing, request.kind, requestDigest);
      if (current?.committedOperationIds.includes(operationId)) {
        if (request.mirrorMissionId && request.bindingSessionId) {
          const binding = (await this.readBindings(current)).find(
            (candidate) => candidate.sessionId === request.bindingSessionId,
          );
          if (!binding) {
            throw new MissionContractError(
              "CORRUPT_COMMITTED_OPERATION",
              operationId,
            );
          }
          const mirror = await this.readGenerationOwned(
            request.mirrorMissionId,
          );
          if (!mirror?.committedOperationIds.includes(operationId)) {
            await this.publishMirrorGeneration(
              request.mirrorMissionId,
              binding,
              operationId,
            );
          }
        }
        if (existing.state !== "committed") {
          await this.operations.put({
            ...existing,
            state: "committed",
            publications: unique([
              ...existing.publications,
              "generation",
              ...(request.bindingSessionId
                ? (["binding-history"] as const)
                : []),
            ]),
            resultRef: String(current.generation),
            updatedAt: new Date().toISOString(),
          });
        }
        return current;
      }
      if (existing.state === "committed")
        throw new MissionContractError(
          "CORRUPT_COMMITTED_OPERATION",
          operationId,
        );
    }
    const now = new Date().toISOString();
    const intent: MissionOperation = existing ?? {
      schema: "pi.mission-operation/v1",
      operationId,
      missionId: request.missionId,
      ...defined("itemId", request.itemId),
      idempotencyKey: request.idempotencyKey,
      kind: request.kind,
      requestDigest,
      state: "intent",
      publications: [],
      ...defined(
        "resultRef",
        request.mirrorMissionId
          ? `mirror:${request.mirrorMissionId}`
          : undefined,
      ),
      createdAt: now,
      updatedAt: now,
    };
    // Domain/CAS validation must not create recoverable work for a rejected command.
    const patch = await request.mutate(current, intent);
    await this.operations.put(intent);
    try {
      const generation = await this.publishGeneration(
        request.missionId,
        current,
        patch,
        operationId,
        intent.createdAt,
      );
      if (request.mirrorMissionId && patch.binding) {
        await this.publishMirrorGeneration(
          request.mirrorMissionId,
          patch.binding,
          operationId,
        );
      }
      // History is a consequence of the generation commit, never a source of
      // truth visible before the pointer.
      if (patch.bindingHistory) {
        await this.publishBindingHistory(patch.bindingHistory);
      }
      await this.operations.put({
        ...intent,
        state: "committed",
        publications: unique([
          ...intent.publications,
          "generation",
          ...(patch.bindingHistory ? ["binding-history" as const] : []),
        ]),
        resultRef: String(generation.generation),
        updatedAt: new Date().toISOString(),
      });
      return generation;
    } catch (error) {
      await this.operations.put({
        ...intent,
        state: "retryable",
        errorCode: "PUBLICATION_FAILED",
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  private async publishGeneration(
    missionId: string,
    current: MissionGeneration | undefined,
    patch: GenerationPatch,
    operationId: string,
    publishedAt: string,
  ): Promise<MissionGeneration> {
    const missionKey = storageKey("mission", missionId);
    let planKey = current?.planKey;
    let planRevision = current?.planRevision ?? null;
    const sessionKeys = [...(current?.sessionKeys ?? [])];
    const bindingKeys = [...(current?.bindingKeys ?? [])];
    const executionLinkKeys = [...(current?.executionLinkKeys ?? [])];
    const evidenceLinkKeys = [...(current?.evidenceLinkKeys ?? [])];
    if (patch.plan) {
      planKey = `${missionKey}/${patch.plan.revision}.json`;
      await writeImmutable(
        path.join(this.paths.plans, planKey),
        stringify(patch.plan),
      );
      planRevision = patch.plan.revision;
    }
    if (patch.session) {
      const key = `${storageKey("session", patch.session.sessionId)}/${patch.session.revision}.json`;
      await writeImmutable(
        path.join(this.paths.missionSessions, missionKey, key),
        stringify(patch.session),
      );
      replacePrefixed(
        sessionKeys,
        storageKey("session", patch.session.sessionId),
        key,
      );
    }
    if (patch.binding) {
      const sessionKey = storageKey("session", patch.binding.sessionId);
      const key = `${sessionKey}/${patch.binding.revision}.json`;
      await writeImmutable(
        path.join(this.paths.sessionBindings, key),
        stringify(patch.binding),
      );
      replacePrefixed(bindingKeys, sessionKey, key);
    }
    if (patch.execution) {
      const bindingKey = storageKey(
        "execution-binding",
        patch.execution.bindingId,
      );
      const key = `${bindingKey}/${patch.execution.revision}.json`;
      await writeImmutable(
        path.join(this.paths.missionLinks, missionKey, "execution", key),
        stringify(patch.execution),
      );
      replacePrefixed(executionLinkKeys, bindingKey, key);
    }
    if (patch.evidence) {
      const key = `${storageKey("evidence-link", patch.evidence.linkId)}.json`;
      await writeImmutable(
        path.join(this.paths.missionLinks, missionKey, "evidence", key),
        stringify(patch.evidence),
      );
      const tuple = `${patch.evidence.itemId}\0${patch.evidence.eventId}`;
      for (const existingKey of evidenceLinkKeys) {
        const existing = await this.readEvidenceKey(missionId, existingKey);
        if (
          `${existing.itemId}\0${existing.eventId}` === tuple &&
          existing.linkId !== patch.evidence.linkId
        )
          throw new MissionContractError(
            "EVIDENCE_LINK_CONFLICT",
            patch.evidence.eventId,
          );
      }
      if (!evidenceLinkKeys.includes(key)) evidenceLinkKeys.push(key);
    }
    const contextTokens = unique([
      ...(current?.contextTokens ?? []),
      ...(patch.contextToken ? [patch.contextToken] : []),
    ]).sort();
    const legacy = new MissionStore(this.paths.root);
    const contextHashes = await Promise.all(
      contextTokens.map(async (token) => {
        const context = await runMission(legacy.getContext(token));
        if (!context || context.missionId !== missionId)
          throw new MissionContractError("CONTEXT_MISSION_MISMATCH", token);
        return { token, sha256: sha256(stringify(context)) };
      }),
    );
    const generation: MissionGeneration = {
      schema: "pi.mission-generation/v1",
      missionId,
      generation: (current?.generation ?? -1) + 1,
      previousGeneration: current?.generation ?? null,
      planRevision,
      ...defined("planKey", planKey),
      sessionKeys: sessionKeys.sort(),
      bindingKeys: bindingKeys.sort(),
      executionLinkKeys: executionLinkKeys.sort(),
      evidenceLinkKeys: evidenceLinkKeys.sort(),
      contextTokens,
      contextHashes,
      eventIds: unique([
        ...(current?.eventIds ?? []),
        ...(patch.eventId ? [patch.eventId] : []),
      ]).sort(),
      committedOperationIds: unique([
        ...(current?.committedOperationIds ?? []),
        operationId,
      ]).sort(),
      publishedAt,
    };
    const bytes = stringify(generation);
    const generationPath = path.join(
      this.paths.missionGenerations,
      missionKey,
      `${generation.generation}.json`,
    );
    await writeImmutable(generationPath, bytes);
    const pointer: MissionGenerationPointer = {
      schema: "pi.mission-generation-pointer/v1",
      missionId,
      generation: generation.generation,
      generationSha256: sha256(bytes),
    };
    await writeAtomic(
      path.join(this.paths.missionCurrent, `${missionKey}.json`),
      stringify(pointer),
    );
    return generation;
  }

  private async publishBindingHistory(
    history: MissionSessionBindingHistoryEntry,
  ): Promise<void> {
    const key = storageKey("session", history.sessionId);
    await writeImmutable(
      path.join(this.paths.bindingHistory, key, `${history.revision}.json`),
      stringify(history),
    );
  }

  private async publishMirrorGeneration(
    missionId: string,
    binding: MissionSessionBinding,
    operationId: string,
  ): Promise<void> {
    const current = await this.readGenerationOwned(missionId);
    await this.publishGeneration(
      missionId,
      current,
      { binding },
      operationId,
      binding.changedAt,
    );
  }

  private async assertAssociation(
    generation: MissionGeneration | undefined,
    itemId: string,
    sessionId: string,
    contextToken?: string,
  ): Promise<void> {
    if (!generation)
      throw new MissionContractError("MISSION_NOT_FOUND", "no generation");
    const plan = await this.readPlanFromGeneration(generation);
    if (!plan?.items.some((item) => item.itemId === itemId))
      throw new MissionContractError("UNKNOWN_ITEM", itemId);
    if (!(await this.findSession(generation, sessionId)))
      throw new MissionContractError("SESSION_NOT_MEMBER", sessionId);
    const binding = await this.getBinding(sessionId);
    if (
      !binding ||
      binding.state !== "bound" ||
      binding.missionId !== generation.missionId ||
      binding.itemId !== itemId
    )
      throw new MissionContractError("BINDING_MISMATCH", sessionId);
    if (contextToken) {
      if (!generation.contextTokens.includes(contextToken))
        throw new MissionContractError("CONTEXT_NOT_INDEXED", contextToken);
      const context = await runMission(
        new MissionStore(this.paths.root).getContext(contextToken),
      );
      if (
        !context ||
        context.missionId !== generation.missionId ||
        context.parentSessionId !== sessionId
      )
        throw new MissionContractError(
          "CONTEXT_ASSOCIATION_MISMATCH",
          contextToken,
        );
    }
  }

  async readPlanFromGeneration(
    generation: MissionGeneration,
  ): Promise<MissionPlan | undefined> {
    if (!generation.planKey) return undefined;
    const plan = parseMissionPlan(
      JSON.parse(
        await readFile(path.join(this.paths.plans, generation.planKey), "utf8"),
      ),
    );
    const expected = `${storageKey("mission", plan.missionId)}/${plan.revision}.json`;
    if (
      plan.missionId !== generation.missionId ||
      plan.revision !== generation.planRevision ||
      generation.planKey !== expected
    )
      throw new MissionContractError(
        "STORAGE_KEY_MISMATCH",
        generation.planKey,
      );
    return plan;
  }

  async readSessions(
    generation: MissionGeneration,
  ): Promise<readonly MissionSessionAttribution[]> {
    const missionKey = storageKey("mission", generation.missionId);
    return Promise.all(
      generation.sessionKeys.map(async (key) => {
        const session = parseSessionAttribution(
          JSON.parse(
            await readFile(
              path.join(this.paths.missionSessions, missionKey, key),
              "utf8",
            ),
          ),
        );
        if (
          session.missionId !== generation.missionId ||
          key !==
            `${storageKey("session", session.sessionId)}/${session.revision}.json`
        )
          throw new MissionContractError("STORAGE_KEY_MISMATCH", key);
        return session;
      }),
    );
  }

  async readBindings(
    generation: MissionGeneration,
  ): Promise<readonly MissionSessionBinding[]> {
    return Promise.all(
      generation.bindingKeys.map(async (key) => {
        const binding = parseSessionBinding(
          JSON.parse(
            await readFile(path.join(this.paths.sessionBindings, key), "utf8"),
          ),
        );
        if (
          key !==
          `${storageKey("session", binding.sessionId)}/${binding.revision}.json`
        )
          throw new MissionContractError("STORAGE_KEY_MISMATCH", key);
        return binding;
      }),
    );
  }

  async readExecutions(
    generation: MissionGeneration,
  ): Promise<readonly MissionExecutionBinding[]> {
    return Promise.all(
      generation.executionLinkKeys.map((key) =>
        this.readExecutionKey(generation.missionId, key),
      ),
    );
  }

  async readEvidenceLinks(
    generation: MissionGeneration,
  ): Promise<readonly MissionEvidenceLink[]> {
    return Promise.all(
      generation.evidenceLinkKeys.map((key) =>
        this.readEvidenceKey(generation.missionId, key),
      ),
    );
  }

  private async findSession(
    generation: MissionGeneration,
    sessionId: string,
  ): Promise<MissionSessionAttribution | undefined> {
    const sessions = await this.readSessions(generation);
    return sessions.find((session) => session.sessionId === sessionId);
  }

  private async readExecutionKey(
    missionId: string,
    key: string,
  ): Promise<MissionExecutionBinding> {
    const binding = parseExecutionBinding(
      JSON.parse(
        await readFile(
          path.join(
            this.paths.missionLinks,
            storageKey("mission", missionId),
            "execution",
            key,
          ),
          "utf8",
        ),
      ),
    );
    if (
      binding.missionId !== missionId ||
      key !==
        `${storageKey("execution-binding", binding.bindingId)}/${binding.revision}.json`
    )
      throw new MissionContractError("STORAGE_KEY_MISMATCH", key);
    return binding;
  }

  private async readEvidenceKey(
    missionId: string,
    key: string,
  ): Promise<MissionEvidenceLink> {
    const link = parseEvidenceLink(
      JSON.parse(
        await readFile(
          path.join(
            this.paths.missionLinks,
            storageKey("mission", missionId),
            "evidence",
            key,
          ),
          "utf8",
        ),
      ),
    );
    if (
      link.missionId !== missionId ||
      key !== `${storageKey("evidence-link", link.linkId)}.json`
    )
      throw new MissionContractError("STORAGE_KEY_MISMATCH", key);
    return link;
  }

  /** Caller must hold missionLockPath(missionId). */
  async readGenerationOwned(
    missionId: string,
  ): Promise<MissionGeneration | undefined> {
    const missionKey = storageKey("mission", missionId);
    let pointer: MissionGenerationPointer;
    try {
      pointer = parseGenerationPointer(
        JSON.parse(
          await readFile(
            path.join(this.paths.missionCurrent, `${missionKey}.json`),
            "utf8",
          ),
        ),
      );
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    if (pointer.missionId !== missionId)
      throw new MissionContractError("STORAGE_KEY_MISMATCH", missionId);
    const bytes = await readFile(
      path.join(
        this.paths.missionGenerations,
        missionKey,
        `${pointer.generation}.json`,
      ),
      "utf8",
    );
    if (sha256(bytes) !== pointer.generationSha256)
      throw new MissionContractError("GENERATION_HASH_MISMATCH", missionId);
    const generation = parseMissionGeneration(JSON.parse(bytes));
    if (
      generation.missionId !== missionId ||
      generation.generation !== pointer.generation
    )
      throw new MissionContractError("GENERATION_POINTER_MISMATCH", missionId);
    return generation;
  }

  missionLockPath(missionId: string): string {
    return path.join(
      this.paths.locks,
      `mission.${storageKey("mission", missionId)}.lock`,
    );
  }

  private missionLock(missionId: string): string {
    return this.missionLockPath(missionId);
  }
}

async function writeImmutable(
  destination: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    const handle = await open(destination, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const directory = await open(path.dirname(destination), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!isExists(error)) throw error;
    if ((await readFile(destination, "utf8")) !== content)
      throw new MissionContractError("IMMUTABLE_CONFLICT", destination);
  }
}

async function writeAtomic(
  destination: string,
  content: string,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await rename(temporary, destination);
    const directory = await open(path.dirname(destination), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

function replacePrefixed(
  values: string[],
  prefix: string,
  value: string,
): void {
  const index = values.findIndex((entry) => entry.startsWith(`${prefix}/`));
  if (index === -1) values.push(value);
  else values[index] = value;
}
function unique<Value>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}
function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
function parseUnifiedDiffStats(value: string): {
  readonly additions: number;
  readonly deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const line of value.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
function stringify(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
function defined<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { [P in Key]?: Value } {
  return value === undefined ? {} : ({ [key]: value } as { [P in Key]: Value });
}
