//! Output firewall for website-initiated tasks.
//!
//! Real ACP adapters (codex-acp, claude-agent-acp) read files with their own
//! tools rather than the client `fs/*` methods, and some "read-only" modes
//! allow reading the whole disk. The bridge therefore inspects tool calls and
//! permission requests for paths outside the approved workspace, and scans
//! outgoing text for credential-looking material, independently of the agent.

use std::path::{Component, Path, PathBuf};

use serde_json::Value;

/// Collect candidate strings from a JSON value (bounded).
pub fn json_strings(v: &Value, out: &mut Vec<String>) {
    if out.len() > 64 {
        return;
    }
    match v {
        Value::String(s) => out.push(s.chars().take(4096).collect()),
        Value::Array(a) => a.iter().take(64).for_each(|x| json_strings(x, out)),
        Value::Object(m) => m.values().take(64).for_each(|x| json_strings(x, out)),
        _ => {}
    }
}

fn tokens(s: &str) -> impl Iterator<Item = &str> {
    s.split(|c: char| c.is_whitespace() || "'\"`=,;()|<>{}[]".contains(c))
        .map(|t| t.trim_end_matches(['.', ':']))
        .filter(|t| !t.is_empty())
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve symlinks for the longest existing prefix (e.g. macOS /var -> /private/var).
fn resolve(p: &Path) -> PathBuf {
    let p = normalize(p);
    let mut existing = p.clone();
    let mut rest: Vec<std::ffi::OsString> = vec![];
    loop {
        if let Ok(c) = std::fs::canonicalize(&existing) {
            let mut r = c;
            for part in rest.iter().rev() {
                r.push(part);
            }
            return r;
        }
        match (existing.file_name().map(|f| f.to_os_string()), existing.parent()) {
            (Some(f), Some(parent)) => {
                rest.push(f);
                existing = parent.to_path_buf();
            }
            _ => return p,
        }
    }
}

const SENSITIVE_ROOTS: &[&str] = &["/etc", "/private", "/var", "/Users", "/Volumes", "/root", "/home", "/tmp", "/mnt", "/media", "/srv", "/opt/homebrew/etc"];
const ALLOWED_EXACT: &[&str] = &["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty"];

/// Folders where agents keep their own skills (instructions/resources the
/// user installed for the agent). Reading them is part of normal agent
/// behaviour; credential files (`~/.codex/auth.json`, `~/.claude/*.json`)
/// are *not* inside these folders and stay blocked.
fn is_agent_resource(resolved: &Path, home: Option<&Path>) -> bool {
    let Some(home) = home else { return false };
    let Ok(rel) = resolved.strip_prefix(home) else { return false };
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    match parts.as_slice() {
        [a, b, _, ..] if (a == ".agents" || a == ".codex" || a == ".claude") && b == "skills" => true,
        [a, b, rest @ ..] if a == ".claude" && b == "plugins" => rest.iter().any(|p| p == "skills"),
        _ => false,
    }
}

/// Paths mentioned in `texts` that point outside `workspace` into a
/// sensitive area (home folders, system config, temp, other volumes).
pub fn paths_outside(texts: &[String], workspace: &Path) -> Vec<String> {
    paths_outside_opts(texts, workspace, false)
}

/// Like [`paths_outside`]; with `read_only_access` set, reads of the agent's
/// own skill folders are not reported.
pub fn paths_outside_opts(texts: &[String], workspace: &Path, read_only_access: bool) -> Vec<String> {
    let home = dirs::home_dir().map(|h| resolve(&h));
    let ws = resolve(workspace);
    let mut hits = vec![];
    for text in texts {
        for t in tokens(text) {
            // Windows verbatim (`\\?\C:\...`) and device (`\\.\`) prefixes.
            let t_raw = t;
            let t = t.strip_prefix(r"\\?\UNC\").map(|r| r.to_string()).map(|r| format!(r"\\{r}"));
            let t = t.as_deref().unwrap_or(t_raw);
            let t = t.strip_prefix(r"\\?\").or_else(|| t.strip_prefix(r"\\.\")).unwrap_or(t);
            let is_drive = t.len() > 2 && t.as_bytes()[0].is_ascii_alphabetic() && t.as_bytes()[1] == b':' && (t.as_bytes()[2] == b'\\' || t.as_bytes()[2] == b'/');
            let rel_escape = |t: &str| {
                t == ".." || t.starts_with("../") || t.starts_with("..\\") || t.contains("/../") || t.contains("\\..\\") || t.contains("\\../") || t.contains("/..\\")
            };
            let candidate: Option<PathBuf> = if let Some(rest) = t.strip_prefix("~/").or_else(|| t.strip_prefix("~\\")) {
                home.as_ref().map(|h| h.join(rest))
            } else if t == "~" || t == "$HOME" || t.starts_with("$HOME/") || t.starts_with("%USERPROFILE%") {
                home.as_ref().map(|h| h.join(t.trim_start_matches("$HOME").trim_start_matches("%USERPROFILE%").trim_start_matches(['/', '\\'])))
            } else if t.starts_with(r"\\") {
                // UNC share: always outside the workspace and treated as sensitive.
                if !hits.contains(&t_raw.to_string()) {
                    hits.push(t_raw.to_string());
                }
                continue;
            } else if t.starts_with('/') || is_drive {
                Some(PathBuf::from(t))
            } else if rel_escape(t) {
                Some(ws.join(t))
            } else {
                None
            };
            let Some(c) = candidate else { continue };
            if ALLOWED_EXACT.contains(&t) {
                continue;
            }
            let r = resolve(&c);
            if r.starts_with(&ws) {
                continue;
            }
            if read_only_access && is_agent_resource(&r, home.as_deref()) {
                continue;
            }
            // Relative escapes out of the workspace are always suspicious.
            let relative_escape = rel_escape(t);
            let sensitive = relative_escape || home.as_ref().map(|h| r.starts_with(h)).unwrap_or(false)
                || SENSITIVE_ROOTS.iter().any(|root| r.starts_with(root))
                || cfg!(windows);
            if sensitive && !hits.contains(&t_raw.to_string()) {
                hits.push(t_raw.to_string());
            }
        }
    }
    hits
}

/// True when `text` contains material that looks like a credential.
pub fn looks_like_secret(text: &str) -> bool {
    if text.contains("-----BEGIN") && text.contains("PRIVATE KEY") {
        return true;
    }
    let word_ok = |w: &str, prefix: &str, min: usize, charset: fn(char) -> bool| {
        w.strip_prefix(prefix).map(|r| r.len() >= min && r.chars().take(min).all(charset)).unwrap_or(false)
    };
    let alnum = |c: char| c.is_ascii_alphanumeric();
    let upper_num = |c: char| c.is_ascii_uppercase() || c.is_ascii_digit();
    let keyish = |c: char| c.is_ascii_alphanumeric() || c == '-' || c == '_';
    text.split(|c: char| c.is_whitespace() || "'\"`=,;:()[]{}<>".contains(c)).any(|w| {
        word_ok(w, "AKIA", 16, upper_num)
            || word_ok(w, "ASIA", 16, upper_num)
            || word_ok(w, "ghp_", 30, alnum)
            || word_ok(w, "gho_", 30, alnum)
            || word_ok(w, "github_pat_", 30, keyish)
            || word_ok(w, "sk-ant-", 30, keyish)
            || word_ok(w, "sk-proj-", 30, keyish)
            || word_ok(w, "xoxb-", 20, keyish)
            || word_ok(w, "xoxp-", 20, keyish)
            || word_ok(w, "AIza", 35, keyish)
            || word_ok(w, "glpat-", 20, keyish)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_outside_paths() {
        let ws = tempfile::tempdir().unwrap();
        let inside = ws.path().join("a.txt");
        std::fs::write(&inside, "x").unwrap();
        let w = ws.path();
        let t = |s: &str| paths_outside(&[s.to_string()], w);
        assert!(t(&format!("Read file '{}'", inside.display())).is_empty());
        assert!(t("cat notes.txt && ls src").is_empty());
        assert!(t("echo hi > /dev/null").is_empty());
        #[cfg(not(windows))]
        assert!(t("/usr/bin/env python3 x.py").is_empty());
        assert_eq!(t("cat ~/.ssh/id_rsa"), vec!["~/.ssh/id_rsa"]);
        assert_eq!(t("Read /etc/passwd"), vec!["/etc/passwd"]);
        assert!(!t("cat ../../secret.txt").is_empty());
        assert!(!t("ls $HOME/Documents").is_empty());
        let home = dirs::home_dir().unwrap();
        assert!(!t(&format!("{}/Library/Keychains", home.display())).is_empty());
        // macOS: /var/folders/... and /private/var/folders/... are the same place.
        let ws_str = w.to_string_lossy().replace("/private/var/", "/var/");
        assert!(t(&format!("{ws_str}/a.txt")).is_empty(), "{ws_str}");
    }

    #[cfg(windows)]
    #[test]
    fn detects_windows_paths() {
        let ws = tempfile::tempdir().unwrap();
        let w = ws.path();
        let t = |s: &str| paths_outside(&[s.to_string()], w);
        let outside = tempfile::tempdir().unwrap();
        let decoy = outside.path().canonicalize().unwrap().join("decoy.txt"); // \\?\C:\...
        assert!(!t(&format!("Read file '{}'", decoy.display())).is_empty(), "{}", decoy.display());
        assert!(!t(r"type C:\Windows\win.ini").is_empty());
        assert!(!t(r"dir \\fileserver\share").is_empty());
        assert!(!t(r"type ~\.ssh\id_rsa").is_empty());
        assert!(!t(r"type ..\..\secret.txt").is_empty());
        let inside = w.canonicalize().unwrap().join("a.txt");
        std::fs::write(&inside, "x").unwrap();
        assert!(t(&format!("Read file '{}'", inside.display())).is_empty());
    }

    #[test]
    fn agent_skill_folders_are_readable_but_credentials_are_not() {
        let ws = tempfile::tempdir().unwrap();
        let home = dirs::home_dir().unwrap();
        let skill = home.join(".agents/skills/synced/x/doc-coauthoring/SKILL.md");
        let codex_skill = home.join(".codex/skills/review/SKILL.md");
        let plugin_skill = home.join(".claude/plugins/p/skills/s/SKILL.md");
        for p in [&skill, &codex_skill, &plugin_skill] {
            let t = vec![format!("Read {}", p.display())];
            assert!(paths_outside_opts(&t, ws.path(), true).is_empty(), "{}", p.display());
            assert!(!paths_outside_opts(&t, ws.path(), false).is_empty(), "writes must still be blocked: {}", p.display());
        }
        for p in [home.join(".codex/auth.json"), home.join(".claude/.credentials.json"), home.join(".ssh/id_rsa"), home.join(".agents/secrets.txt")] {
            let t = vec![format!("Read {}", p.display())];
            assert!(!paths_outside_opts(&t, ws.path(), true).is_empty(), "{}", p.display());
        }
    }

    #[test]
    fn detects_secrets() {
        assert!(looks_like_secret("-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl"));
        assert!(looks_like_secret("key=AKIAIOSFODNN7EXAMPLE"));
        assert!(looks_like_secret("token ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(looks_like_secret("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"));
        assert!(!looks_like_secret("The secret word is PINEAPPLE-42."));
        assert!(!looks_like_secret("Use the AKIA prefix for AWS keys"));
    }

    #[test]
    fn collects_json_strings() {
        let v = serde_json::json!({"command": ["bash", "-lc", "cat ~/.aws/credentials"], "n": 1});
        let mut out = vec![];
        json_strings(&v, &mut out);
        assert!(out.iter().any(|s| s.contains(".aws")));
    }
}
