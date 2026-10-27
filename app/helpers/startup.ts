import { reportStartupFailure as report } from '../../lib/local-web/startup.js';

export function reportStartupFailure(error: unknown, root: string,
  input?: Parameters<typeof report>[2], output?: Parameters<typeof report>[3]) {
  return report(error, root, input, output, 'grotesqueries-startup.log');
}
