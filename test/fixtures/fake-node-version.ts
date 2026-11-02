// Preload (`--import`) that reports AGENT_TTY_TEST_NODE_VERSION as the Node
// version, so tests can run the CLI as if on an unsupported Node.
import process from 'node:process';

const version = process.env.AGENT_TTY_TEST_NODE_VERSION;
if (version !== undefined) {
  Object.defineProperty(process.versions, 'node', { value: version });
}
