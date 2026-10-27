import type { ITheme } from '@xterm/xterm';

/** Grotesqueries' active terminal palette. Attribution: THIRD_PARTY_NOTICES.md. */
export const TERMINAL_PALETTE = {
  background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff',
  cursorAccent: '#1e1e1e', selectionBackground: '#264f78', selectionForeground: '#ffffff',
  black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
  blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
  brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
  brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
  brightCyan: '#29b8db', brightWhite: '#ffffff',
} satisfies ITheme;
