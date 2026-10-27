/** Audited against pinned xterm 5.5.0 InputHandler and browser Terminal. */
export const TERMINAL_QUERY_CATALOG = {
  csi: [{ final: 'c' }, { prefix: '>', final: 'c' }, { final: 'n' }, { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }],
  dcs: [{ intermediates: '$', final: 'q' }],
  color: [4, 10, 11, 12],
  windowReports: [14, 16, 18],
  disabledReports: ['clipboard', 'window-pixels', 'cell-pixels'],
} as const;
