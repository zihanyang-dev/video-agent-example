const apps = ['web', 'server', 'agent']

module.exports = {
  forbidden: [
    ...apps.map((app) => ({
      name: `no-cross-app-${app}`,
      severity: 'error',
      from: { path: `^apps/${app}/` },
      to: { path: `^apps/(?!${app}/)` },
    })),
    {
      name: 'shared-not-app',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-cycles',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'web-no-private-packages',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: {
        path: '^packages/((config|database|object-storage)/|contract/(src/execution(?:\\.ts$|/)|generated/execution-))',
      },
    },
    {
      name: 'http-no-execution-contract',
      severity: 'error',
      from: {
        path: '^packages/contract/(src/http(?:\\.test)?\\.ts$|generated/client/)',
      },
      to: { path: '^packages/contract/src/execution(?:\\.ts$|/)' },
    },
    {
      name: 'no-unresolved',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // TypeScript 7 has no legacy compiler API; SWC retains type-only imports.
    parser: 'swc',
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    exclude: '(^|/)(dist|coverage|vendor)/',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'default'],
    },
  },
}
