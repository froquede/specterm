// Turns a git remote URL into a GitHub owner/repo pair, or null if it isn't
// a github.com remote at all. Handles the three shapes `git remote get-url`
// actually prints: https, the git@ scp-like form, and explicit ssh://.
export function parseGithubRemote(
  url: string
): { owner: string; repo: string } | null {
  const clean = url.trim().replace(/\.git$/, "");

  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+)$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(clean);
    if (match) return { owner: match[1], repo: match[2] };
  }
  return null;
}
