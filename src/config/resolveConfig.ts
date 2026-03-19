import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SHELL,
  EVENT_LOG_FILENAME,
  MANIFEST_FILENAME,
  SOCKET_FILENAME,
} from './defaults.js';
import { resolveHome } from '../storage/home.js';

export interface AgentTerminalConfig {
  readonly home: string;
  readonly cols: number;
  readonly rows: number;
  readonly shell: string;
  readonly socketFilename: string;
  readonly manifestFilename: string;
  readonly eventLogFilename: string;
}

export function resolveConfig(): Readonly<AgentTerminalConfig> {
  return Object.freeze({
    home: resolveHome(),
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    shell: DEFAULT_SHELL,
    socketFilename: SOCKET_FILENAME,
    manifestFilename: MANIFEST_FILENAME,
    eventLogFilename: EVENT_LOG_FILENAME,
  });
}
