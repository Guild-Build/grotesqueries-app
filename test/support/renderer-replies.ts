// Test-support copy of the frame's renderer reply suppression: the Automata repository's automata/frame/src/terminal/replies.ts, itself
// Grotesqueries 91c3215:app/javascript/terminal/replies.ts. The host's suite runs with no frame tree present (ledger 2(b));
// the copy goes when the protocol package carries reply suppression (deferred row, owner Popola, next iteration).
import { TERMINAL_QUERY_CATALOG } from '@grotesqueries/protocol';
import { pinnedCore, type ParserTerminal } from '@grotesqueries/protocol';

/** Consume queries at the parser, never by guessing the origin of onData text. */
export function installRendererReplySuppression(terminal: ParserTerminal): () => void {
  const hooks = [
    ...TERMINAL_QUERY_CATALOG.csi.map(id => terminal.parser.registerCsiHandler(id, () => true)),
    ...TERMINAL_QUERY_CATALOG.dcs.map(id => terminal.parser.registerDcsHandler(id, () => true)),
    terminal.parser.registerCsiHandler({ final: 't' }, params => TERMINAL_QUERY_CATALOG.windowReports.includes(params[0] as 14 | 16 | 18)),
    terminal.parser.registerOscHandler(4, data => {
      const pairs = data.split(';'); if (!pairs.includes('?')) return false;
      const sets: string[] = [];
      for (let i = 0; i + 1 < pairs.length; i += 2) if (pairs[i + 1] !== '?') sets.push(pairs[i], pairs[i + 1]);
      if (sets.length) pinnedCore(terminal)._inputHandler.setOrReportIndexedColor(sets.join(';'));
      return true;
    }),
    ...[10, 11, 12].map(id => terminal.parser.registerOscHandler(id, data => {
      const parts = data.split(';'); if (!parts.includes('?')) return false;
      const handler = pinnedCore(terminal)._inputHandler;
      const setters = ['setOrReportFgColor', 'setOrReportBgColor', 'setOrReportCursorColor'];
      parts.forEach((part, offset) => { if (part !== '?' && id + offset <= 12) handler[setters[id + offset - 10]](part); });
      return true;
    })),
  ];
  return () => hooks.forEach(hook => hook.dispose());
}
