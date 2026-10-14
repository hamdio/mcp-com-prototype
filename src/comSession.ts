// The only owner of the COM connection (plan.md S1-S7, E2-E5).
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { classifyComError, ComError, ToolError, type ErrorCode } from "./errors.ts";
import { safeEmit, type SessionState, type Telemetry } from "./telemetry.ts";

/** Seam over real COM. The Windows implementation (winax or a .NET helper) lives behind this. */
export interface ComClient {
  connect(): Promise<void>;
  /** Throws ComError for COM failures. */
  call(method: string, args: unknown[]): Promise<unknown>;
}

export interface SessionConfig {
  maxPending: number; // in-flight + queued calls; beyond this → app_busy (S3)
  deadlineMs: number; // per call: queue wait + execution + retries (S4)
  retryAttempts: number; // max total attempts for transient errors, read tools only (E3, E4)
  retryBaseMs: number; // backoff: base, 2×base, 4×base…
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  maxPending: 10,
  deadlineMs: 30_000,
  retryAttempts: 3,
  retryBaseMs: 200,
};

export interface CallResult {
  value: unknown;
  attempts: number;
  queueWaitMs: number;
  comMs: number;
  reconnected: boolean; // a retry followed a lost session, so an earlier attempt may have run (W6)
}

interface Progress {
  started: boolean;
  enqueuedAt: number;
  attempts: number;
  queueWaitMs: number;
  comMs: number;
  reconnected: boolean;
  hresult?: number;
}

function fail(code: ErrorCode, message: string, p: Progress): ToolError {
  const queueWaitMs = p.started ? p.queueWaitMs : Date.now() - p.enqueuedAt;
  return new ToolError(code, message, { hresult: p.hresult, attempts: p.attempts, queueWaitMs, comMs: p.comMs });
}

export class ComSession {
  readonly id = randomUUID();
  private state: SessionState = "disconnected";
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private readonly client: ComClient;
  private readonly telemetry: Telemetry;
  private readonly config: SessionConfig;

  constructor(client: ComClient, telemetry: Telemetry, config: SessionConfig = DEFAULT_SESSION_CONFIG) {
    this.client = client;
    this.telemetry = telemetry;
    this.config = config;
  }

  get currentState(): SessionState {
    return this.state;
  }

  /**
   * Queues a COM call. Calls run one at a time, first in, first out (S2).
   * `onSettled` fires exactly once, when the COM work has really finished (or straight away if the
   * call was never admitted). That can be after the caller got `timeout` (LIC14).
   */
  execute(method: string, args: unknown[], retryable: boolean, onSettled?: () => void): Promise<CallResult> {
    const p: Progress = {
      started: false,
      enqueuedAt: Date.now(),
      attempts: 0,
      queueWaitMs: 0,
      comMs: 0,
      reconnected: false,
    };
    if (this.pending >= this.config.maxPending) {
      onSettled?.();
      return Promise.reject(fail("app_busy", "Session queue is full", p));
    }
    this.pending++;
    const deadline = p.enqueuedAt + this.config.deadlineMs;
    const run = this.tail.then(() => this.runWithPolicy(method, args, retryable, deadline, p));
    // The queue only moves on when the COM call really ends, even if its caller already
    // got a timeout: the app's single thread is still busy until then.
    this.tail = run
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
        onSettled?.();
      });
    return withDeadline(run, deadline, p);
  }

  private async runWithPolicy(
    method: string,
    args: unknown[],
    retryable: boolean,
    deadline: number,
    p: Progress,
  ): Promise<CallResult> {
    p.started = true;
    p.queueWaitMs = Date.now() - p.enqueuedAt;
    let reconnected = false;
    for (;;) {
      // Never start COM work after the deadline, including work that waited in the queue.
      if (Date.now() >= deadline) throw fail("timeout", "Deadline passed before the call could run", p);
      await this.ensureConnected(p);
      p.attempts++;
      const callStart = Date.now();
      try {
        const value = await this.client.call(method, args);
        p.comMs += Date.now() - callStart;
        return { value, attempts: p.attempts, queueWaitMs: p.queueWaitMs, comMs: p.comMs, reconnected: p.reconnected };
      } catch (err) {
        p.comMs += Date.now() - callStart;
        if (!(err instanceof ComError)) throw fail("internal", "COM adapter threw a non-COM error", p);
        p.hresult = err.hresult;
        const kind = classifyComError(err.hresult);
        if (kind === "session_lost") {
          this.transition("faulted", `hresult 0x${err.hresult.toString(16)}`);
          if (!retryable || reconnected) throw fail("app_unavailable", "COM session lost", p);
          reconnected = true; // one reconnect + one retry (E5)
          p.reconnected = true;
          continue;
        }
        if (kind === "transient") {
          if (!retryable || p.attempts >= this.config.retryAttempts) throw fail("app_busy", "COM server busy", p);
          const delay = this.config.retryBaseMs * 2 ** (p.attempts - 1);
          if (Date.now() + delay >= deadline) throw fail("timeout", "No time left to retry", p);
          await sleep(delay);
          continue;
        }
        if (kind === "not_found") throw fail("not_found", "COM reported an unknown ID", p);
        throw fail("app_error", "COM call failed", p);
      }
    }
  }

  /** Lazy connect, and reconnect after a fault (S5). */
  private async ensureConnected(p: Progress): Promise<void> {
    if (this.state === "ready") return;
    this.transition(this.state === "disconnected" ? "connecting" : "reconnecting", "call needs a session");
    try {
      await this.client.connect();
    } catch {
      this.transition("faulted", "connect failed");
      throw fail("app_unavailable", "Cannot connect to the desktop app", p);
    }
    this.transition("ready", "connected");
  }

  private transition(to: SessionState, reason: string): void {
    const from = this.state;
    this.state = to;
    safeEmit(this.telemetry, { type: "session_state", sessionId: this.id, from, to, reason });
  }
}

function withDeadline<T>(work: Promise<T>, deadline: number, p: Progress): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(fail("timeout", "Deadline exceeded", p)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
