import process from 'node:process';

if (process.argv.includes('_host')) {
  const { register } = await import('tsx/esm/api');
  register();
  const { HostRendererManager } = await import('../../src/host/renderer.js');
  const { ERROR_CODES, makeCliError } =
    await import('../../src/protocol/errors.js');
  HostRendererManager.prototype.withBackend = () =>
    Promise.reject(
      makeCliError(ERROR_CODES.REPLAY_ERROR, {
        message: 'fixture: replay failed',
      }),
    );
}
