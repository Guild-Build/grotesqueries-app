// Reused from Grotesqueries' reviewed packaging helper at 792e0ee2641525c61e496f863b634976e8f0b419.
export function seaConfig(main, output, assets) {
  return { main, output, assets, disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false, execArgvExtension: 'none' };
}
