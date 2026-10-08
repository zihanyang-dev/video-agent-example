const apps = ['server', 'agent']
const executionContracts = '^apps/agent/src/(execution/|contract\\.ts$)'

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
      name: 'execution-no-harness',
      severity: 'error',
      from: { path: executionContracts, pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/agent/src/harness/' },
    },
    {
      name: 'execution-no-sandbox-adapter',
      severity: 'error',
      from: { path: executionContracts, pathNot: '\\.test\\.ts$' },
      to: { path: '^apps/agent/src/sandbox/', pathNot: '/reference\\.ts$' },
    },
    {
      name: 'execution-no-agent-sdk',
      severity: 'error',
      from: { path: executionContracts, pathNot: '\\.test\\.ts$' },
      to: { path: '(^|/)(e2b|@earendil-works/pi-[^/]+|@openai/agents[^/]*|openai)(/|$)' },
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
    // SDK declarations commonly live in dist; retain their edges for boundary checks.
    exclude: '^(apps|packages)/.*/(dist|coverage)/',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'default'],
    },
  },
}
