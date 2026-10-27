/** HTTP settings projection. Never includes environment overrides or the bootstrap credential. */
export interface EditableSettings {
  port: number;
  scrollbackLines: number;
  recentOutputBytes: number;
  maxRunningSessions: number;
  maxViews: number;
  profiles: Array<{ id: string; label: string; executable: string; args: string[]; projectDirectory: string; columns: number | null }>;
}
export interface SettingsDocument {
  revision: string;
  file: string;
  listeningPort: number;
  restartRequired: boolean;
  allowedProjectDirectories: string[];
  settings: EditableSettings;
}
