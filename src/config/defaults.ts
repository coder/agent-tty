import process from 'node:process';

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_TERM = 'xterm-256color';
export const DEFAULT_SHELL = process.env.SHELL ?? '/bin/sh';
export { DEFAULT_LOG_LEVEL } from '../util/logger.js';
export const DEFAULT_IDLE_TIMEOUT_MS = 0 as const;
export const HOST_RENDERER_ENV_KEY = 'AGENT_TTY_HOST_RENDERER' as const;
// Set only in the copy that `destroy` runs in a new session. The host and the
// session's program never get it, so a destroy that the program runs still
// re-runs.
export const DESTROY_RERUN_ENV_KEY = 'AGENT_TTY_DESTROY_RERUN' as const;

export const SOCKET_FILENAME = 'host.sock';
export const MANIFEST_FILENAME = 'session.json';
export const EVENT_LOG_FILENAME = 'events.jsonl';
export const PROGRAM_RECORD_FILENAME = 'program.json';
export const HOST_RECORD_FILENAME = 'host.json';
export const DESTROY_MARKER_FILENAME = 'destroyed';
export const CREATE_FAILED_MARKER_FILENAME = 'create-failed';
