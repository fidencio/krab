import config from '../../upstream/precheck-command.json' with { type: 'json' }

export function precheckCommand(version: string): string {
  return [
    `helm install ${config.releaseName} \\`,
    `  ${config.ociReference} \\`,
    `  --version ${version} \\`,
    `  --timeout ${config.timeout} \\`,
    `  --namespace ${config.namespace} --create-namespace &&`,
    `kubectl --namespace ${config.namespace} logs \\`,
    `  job/${config.resultsJob} > ${config.outputFile}`,
  ].join('\n')
}
