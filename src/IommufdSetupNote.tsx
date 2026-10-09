import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { NodePrecheck } from './lib/precheck'
import { iommufdNeedsModuleSetup, iommufdSetupCommands } from './lib/iommufd'

export function IommufdSetupNote({ reports }: { reports: NodePrecheck[] }) {
  const [copied, setCopied] = useState(false)
  if (!reports.some(iommufdNeedsModuleSetup)) return null
  return <aside className="node-precheck" role="note">
    <h3>Enable IOMMUFD on the host</h3>
    <p>The kernel supports IOMMUFD, but the device is not ready. Run these commands on each affected node to load the module now and after every reboot, then rerun the precheck.</p>
    <div className="precheck-command">
      <pre>{iommufdSetupCommands}</pre>
      <button type="button" onClick={async () => {
        await navigator.clipboard.writeText(iommufdSetupCommands)
        setCopied(true)
      }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</button>
    </div>
  </aside>
}
