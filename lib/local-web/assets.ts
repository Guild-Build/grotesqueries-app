import fs from 'node:fs';
import path from 'node:path';
import { assertManagedPath } from './runtime.js';

export type AssetRoutes = Readonly<Record<string, { file: string; contentType: string }>>;
export interface AssetSource {
  get(route: string): { data: Uint8Array; contentType: string } | undefined;
}
export function diskAssets(root: string, routes: AssetRoutes, directory = 'public'): AssetSource {
  return { get(route) {
    const asset = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (!asset) return;
    return { data: fs.readFileSync(assertManagedPath(root, path.join(root, directory, asset.file))),
      contentType: asset.contentType };
  } };
}
export function embeddedAssets(files: Record<string, Uint8Array>, routes: AssetRoutes): AssetSource {
  return { get(route) {
    const asset = Object.hasOwn(routes, route) ? routes[route] : undefined;
    if (!asset || !Object.hasOwn(files, asset.file)) return;
    return { data: files[asset.file], contentType: asset.contentType };
  } };
}
