import process from 'node:process';

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;
export const DEFAULT_TERM = 'xterm-256color';
export const DEFAULT_SHELL = process.env.SHELL ?? '/bin/sh';
export const DEFAULT_LOG_LEVEL = 'info' as const;
export const DEFAULT_IDLE_TIMEOUT_MS = 0 as const;

export const SOCKET_FILENAME = 'host.sock';
export const MANIFEST_FILENAME = 'session.json';
export const EVENT_LOG_FILENAME = 'events.jsonl';
