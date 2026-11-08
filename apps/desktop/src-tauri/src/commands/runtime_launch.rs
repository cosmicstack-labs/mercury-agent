//! Resolve supported installations without evaluating npm's shell shims.
//! Kept std-only so the resolver/argv contract can be tested on any host.

use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Command,
};

pub(crate) struct RuntimeLaunch {
    /// The installation shown in Desktop (the executable or npm shim).
    pub(crate) detected_path: PathBuf,
    program: PathBuf,
    prefix_args: Vec<OsString>,
}

impl RuntimeLaunch {
    pub(crate) fn command(&self) -> Command {
        let mut command = quiet_command(&self.program);
        command.args(&self.prefix_args);
        command
    }
}

/// A Command that never flashes a console window on Windows.
pub(crate) fn quiet_command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

pub(crate) fn find_runtime(
    directories: &[PathBuf],
    node_directories: &[PathBuf],
    windows: bool,
) -> Option<RuntimeLaunch> {
    // Preserve the existing standalone search and its precedence.
    let binary = if windows { "mercury.exe" } else { "mercury" };
    for directory in directories {
        let path = directory.join(binary);
        if path.is_file() {
            return Some(RuntimeLaunch {
                detected_path: path.clone(),
                program: path,
                prefix_args: vec![],
            });
        }
    }
    if !windows {
        return None;
    }

    // npm's global Windows prefix contains both the shims and node_modules.
    // package.json declares mercury -> ./dist/index.js. Never parse/execute
    // .cmd/.ps1 text or reconstruct a shell command from frontend arguments.
    for directory in directories {
        let shim = ["mercury.cmd", "mercury.ps1"]
            .iter()
            .map(|name| directory.join(name))
            .find(|path| path.is_file());
        let Some(shim) = shim else { continue };
        let entry = directory
            .join("node_modules")
            .join("@cosmicstack")
            .join("mercury-agent")
            .join("dist")
            .join("index.js");
        if !entry.is_file() {
            continue;
        }
        // Match npm's preference for a node.exe adjacent to the shim, then
        // search the inherited PATH explicitly (never run node.cmd/node.ps1).
        let node = std::iter::once(directory)
            .chain(node_directories.iter())
            .map(|dir| dir.join("node.exe"))
            .find(|path| path.is_file());
        if let Some(node) = node {
            return Some(RuntimeLaunch {
                detected_path: shim,
                program: node,
                prefix_args: vec![entry.into_os_string()],
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static NEXT_ID: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "mercury-runtime-{}-{}",
                std::process::id(),
                NEXT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn file(&self, path: &str) -> PathBuf {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, b"fixture, never interpreted").unwrap();
            path
        }
        fn npm(&self, shim: &str) -> (PathBuf, PathBuf) {
            let shim = self.file(&format!("npm prefix/{shim}"));
            let entry =
                self.file("npm prefix/node_modules/@cosmicstack/mercury-agent/dist/index.js");
            (shim, entry)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn existing_standalone_wins_over_npm_and_retains_argv() {
        let f = Fixture::new();
        f.npm("mercury.cmd");
        f.file("npm prefix/node.exe");
        let binary = f.file("managed/bin/mercury.exe");
        let launch = find_runtime(
            &[f.0.join("npm prefix"), f.0.join("managed/bin")],
            &[],
            true,
        )
        .unwrap();
        assert_eq!(launch.detected_path, binary);
        let mut command = launch.command();
        command.args(["start", "--daemon"]);
        assert_eq!(command.get_program(), binary.as_os_str());
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            ["start", "--daemon"]
        );
    }

    #[test]
    fn npm_shims_resolve_to_node_and_the_package_entry_without_shell_evaluation() {
        for shim_name in ["mercury.cmd", "mercury.ps1"] {
            let f = Fixture::new();
            let (shim, entry) = f.npm(shim_name);
            let node = f.file("Program Files/nodejs/node.exe");
            let launch = find_runtime(
                &[f.0.join("npm prefix")],
                &[f.0.join("Program Files/nodejs")],
                true,
            )
            .unwrap();
            assert_eq!(launch.detected_path, shim);
            let mut command = launch.command();
            let args = [
                "setup",
                "--owner",
                "Jane Doe & %PATH% ! $(echo x)",
                "--token",
                "quote\" and trailing\\",
            ];
            command.args(args);
            assert_eq!(command.get_program(), node.as_os_str());
            let expected: Vec<OsString> = std::iter::once(entry.into_os_string())
                .chain(args.iter().map(OsString::from))
                .collect();
            assert_eq!(
                command.get_args().map(OsString::from).collect::<Vec<_>>(),
                expected
            );
        }
    }

    #[test]
    fn adjacent_node_wins_and_incomplete_installs_are_not_executed_as_shims() {
        let f = Fixture::new();
        f.file("npm prefix/mercury.cmd");
        let dirs = [f.0.join("npm prefix")];
        assert!(find_runtime(&dirs, &[], true).is_none());
        f.npm("mercury.cmd");
        f.file("elsewhere/node.cmd");
        assert!(find_runtime(&dirs, &[f.0.join("elsewhere")], true).is_none());
        f.file("elsewhere/node.exe");
        let adjacent = f.file("npm prefix/node.exe");
        let launch = find_runtime(&dirs, &[f.0.join("elsewhere")], true).unwrap();
        assert_eq!(launch.command().get_program(), adjacent.as_os_str());
    }

    #[test]
    fn posix_discovery_still_uses_the_executable_only() {
        let f = Fixture::new();
        f.npm("mercury.cmd");
        f.file("npm prefix/node.exe");
        assert!(find_runtime(&[f.0.join("npm prefix")], &[], false).is_none());
        let binary = f.file("bin/mercury");
        let launch = find_runtime(&[f.0.join("bin")], &[], false).unwrap();
        assert_eq!(launch.command().get_program(), binary.as_os_str());
    }

    #[cfg(windows)]
    #[test]
    fn native_windows_npm_launch_preserves_arguments_without_running_the_shim() {
        let f = Fixture::new();
        let (_, entry) = f.npm("mercury.cmd");
        fs::write(
            &entry,
            "process.stdout.write(process.argv.slice(2).join('\\u001f'));",
        )
        .unwrap();
        let node_dirs: Vec<PathBuf> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        let launch = find_runtime(&[f.0.join("npm prefix")], &node_dirs, true)
            .expect("the Windows desktop CI runner must provide Node.js on PATH");
        let args = [
            "start",
            "--daemon",
            "space and \"quote\"",
            "& %PATH% ! $(echo x)",
            "trailing\\",
        ];
        let output = launch.command().args(args).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            String::from_utf8(output.stdout).unwrap(),
            args.join("\u{1f}")
        );
    }
}
