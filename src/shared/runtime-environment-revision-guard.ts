import type { KnownRuntimeEnvironment } from './runtime-environments'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

export function runtimeEnvironmentRevisionFailure(
  environment: Pick<KnownRuntimeEnvironment, 'runtimeId' | 'pairingRevision' | 'createdAt'>,
  expectedPairingRevision: number | undefined,
  method: string,
  expectedRuntimeId?: string
): RuntimeRpcResponse<never> | null {
  const pairingChanged =
    expectedPairingRevision !== undefined &&
    (environment.pairingRevision ?? environment.createdAt) !== expectedPairingRevision
  const runtimeChanged =
    expectedRuntimeId !== undefined && environment.runtimeId !== expectedRuntimeId
  if (!pairingChanged && !runtimeChanged) {
    return null
  }
  return runtimeEnvironmentChangedFailure(environment, method, pairingChanged)
}

export function runtimeEnvironmentChangedFailure(
  environment: Pick<KnownRuntimeEnvironment, 'runtimeId'>,
  method: string,
  pairingChanged = false
): RuntimeRpcResponse<never> {
  return {
    id: method,
    ok: false,
    error: {
      code: 'runtime_environment_changed',
      message: pairingChanged
        ? 'Runtime environment pairing changed; refresh and try again'
        : 'Runtime environment identity changed; refresh and try again'
    },
    _meta: { runtimeId: environment.runtimeId }
  }
}
