// Parses `git status --porcelain=v1` output into a flat list of changed
// files. A rename line ("R  old -> new") keeps only the new path — nothing
// here needs the old one. The status code is left exactly as git reports it
// (trimmed of its surrounding padding): "M", "A", "D", "R", "??", or a
// combined code like "MM" for a file staged and then modified again.
export interface GitStatusFile {
  path: string;
  status: string;
}

export function parseGitStatus(output: string): GitStatusFile[] {
  const files: GitStatusFile[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const code = line.slice(0, 2).trim();
    let filePath = line.slice(3);
    const arrow = filePath.indexOf(" -> ");
    if (arrow !== -1) filePath = filePath.slice(arrow + 4);
    files.push({ path: filePath, status: code });
  }
  return files;
}

export type GitStatusCategory = "new" | "modified" | "deleted";

// Buckets a raw status code into one of three display groups. A deleted file
// is deleted no matter what else is going on with it; an untracked ("??") or
// staged-add ("A"-containing, e.g. "AM") file reads as "new" to the user even
// if it's since been edited again; everything else (M, R, C, U, and any
// combination not caught above) is a plain edit.
export function classifyGitStatus(code: string): GitStatusCategory {
  if (code.includes("D")) return "deleted";
  if (code === "??" || code.includes("A")) return "new";
  return "modified";
}
