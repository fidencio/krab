// Pages adds this script to archived builders so older releases can point home.
const script = document.currentScript
const releaseVersion = script?.dataset.releaseVersion

if (releaseVersion) {
  fetch(new URL('manifest.json', script.src))
    .then((response) => response.ok ? response.json() : null)
    .then((manifest) => {
      if (!manifest?.currentVersion || manifest.currentVersion === releaseVersion) return

      const notice = document.createElement('aside')
      notice.setAttribute('role', 'note')
      Object.assign(notice.style, {
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '6px 12px',
        padding: '10px 16px',
        background: '#35271f',
        borderBottom: '1px solid #ae715c',
        color: '#fff',
        font: '500 13px Arial, sans-serif',
        textAlign: 'center',
      })
      notice.append(`You are using an older KRAB release (${releaseVersion}).`)

      const currentLink = document.createElement('a')
      currentLink.href = new URL('../', script.src).href
      currentLink.textContent = 'Open the current builder'
      Object.assign(currentLink.style, { color: '#ffab90', textDecoration: 'underline' })
      notice.append(currentLink)
      document.body.prepend(notice)
    })
    .catch(() => {})
}
