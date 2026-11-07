import { ArrowRight, Download, ExternalLink, Terminal } from 'lucide-react'
import { cliAssetBase, cliArchiveUrl, cliPlatforms, cliReleaseUrl, cliRepository } from './lib/cli-release'

export function CliGuide({ version, development }: { version: string; development: boolean }) {
  return <section className="cli-guide" id="cli" aria-labelledby="cli-title">
    <div className="cli-guide-heading">
      <Terminal size={17} aria-hidden="true" />
      <div>
        <h2 id="cli-title">KRAB TUI / CLI</h2>
        <p>Run node pre-checks and filter failed nodes in your terminal, using the same pinned catalog.</p>
      </div>
      <a className="cli-guide-docs" href="#docs/tui">Read the guide <ArrowRight size={13} /></a>
    </div>
    {development ? <p className="cli-release-links">Next: <a href={`${cliRepository}/actions/workflows/cli.yml`}>
      Development builds <ExternalLink size={12} /></a> (GitHub sign-in)
      {' · '}<a href={`${cliRepository}/releases/latest`}>Stable downloads</a></p> : <>
      <div className="cli-downloads" aria-label={`Download KRAB ${version}`}>
        {cliPlatforms.map(({ label, id }) => <a key={id} href={cliArchiveUrl(version, id)}>
          <Download size={15} aria-hidden="true" />{label}
        </a>)}
      </div>
      <p className="cli-release-links">Version {version} · <a href={`${cliAssetBase(version)}/SHA256SUMS`}>SHA256 checksums</a>
        {' · '}<a href={cliReleaseUrl(version)}>All release assets</a></p>
    </>}
  </section>
}
