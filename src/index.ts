export type {
  CommandEnvelope,
  CommandError,
  CommandErrorEnvelope,
  CommandSuccessEnvelope,
} from './protocol/envelope.js';
export type {
  DestroyParams,
  DestroyResult,
  InspectParams,
  InspectResult,
  PasteParams,
  PasteResult,
  ResizeParams,
  ResizeResult,
  RpcError,
  RpcErrorResponse,
  RpcMethod,
  RpcRequest,
  RpcResponse,
  RpcSuccessResponse,
  SendKeysParams,
  SendKeysResult,
  SignalParams,
  SignalResult,
  TypeParams,
  TypeResult,
  WaitParams,
  WaitResult,
} from './protocol/messages.js';
export type {
  EventRecord,
  EventType,
  SessionRecord,
  SessionStatus,
} from './protocol/schemas.js';
export type { ProtocolErrorCode } from './protocol/errors.js';
export type { AgentTerminalConfig } from './config/resolveConfig.js';
