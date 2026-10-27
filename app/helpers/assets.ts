import { diskAssets as disk, embeddedAssets as embedded, type AssetRoutes } from '../../lib/local-web/assets.js';
export type { AssetSource } from '../../lib/local-web/assets.js';

// The host's own three files. The page and its assets are the frame's, served from the configured folder (requirement 4.2.2).
const routes: AssetRoutes = {
  '/licenses': { file: 'licenses.txt', contentType: 'text/plain; charset=utf-8' },
  '/grotesqueries.schema.json': { file: 'grotesqueries.schema.json', contentType: 'application/schema+json; charset=utf-8' },
  '/version.json': { file: 'version.json', contentType: 'application/json; charset=utf-8' },
};

// The frame's four files as the EXE embeds them (requirement 4.2.2), with the content types `folderFile` gives them.
export const frameRoutes: AssetRoutes = {
  '/': { file: 'frame/index.html', contentType: 'text/html; charset=utf-8' },
  '/assets/app.js': { file: 'frame/assets/app.js', contentType: 'text/javascript; charset=utf-8' },
  '/assets/app.css': { file: 'frame/assets/app.css', contentType: 'text/css; charset=utf-8' },
  '/assets/licenses.txt': { file: 'frame/assets/licenses.txt', contentType: 'text/plain; charset=utf-8' },
};

export const diskAssets = (root: string) => disk(root, routes);
/** The EXE's table. The table answers before the frame folder, so a configured `frame` folder leaves the embedded frame out. */
export const embeddedAssets = (files: Record<string, Uint8Array>, frameFolder?: string) =>
  embedded(files, frameFolder ? routes : { ...routes, ...frameRoutes });
