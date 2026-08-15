"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

function sanitizePath(baseDir, targetPath) {
  if (!targetPath || typeof targetPath !== "string") return null;
  const trimmed = targetPath.trim();
  if (!trimmed || trimmed.startsWith("-") || path.isAbsolute(trimmed)) return null;
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, trimmed);
  const rel = path.relative(resolvedBase, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel;
}

function getRepoStatus(projectDir) {
  return new Promise((resolve) => {
    if (!projectDir || !fs.existsSync(projectDir)) {
      return resolve({ ok: false, error: "Invalid directory", branch: "", files: [], isClean: true });
    }

    execFile(
      "git",
      ["status", "--porcelain=v1", "-b", "-uall"],
      { cwd: projectDir, timeout: 6000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          return resolve({ ok: false, error: err.message || "Git command failed", branch: "", files: [], isClean: true });
        }

        const lines = (stdout || "").split("\n");
        let branch = "";
        const files = [];

        for (const line of lines) {
          if (!line) continue;
          if (line.startsWith("## ")) {
            let rawBranch = line.slice(3).trim();
            rawBranch = rawBranch.split("...")[0].trim();
            rawBranch = rawBranch.replace(/^(?:No commits yet on|Initial commit on)\s+/i, "").trim();
            branch = rawBranch || "HEAD";
            continue;
          }

          const code = line.slice(0, 2);
          let filePath = line.slice(3).trim();
          if (filePath.includes(" -> ")) {
            filePath = filePath.split(" -> ")[1].trim();
          }
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.slice(1, -1);
          }

          let status = "modified";
          if (code === "??" || code.includes("A")) status = "added";
          else if (code.includes("D")) status = "deleted";
          else if (code.includes("R")) status = "renamed";
          else if (code.includes("M")) status = "modified";

          files.push({
            path: filePath,
            code: code.trim(),
            status,
            staged: code[0] !== " " && code[0] !== "?",
            unstaged: code[1] !== " " && code[1] !== "?",
          });
        }

        return resolve({
          ok: true,
          branch: branch || "HEAD",
          files,
          isClean: files.length === 0,
        });
      }
    );
  });
}

function getFileDiff(projectDir, filePath) {
  return new Promise((resolve) => {
    if (!projectDir || !fs.existsSync(projectDir)) {
      return resolve({ ok: false, error: "Invalid directory", diff: "" });
    }
    const cleanPath = sanitizePath(projectDir, filePath);
    if (!cleanPath) {
      return resolve({ ok: false, error: "Invalid file path", diff: "" });
    }

    execFile(
      "git",
      ["diff", "HEAD", "--", cleanPath],
      { cwd: projectDir, timeout: 6000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let diff = (stdout || "").trim();
        if (!diff) {
          // Check if untracked file via ls-files
          execFile(
            "git",
            ["ls-files", "--error-unmatch", cleanPath],
            { cwd: projectDir, timeout: 4000 },
            (lsErr) => {
              if (lsErr) {
                // File is untracked
                const fullPath = path.join(projectDir, cleanPath);
                try {
                  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    const stat = fs.statSync(fullPath);
                    if (stat.size > 100 * 1024) {
                      diff = `[Large file: ${cleanPath} (${Math.round(stat.size / 1024)} KB)]`;
                    } else {
                      const buf = fs.readFileSync(fullPath);
                      if (buf.includes(0)) {
                        diff = `[Binary file: ${cleanPath}]`;
                      } else {
                        const content = buf.toString("utf8");
                        const lines = content.split("\n");
                        diff = `--- /dev/null\n+++ b/${cleanPath}\n@@ -0,0 +1,${lines.length} @@\n` +
                          lines.map((l) => "+" + l).join("\n");
                      }
                    }
                  }
                } catch (_) {}
              }

              return resolve({
                ok: true,
                path: cleanPath,
                diff: diff || "No differences detected.",
              });
            }
          );
          return;
        }

        return resolve({
          ok: true,
          path: cleanPath,
          diff: diff || "No differences detected.",
        });
      }
    );
  });
}

module.exports = {
  getRepoStatus,
  getFileDiff,
  sanitizePath,
};
