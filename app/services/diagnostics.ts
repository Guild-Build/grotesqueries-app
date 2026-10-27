import { DiagnosticLogger as LocalDiagnosticLogger } from '../../lib/local-web/diagnostics.js';

export class DiagnosticLogger extends LocalDiagnosticLogger {
  constructor(root: string, settings: { directory: string; maxFiles: number; maxFileBytes: number }) {
    super(root, settings, ['hostInstanceId', 'sessionId', 'viewId', 'profileId', 'plugin']);
  }
}
