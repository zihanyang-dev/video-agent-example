const apps = ['server', 'agent']

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
      name: 'http-no-execution-contract',
      severity: 'error',
      from: {
        path: '^packages/contract/src/http(?:\\.test)?\\.ts$',
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
    exclude: '(^|/)(dist|coverage)/',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'default'],
    },
  },
}
