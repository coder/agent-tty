import process from 'node:process';

const version = process.env.AGENT_TTY_TEST_NODE_VERSION;
if (version !== undefined) {
  Object.defineProperty(process.versions, 'node', { value: version });
}
