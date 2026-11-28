import { RealtimeError } from '@iva-games/realtime-kit';
import type { RealtimeEngine } from './engine.js';

export type EngineMethod = 'health' | 'create' | 'status' | 'participant' | 'connect' | 'input' | 'heartbeat' | 'resync' | 'claim' | 'disconnect' | 'admissions' | 'action' | 'snapshot' | 'acknowledgeResult' | 'drain' | 'cancelDrain';
export interface RuntimeClient {
  call<M extends EngineMethod>(method: M, ...args: Parameters<RealtimeEngine[M]>): Promise<Awaited<ReturnType<RealtimeEngine[M]>>>;
}
export class LocalRuntimeClient implements RuntimeClient {
  constructor(readonly engine: RealtimeEngine) {}
  async call<M extends EngineMethod>(method: M, ...args: Parameters<RealtimeEngine[M]>): Promise<Awaited<ReturnType<RealtimeEngine[M]>>> {
    const invoke = this.engine[method] as (...values: Parameters<RealtimeEngine[M]>) => ReturnType<RealtimeEngine[M]>;
    return await invoke.apply(this.engine, args);
  }
}
export interface Failure { code: string; statusCode: number; details?: Record<string, string | number> }
export function failure(error: unknown): Failure {
  return error instanceof RealtimeError ? { code: error.code, statusCode: error.statusCode, ...(error.details ? { details: error.details } : {}) } : { code: 'INTERNAL_ERROR', statusCode: 500 };
}
