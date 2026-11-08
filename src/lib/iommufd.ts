import type { NodePrecheck } from './precheck'

export const iommufdSetupCommands = `sudo modprobe iommufd
echo iommufd | sudo tee /etc/modules-load.d/iommufd.conf
ls -l /dev/iommu`

export function iommufdNeedsModuleSetup(report: NodePrecheck): boolean {
  return report.checks.iommufd.status !== 'yes' &&
    report.checks.iommufd.reason.includes('sudo modprobe iommufd')
}
