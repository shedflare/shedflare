function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellPath(path: string) {
  if (path.startsWith("~/")) return `"$HOME"/${shellQuote(path.slice(2))}`;
  // Keep leading dashes (including curl's special output path "-") as filenames.
  return shellQuote(path.startsWith("-") ? `./${path}` : path);
}

export function uploadCommand(options: { clientUrl: string; path: string }) {
  return `bash -o pipefail -c 'curl -fsSL "$1" | bash -s -- "$2"' -- ${shellQuote(options.clientUrl)} ${shellPath(options.path)}`;
}

export function downloadCommand(options: { downloadUrl: string; path: string }) {
  return `curl --fail --show-error --location --create-dirs --output ${shellPath(options.path)} -- ${shellQuote(options.downloadUrl)}`;
}

export function defaultDownloadPath(name: string) {
  const basename = name.split(/[\\/]/u).pop();
  return `./${!basename || basename === "." || basename === ".." ? "download" : basename}`;
}
