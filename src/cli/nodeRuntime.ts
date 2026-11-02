import type { Logger } from '../util/logger.js';

import { satisfiesNodeRange } from '../util/nodeRange.js';
import { loadSupportedNodeRange } from '../util/packageMetadata.js';

export async function warnIfUnsupportedNode(
  logger: Logger,
  version: string,
): Promise<void> {
  let range: string;
  let supported: boolean;
  try {
    range = await loadSupportedNodeRange();
    supported = satisfiesNodeRange(version, range);
  } catch (error: unknown) {
    logger.debug('skipped the Node version check', error);
    return;
  }

  if (!supported) {
    logger.warn(
      `Node ${version} is not supported. agent-tty requires Node ${range}. Run \`agent-tty doctor\` to check the runtime.`,
    );
  }
}
