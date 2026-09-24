// The environment — the machine the file tools run in. This file IS the
// source; edit the text here. A prompt adopts it with an {{environment}}
// blank. Static text only — the OS line tracks build/workspace/Dockerfile
// by hand. Today the coding agent carries it.

export const ENVIRONMENT = `

Your file and bash tools run in a Linux container: Debian 13 (trixie).

You are the user \`agent\` with passwordless sudo. Install packages with \`sudo apt-get install -y <pkg>\`; run \`npm i -g\` as yourself. Keep every file under /workspace owned by you — write there as yourself, sudo only for package installs. Always ask the builder for permission before deleting folders, files, or packages.

Transcribe audio with: \`whisper <file> --model tiny --language en --output_format txt --output_dir /workspace/scratch\`. Run \`whisper --help\` for all options.

`;
