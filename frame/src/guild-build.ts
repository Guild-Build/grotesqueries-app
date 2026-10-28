import type { GuildBuildSummary } from '@grotesqueries/protocol';

/** Render only text and fixed-origin links; a preset never supplies HTML or URLs. */
export function renderGuildBuild(container: HTMLElement, build: GuildBuildSummary | null, notice = ''): void {
  const document = container.ownerDocument;
  const node = (tag: string, text: string) => { const item = document.createElement(tag); item.textContent = text; return item; };
  const link = (label: string, url: string) => {
    const item = document.createElement('a'); item.textContent = label; item.href = url;
    item.target = '_blank'; item.rel = 'noopener noreferrer'; return item;
  };
  const content = document.createElement('div'); content.className = 'guild-build-panel';
  content.append(node('h2', 'BuildGuild'));
  if (build) {
    content.append(node('h3', `${build.name} v${build.version}`), node('p', 'Included for Claude Code in this download.'));
    if (build.profileId) {
      content.append(node('p', `Choose “${build.name} · Claude Code” in Start. Start creates a session; Take control enables input.`),
        node('p', 'The profile uses its own app-local workspace. Provider login and charges are yours.'));
    } else content.append(node('p', 'Setup required before the build profile is available.'));
    const prerequisites = document.createElement('ul'); prerequisites.className = 'guild-build-prerequisites';
    for (const requirement of build.prerequisites) prerequisites.append(node('li', requirement));
    if (build.prerequisites.length) content.append(prerequisites);
    content.append(node('h3', 'Included components'));
    const modules = document.createElement('ul');
    for (const module of build.modules) {
      const item = document.createElement('li'); item.append(link(module, `https://buildguild.gg/modules/${module}/`)); modules.append(item);
    }
    content.append(modules, link('Build source and license', `https://github.com/Guild-Build/Build/tree/${build.catalogRevision}/bundles/${build.slug}`));
  } else content.append(node('p', notice || 'No Guild build is included in this installation.'));
  content.append(node('h3', 'More builds and tools'),
    node('p', 'Browse available builds, external tools and upcoming tools in the catalog. Linked tools are not installed by Grotesqueries.'),
    link('Browse the catalog', 'https://buildguild.gg/modules/'),
    link('Choose a build before downloading', 'https://buildguild.gg/downloads/#customize'));
  container.replaceChildren(content);
}
