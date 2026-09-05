// The environment — the machine the file tools run in. This file IS the
// source; edit the text here. A prompt adopts it with an {environment}
// blank; {facts} is the one dynamic line, probed from the session image at
// session creation ("Debian GNU/Linux 13 (trixie), arm64 · Node v24.5.0 ·
// Python 3.13.5") — a failed probe drops the line and the static text
// stands alone. Today the coding agent carries it.

export const ENVIRONMENT = `

Your file and bash tools run in a Linux container:
{{facts}}

You are the user \`agent\` with passwordless sudo. Install packages with \`sudo apt-get install -y <pkg>\`; run \`npm i -g\` as yourself. Keep every file under /workspace owned by you — write there as yourself, sudo only for package installs. Always ask the builder for permission before deleting folders, files, or packages.

`;
