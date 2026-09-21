const applications = ['web', 'server', 'agent', 'gateway']

module.exports = {
  forbidden: [
    { name: 'no-cycles', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'packages-do-not-import-applications',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    ...applications.map((app) => ({
      name: `${app}-does-not-import-other-applications`,
      severity: 'error',
      from: { path: `^apps/${app}/` },
      to: { path: `^apps/(?!${app}/)` },
    })),
    {
      name: 'domain-has-no-outward-dependencies',
      severity: 'error',
      from: { path: '/domain/' },
      to: { pathNot: '/domain/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'domain-does-not-import-adapter-types',
      severity: 'error',
      from: { path: '/domain/' },
      to: { path: '(/application/|/infrastructure/|/presentation/|^packages/|node_modules)' },
    },
    {
      name: 'application-does-not-import-adapters',
      severity: 'error',
      from: { path: '/application/' },
      to: { path: '(/infrastructure/|/presentation/|/bootstrap\\.ts|^packages/|node_modules)' },
    },
    {
      name: 'presentation-does-not-import-infrastructure',
      severity: 'error',
      from: { path: '/presentation/' },
      to: { path: '/infrastructure/' },
    },
    {
      name: 'infrastructure-does-not-import-presentation',
      severity: 'error',
      from: { path: '/infrastructure/' },
      to: { path: '/presentation/' },
    },
    {
      name: 'modules-have-public-entry-points',
      severity: 'error',
      from: { path: '^apps/server/src/modules/([^/]+)/' },
      to: { path: '^apps/server/src/modules/(?!$1/)[^/]+/(?!index\\.ts$)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.test\\.ts$|/dist/)' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
  },
}
